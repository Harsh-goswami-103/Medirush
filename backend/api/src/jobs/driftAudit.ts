import { AlertKind } from "@medrush/contracts";
import type PgBoss from "pg-boss";
import { getPrisma } from "../core/db";
import { wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";
import { emitOpsAlert } from "../core/realtime";
import { signOf } from "../modules/wallet/ledger";

/**
 * Nightly wallet-ledger drift audit (BLUEPRINT §9.6/§24). The ledger invariant —
 * `Wallet.balancePaise === Σ(CREDIT) − Σ(DEBIT)` over its append-only WalletTxns —
 * is enforced in-transaction on every write (credit-on-deliver, payout debit,
 * payout reverse-credit). This cron is the SAFETY NET: it recomputes every
 * wallet's balance INDEPENDENTLY from the txn ledger (not via the write helper)
 * and, on any mismatch, raises a `WALLET_DRIFT` ops alert + logs it loudly.
 *
 * Read-only and money-safe: it never mutates a balance (auto-"fixing" a drift
 * would hide the bug that caused it). A real drift is a Sev-1 to investigate.
 */

export const DRIFT_AUDIT_QUEUE = "drift-audit";
/** 02:30 IST nightly — just after the db-backup at 02:00. */
const DRIFT_AUDIT_CRON = "30 2 * * *";
const DRIFT_AUDIT_TZ = "Asia/Kolkata";

export interface WalletDrift {
  walletId: string;
  driverId: string;
  expectedPaise: number;
  actualPaise: number;
  deltaPaise: number;
}

export interface DriftAuditResult {
  wallets: number;
  drifts: WalletDrift[];
}

/**
 * Reconcile every wallet against its ledger. Returns the findings (also emitted
 * as ops alerts). Never throws for a drift — a drift is data to report, not an
 * error to crash on.
 */
export async function runDriftAudit(): Promise<DriftAuditResult> {
  const prisma = getPrisma();

  // Sum signed txn amounts per wallet in one grouped query (cheap: one store).
  const sums = await prisma.walletTxn.groupBy({
    by: ["walletId", "type"],
    _sum: { amountPaise: true },
  });
  const expectedByWallet = new Map<string, number>();
  for (const row of sums) {
    // ONE sign convention — shared with assertLedgerInvariant (wallet/ledger.ts)
    // so an ADJUSTMENT row can never false-flag drift here.
    const signed = signOf(row.type) * (row._sum.amountPaise ?? 0);
    expectedByWallet.set(row.walletId, (expectedByWallet.get(row.walletId) ?? 0) + signed);
  }

  const wallets = await prisma.wallet.findMany({
    select: { id: true, driverId: true, balancePaise: true },
  });

  const drifts: WalletDrift[] = [];
  for (const wallet of wallets) {
    const expected = expectedByWallet.get(wallet.id) ?? 0;
    if (expected !== wallet.balancePaise) {
      const drift: WalletDrift = {
        walletId: wallet.id,
        driverId: wallet.driverId,
        expectedPaise: expected,
        actualPaise: wallet.balancePaise,
        deltaPaise: wallet.balancePaise - expected,
      };
      drifts.push(drift);
      logger.error({ drift }, "WALLET_DRIFT — ledger does not reconcile");
      emitOpsAlert(
        AlertKind.WALLET_DRIFT,
        `Wallet ${wallet.id} (driver ${wallet.driverId}) drift: balance ₹${(
          wallet.balancePaise / 100
        ).toFixed(2)} vs ledger ₹${(expected / 100).toFixed(2)}`,
        wallet.id,
      );
    }
  }

  if (drifts.length === 0) {
    logger.info({ wallets: wallets.length }, "drift-audit clean — all wallets reconcile");
  }
  return { wallets: wallets.length, drifts };
}

/** Create the queue, register the worker, and schedule the nightly cron. */
export async function registerDriftAudit(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(DRIFT_AUDIT_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: DRIFT_AUDIT_QUEUE }, "createQueue skipped");
  }

  await boss.work(
    DRIFT_AUDIT_QUEUE,
    wrapWorker(DRIFT_AUDIT_QUEUE, async () => {
      await runDriftAudit();
    }),
  );

  await boss.schedule(DRIFT_AUDIT_QUEUE, DRIFT_AUDIT_CRON, {}, { tz: DRIFT_AUDIT_TZ });
  logger.info({ cron: DRIFT_AUDIT_CRON, tz: DRIFT_AUDIT_TZ }, "drift-audit scheduled");
}
