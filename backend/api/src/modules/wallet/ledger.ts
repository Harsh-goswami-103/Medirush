import type { Prisma } from "@prisma/client";
import { TxnType } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";

/**
 * Driver wallet ledger (BLUEPRINT §9.6). Append-only WalletTxn rows;
 * `amountPaise` is ALWAYS positive — the txn type carries the sign.
 * Invariant: wallet.balancePaise === Σ(credits) − Σ(debits).
 */

/**
 * Credit a driver's wallet inside the caller's transaction.
 *
 * §9.6: the wallet row is locked with a raw `SELECT … FOR UPDATE` and
 * balanceAfter is computed UNDER that lock, so concurrent credits serialize
 * and the ledger chain never skews.
 */
export async function creditWallet(
  tx: Prisma.TransactionClient,
  driverProfileId: string,
  amountPaise: number,
  ref: { type: "ORDER"; id: string },
  note?: string,
): Promise<void> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new AppError("INTERNAL", "Wallet credits require a positive integer paise amount", 500, {
      amountPaise,
    });
  }

  // Lazily create the wallet on first credit (driver onboarding admin flows
  // land Phase 3; a row created inside this TX is exclusively ours anyway).
  const existing = await tx.wallet.findUnique({
    where: { driverId: driverProfileId },
    select: { id: true },
  });
  const walletId =
    existing?.id ??
    (await tx.wallet.create({ data: { driverId: driverProfileId }, select: { id: true } })).id;

  const rows = await tx.$queryRaw<Array<{ id: string; balancePaise: number }>>`
    SELECT "id", "balancePaise" FROM "Wallet" WHERE "id" = ${walletId} FOR UPDATE
  `;
  const locked = rows[0];
  if (!locked) throw new AppError("INTERNAL", "Wallet row missing under lock", 500);

  const balanceAfterPaise = locked.balancePaise + amountPaise;

  await tx.walletTxn.create({
    data: {
      walletId,
      type: TxnType.CREDIT,
      amountPaise,
      balanceAfterPaise,
      refType: ref.type,
      refId: ref.id,
      note: note ?? null,
    },
  });
  await tx.wallet.update({
    where: { id: walletId },
    data: { balancePaise: balanceAfterPaise },
  });
}

/**
 * THE ledger sign convention (§9.6), single source of truth: DEBIT and PAYOUT
 * subtract; CREDIT and (positive) ADJUSTMENT add. Used by both the in-TX
 * invariant check below and the nightly drift audit (jobs/driftAudit.ts) — the
 * two MUST agree or the first ADJUSTMENT row would false-flag drift.
 */
export function signOf(txnType: TxnType): 1 | -1 {
  return txnType === TxnType.DEBIT || txnType === TxnType.PAYOUT ? -1 : 1;
}

/**
 * §9.6 invariant check: wallet.balancePaise === Σ(credits) − Σ(debits).
 * DEBIT and PAYOUT subtract; CREDIT (and Phase 2 positive ADJUSTMENT) add.
 * Used by tests today and the nightly drift check later — throws on drift.
 */
export async function assertLedgerInvariant(walletId: string): Promise<void> {
  const prisma = getPrisma();
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    select: { balancePaise: true },
  });
  if (!wallet) throw new Error(`assertLedgerInvariant: wallet ${walletId} not found`);

  const txns = await prisma.walletTxn.findMany({
    where: { walletId },
    select: { type: true, amountPaise: true },
  });
  const ledgerBalance = txns.reduce((sum, txn) => sum + signOf(txn.type) * txn.amountPaise, 0);

  if (ledgerBalance !== wallet.balancePaise) {
    throw new Error(
      `Wallet ${walletId} ledger drift: balancePaise=${wallet.balancePaise} but Σ(ledger)=${ledgerBalance}`,
    );
  }
}
