import * as Sentry from "@sentry/node";
import PgBoss from "pg-boss";
import { getConfig } from "./config";
import { logger } from "./logger";
import { flushOpsAlertWrites } from "./realtime";
import { runStuckOrderScan } from "../jobs/stuckOrders";
import { registerInvoicePdf } from "../jobs/invoicePdf";
import { registerPaymentTimeout } from "../jobs/paymentTimeout";
import { registerOfferExpiry } from "../jobs/offerExpiry";
import { registerNotificationFanout } from "../jobs/notificationFanout";
import { registerDbBackup } from "../jobs/dbBackup";
import { registerDriftAudit } from "../jobs/driftAudit";
import { registerDataPrune } from "../jobs/prune";

/**
 * pg-boss wiring: instance + lifecycle + Phase 1 cron registration.
 * The business watchdog (§15) runs every 5 minutes in Asia/Kolkata.
 */

/**
 * Wrap a pg-boss handler so a failure is LOUD before it rethrows: pg-boss v10's
 * `error` event only covers internal errors — a throwing handler is retried and
 * then silently parked in the failed state, so without this every worker failure
 * was invisible (§24). Logs + Sentry-captures (queue tag), then RETHROWS so
 * pg-boss retry/fail semantics stay exactly as before.
 */
export function wrapWorker<T>(
  name: string,
  handler: (jobs: PgBoss.Job<T>[]) => Promise<void>,
): (jobs: PgBoss.Job<T>[]) => Promise<void> {
  return async (jobs) => {
    try {
      await handler(jobs);
    } catch (error) {
      logger.error({ err: error, queue: name }, "job handler failed");
      // Raw SDK call (core/sentry's wrapper has no tag support) — a no-op until
      // `initSentry()` has bound a client, so dev/test never send anything.
      try {
        Sentry.captureException(error, { tags: { queue: name } });
      } catch (sentryError) {
        logger.warn({ err: sentryError, queue: name }, "sentry captureException failed");
      }
      throw error;
    }
  };
}

/** Queue name for the stuck-order watchdog (§15). */
export const STUCK_ORDERS_QUEUE = "stuck-orders-watchdog";
/** Every 5 minutes (§15). */
const WATCHDOG_CRON = "*/5 * * * *";
const WATCHDOG_TZ = "Asia/Kolkata";

let boss: PgBoss | null = null;
let started = false;

export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss({ connectionString: getConfig().DATABASE_URL });
    boss.on("error", (error) => logger.error({ err: error }, "pg-boss error"));
  }
  return boss;
}

/**
 * Register the pg-boss cron jobs (§15) — called from `startJobs` after
 * `boss.start()`. Creates the queue, wires the worker, then schedules the cron.
 */
export async function registerCronJobs(instance: PgBoss): Promise<void> {
  // createQueue is safe to call at every boot (idempotent upsert); guard anyway.
  try {
    await instance.createQueue(STUCK_ORDERS_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: STUCK_ORDERS_QUEUE }, "createQueue skipped");
  }

  await instance.work(
    STUCK_ORDERS_QUEUE,
    wrapWorker(STUCK_ORDERS_QUEUE, async () => {
      await runStuckOrderScan();
    }),
  );

  await instance.schedule(STUCK_ORDERS_QUEUE, WATCHDOG_CRON, {}, { tz: WATCHDOG_TZ });
  logger.info({ cron: WATCHDOG_CRON, tz: WATCHDOG_TZ }, "stuck-order watchdog scheduled");

  // Phase 2 workers: PREPAID payment-timeout auto-cancel + post-delivery invoice.
  await registerPaymentTimeout(instance);
  await registerInvoicePdf(instance);
  // Phase 5 worker: dispatch offer-expiry / wave escalation.
  await registerOfferExpiry(instance);
  // Phase 6 worker: notification push fanout.
  await registerNotificationFanout(instance);
  // Phase 7 workers: nightly encrypted DB backup + wallet-ledger drift audit
  // + daily stale-row prune (idempotency keys, read notifications).
  await registerDbBackup(instance);
  await registerDriftAudit(instance);
  await registerDataPrune(instance);
  logger.info(
    "payment-timeout + invoice-pdf + offer-expiry + notification-fanout + db-backup + drift-audit + data-prune workers registered",
  );
}

export async function startJobs(): Promise<void> {
  if (started) return;
  const instance = getBoss();
  await instance.start();
  started = true;
  logger.info("pg-boss started");
  await registerCronJobs(instance);
}

/** Graceful stop — lets in-flight jobs finish (§11 shutdown order). */
export async function stopJobs(): Promise<void> {
  if (!boss || !started) return;
  await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
  started = false;
  // Drain fire-and-forget OpsAlert persists before the caller disconnects
  // Prisma (§11) — a worker's last alert must not race the pool teardown.
  await flushOpsAlertWrites();
  logger.info("pg-boss stopped");
}

export function isJobsStarted(): boolean {
  return started;
}
