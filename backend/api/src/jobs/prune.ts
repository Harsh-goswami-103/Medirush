import type PgBoss from "pg-boss";
import { getPrisma } from "../core/db";
import { wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";

/**
 * Daily stale-row prune (Phase 7 §24) — keeps the unbounded-growth tables
 * bounded without touching anything audit- or money-relevant:
 *
 * - IdempotencyKey  > 7 days  (client POST /orders dedupe — clients never retry
 *   a key for days; the §9 replay window is minutes)
 * - Notification    READ + > 90 days (unread rows are kept — the user hasn't
 *   seen them yet, however old)
 * - OpsAlert        ACKNOWLEDGED + > 30 days (unacked rows are kept — they are
 *   still open in the ops inbox AND arm the watchdog's re-alert dedupe)
 *
 * PaymentEvent is deliberately NOT pruned: it is the Razorpay webhook
 * idempotency gate and the money audit trail. OrderEvent/AuditLog/StockAdjustment
 * are append-only audit registers — never pruned.
 */

export const DATA_PRUNE_QUEUE = "data-prune";
/** 03:30 IST nightly — a quiet hour clear of the 02:00 backup and 02:30 drift audit. */
const DATA_PRUNE_CRON = "30 3 * * *";
const DATA_PRUNE_TZ = "Asia/Kolkata";

/** Retention windows (days). */
const IDEMPOTENCY_KEY_RETENTION_DAYS = 7;
const READ_NOTIFICATION_RETENTION_DAYS = 90;
const ACKED_OPS_ALERT_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
const daysAgo = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);

export interface DataPruneResult {
  idempotencyKeys: number;
  notifications: number;
  opsAlerts: number;
}

/** Run one prune pass. `now` is injectable so the cutoffs are deterministic under test. */
export async function runDataPrune(now: Date = new Date()): Promise<DataPruneResult> {
  const prisma = getPrisma();

  const idempotencyKeys = await prisma.idempotencyKey.deleteMany({
    where: { createdAt: { lt: daysAgo(now, IDEMPOTENCY_KEY_RETENTION_DAYS) } },
  });
  const notifications = await prisma.notification.deleteMany({
    where: {
      readAt: { not: null },
      createdAt: { lt: daysAgo(now, READ_NOTIFICATION_RETENTION_DAYS) },
    },
  });
  const opsAlerts = await prisma.opsAlert.deleteMany({
    where: {
      acknowledgedAt: { not: null },
      createdAt: { lt: daysAgo(now, ACKED_OPS_ALERT_RETENTION_DAYS) },
    },
  });

  const result: DataPruneResult = {
    idempotencyKeys: idempotencyKeys.count,
    notifications: notifications.count,
    opsAlerts: opsAlerts.count,
  };
  logger.info(result, "data-prune completed");
  return result;
}

/** Create the queue, register the worker, and schedule the daily cron. */
export async function registerDataPrune(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(DATA_PRUNE_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: DATA_PRUNE_QUEUE }, "createQueue skipped");
  }

  await boss.work(
    DATA_PRUNE_QUEUE,
    wrapWorker(DATA_PRUNE_QUEUE, async () => {
      await runDataPrune();
    }),
  );

  await boss.schedule(DATA_PRUNE_QUEUE, DATA_PRUNE_CRON, {}, { tz: DATA_PRUNE_TZ });
  logger.info({ cron: DATA_PRUNE_CRON, tz: DATA_PRUNE_TZ }, "data-prune scheduled");
}
