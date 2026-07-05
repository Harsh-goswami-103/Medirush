import PgBoss from "pg-boss";
import { getConfig } from "./config";
import { logger } from "./logger";

/**
 * pg-boss wiring (Phase 0: instance + lifecycle only).
 * Job handlers (paymentTimeout, offerExpiry, noDriverAlert, nightlyBackup,
 * expiryScan, …) register here in Phase 1+.
 */

let boss: PgBoss | null = null;
let started = false;

export function getBoss(): PgBoss {
  if (!boss) {
    boss = new PgBoss({ connectionString: getConfig().DATABASE_URL });
    boss.on("error", (error) => logger.error({ err: error }, "pg-boss error"));
  }
  return boss;
}

export async function startJobs(): Promise<void> {
  if (started) return;
  await getBoss().start();
  started = true;
  logger.info("pg-boss started");
  // TODO(Phase 1+): boss.work(...) handler registration goes here.
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
