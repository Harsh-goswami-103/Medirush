import PgBoss from "pg-boss";
import { getConfig } from "./config";
import { logger } from "./logger";
import { runStuckOrderScan } from "../jobs/stuckOrders";

/**
 * pg-boss wiring: instance + lifecycle + Phase 1 cron registration.
 * The business watchdog (§15) runs every 5 minutes in Asia/Kolkata.
 */

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

  await instance.work(STUCK_ORDERS_QUEUE, async () => {
    await runStuckOrderScan();
  });

  await instance.schedule(STUCK_ORDERS_QUEUE, WATCHDOG_CRON, {}, { tz: WATCHDOG_TZ });
  logger.info({ cron: WATCHDOG_CRON, tz: WATCHDOG_TZ }, "stuck-order watchdog scheduled");
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
  logger.info("pg-boss stopped");
}

export function isJobsStarted(): boolean {
  return started;
}
