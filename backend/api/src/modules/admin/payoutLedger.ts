import type { Prisma } from "@prisma/client";
import { TxnType, WalletTxnRefType } from "@medrush/contracts";
import { AppError } from "../../core/errors";

/**
 * Payout side of the driver wallet ledger (BLUEPRINT §9.6). Mirrors
 * `wallet/ledger.ts creditWallet`: append-only WalletTxn rows, `amountPaise`
 * ALWAYS positive, the txn `type` carries the sign. The wallet row is locked
 * with a raw `SELECT … FOR UPDATE` so balanceAfter is computed under the lock
 * and concurrent money moves serialize.
 *
 * Invariant (kept green for `assertLedgerInvariant`): DEBIT/PAYOUT subtract,
 * CREDIT adds. `payoutDebit` writes a PAYOUT txn; `payoutReverseCredit` writes
 * a compensating CREDIT — a rejected-after-approval payout nets back to zero.
 */

/** Fetch + lock the driver's wallet row, returning `{ id, balancePaise }` or null. */
async function lockWallet(
  tx: Prisma.TransactionClient,
  driverProfileId: string,
): Promise<{ id: string; balancePaise: number } | null> {
  // The FOR UPDATE lock is on the Wallet row (keyed via the driver's 1:1
  // wallet), so a concurrent credit/debit blocks until this txn commits.
  const rows = await tx.$queryRaw<Array<{ id: string; balancePaise: number }>>`
    SELECT "id", "balancePaise" FROM "Wallet" WHERE "driverId" = ${driverProfileId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Debit a driver's wallet for an approved payout (funds locked, §9.6).
 *
 * Refuses a debit that would push the balance negative — including the case
 * where the driver has no wallet row at all (balance 0) — with 409 CONFLICT,
 * which rolls the caller's transaction (and the payout status flip) back.
 */
export async function payoutDebit(
  tx: Prisma.TransactionClient,
  driverProfileId: string,
  amountPaise: number,
  payoutId: string,
  note?: string,
): Promise<void> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new AppError("INTERNAL", "Payout debits require a positive integer paise amount", 500, {
      amountPaise,
    });
  }

  const locked = await lockWallet(tx, driverProfileId);
  const balancePaise = locked?.balancePaise ?? 0;
  const balanceAfterPaise = balancePaise - amountPaise;
  if (!locked || balanceAfterPaise < 0) {
    throw new AppError("CONFLICT", "Insufficient wallet balance to approve this payout", 409, {
      balancePaise,
      amountPaise,
    });
  }

  await tx.walletTxn.create({
    data: {
      walletId: locked.id,
      type: TxnType.PAYOUT,
      amountPaise,
      balanceAfterPaise,
      refType: WalletTxnRefType.PAYOUT,
      refId: payoutId,
      note: note ?? null,
    },
  });
  await tx.wallet.update({
    where: { id: locked.id },
    data: { balancePaise: balanceAfterPaise },
  });
}

/**
 * Compensating CREDIT reversing an earlier `payoutDebit` (a payout rejected
 * after it was approved, §9.6). The wallet row exists because approval debited
 * it; a missing row here is an invariant breach, not a user error.
 */
export async function payoutReverseCredit(
  tx: Prisma.TransactionClient,
  driverProfileId: string,
  amountPaise: number,
  payoutId: string,
  note?: string,
): Promise<void> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new AppError("INTERNAL", "Payout reversals require a positive integer paise amount", 500, {
      amountPaise,
    });
  }

  const locked = await lockWallet(tx, driverProfileId);
  if (!locked) throw new AppError("INTERNAL", "Wallet row missing for payout reversal", 500);

  const balanceAfterPaise = locked.balancePaise + amountPaise;
  await tx.walletTxn.create({
    data: {
      walletId: locked.id,
      type: TxnType.CREDIT,
      amountPaise,
      balanceAfterPaise,
      refType: WalletTxnRefType.PAYOUT,
      refId: payoutId,
      note: note ?? null,
    },
  });
  await tx.wallet.update({
    where: { id: locked.id },
    data: { balancePaise: balanceAfterPaise },
  });
}
