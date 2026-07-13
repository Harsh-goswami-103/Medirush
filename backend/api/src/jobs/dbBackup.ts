import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { createGzip } from "node:zlib";
import { AlertKind } from "@medrush/contracts";
import type PgBoss from "pg-boss";
import { getConfig, type Config } from "../core/config";
import { wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";
import { emitOpsAlert } from "../core/realtime";
import { deleteBackupObject, isRealBackupR2, listBackupObjects, putBackupObject } from "../core/storage";

/**
 * Nightly encrypted database backup (BLUEPRINT §11/§24): `pg_dump | gzip | gpg
 * --symmetric` → private R2, on a pg-boss cron. Config-selected no-op — like the
 * Razorpay/R2/Sentry stubs, it runs ONLY when both a GPG passphrase and R2
 * credentials are present; unset (dev/test) → a logged skip, nothing spawned.
 *
 * Hardening (§24):
 * - failure → Sentry capture (via wrapWorker) + durable `DB_BACKUP_FAILED` ops alert;
 * - success → optional `BACKUP_HEARTBEAT_URL` GET (dead-man's-switch: the monitor
 *   pages when the ping STOPS arriving) + retention prune (`BACKUP_RETENTION_DAYS`);
 * - optional dedicated bucket/credentials (`BACKUP_R2_*`) so a compromised
 *   runtime R2 key cannot destroy the backups;
 * - the spawn pipeline has stream error handlers and a hard timeout, so an
 *   EPIPE or a hung pg_dump fails THIS job instead of the whole process.
 *
 * The restore side is a documented drill — see `docs/runbooks/restore.md`;
 * backups are only trustworthy once that drill has passed.
 */

export const DB_BACKUP_QUEUE = "db-backup";
/** 02:00 IST nightly. */
const BACKUP_CRON = "0 2 * * *";
const BACKUP_TZ = "Asia/Kolkata";

/** Hard cap on the pg_dump|gzip|gpg pipeline — a hang fails the job, not the process. */
const PIPELINE_TIMEOUT_MS = 10 * 60_000;
/** Heartbeat ping is best-effort and quick — never let it stall the job. */
const HEARTBEAT_TIMEOUT_MS = 10_000;

const DAY_MS = 86_400_000;

/**
 * Are both halves of the backup pipeline configured? Requires a GPG passphrase
 * (encryption) AND effective R2 credentials incl. a bucket (destination) —
 * `BACKUP_R2_*` overrides count, falling back to the runtime `R2_*` values.
 * Exported so the gating is unit-testable without spawning anything.
 */
export function isBackupConfigured(config: Config): boolean {
  const bucket = config.BACKUP_R2_BUCKET ?? config.R2_PRIVATE_BUCKET;
  return Boolean(config.BACKUP_GPG_PASSPHRASE && isRealBackupR2(config) && bucket);
}

export interface BackupResult {
  skipped: boolean;
  key?: string;
  bytes?: number;
  /** Keys removed by the retention prune (empty when nothing was stale). */
  pruned?: string[];
}

/**
 * Run one backup: `pg_dump` (plain SQL) → gzip → gpg AES-256 symmetric → upload
 * to `backups/<iso>.sql.gz.gpg` on the (possibly dedicated) backup bucket, then
 * ping the heartbeat and prune stale backups. Returns `{ skipped: true }` when
 * unconfigured; REJECTS on failure — the worker wrapper alerts + rethrows so
 * pg-boss retry semantics apply.
 */
export async function runDbBackup(): Promise<BackupResult> {
  const config = getConfig();
  if (!isBackupConfigured(config)) {
    logger.warn(
      "db-backup skipped — needs BACKUP_GPG_PASSPHRASE + R2 credentials (private or BACKUP_R2 bucket)",
    );
    return { skipped: true };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backups/medrush-${stamp}.sql.gz.gpg`;
  const encrypted = await pgDumpGzipGpg(config.DATABASE_URL, config.BACKUP_GPG_PASSPHRASE as string);
  await putBackupObject(key, encrypted, "application/octet-stream");
  logger.info({ key, bytes: encrypted.length }, "db-backup uploaded");

  // Success side-channels — best-effort, never fail an uploaded backup.
  await pingBackupHeartbeat();
  let pruned: string[] = [];
  try {
    pruned = await pruneOldBackups();
  } catch (error) {
    logger.warn({ err: error }, "db-backup retention prune failed (backup itself succeeded)");
  }

  return { skipped: false, key, bytes: encrypted.length, pruned };
}

/**
 * Dead-man's-switch ping (Better Stack heartbeat or similar): GET the configured
 * URL after a successful backup. The MONITOR alerts when pings stop — so a
 * failed ping here is only a warn (the alert side is the monitor's job).
 */
export async function pingBackupHeartbeat(): Promise<void> {
  const url = getConfig().BACKUP_HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(url, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    logger.info("db-backup heartbeat pinged");
  } catch (error) {
    logger.warn({ err: error }, "db-backup heartbeat ping failed (monitor will page if it persists)");
  }
}

/**
 * Retention (§24): delete backup objects older than `BACKUP_RETENTION_DAYS`
 * (default 60). Runs only after a SUCCESSFUL upload, so a broken backup
 * pipeline can never age out the last good backup. Returns the pruned keys.
 */
export async function pruneOldBackups(now: Date = new Date()): Promise<string[]> {
  const config = getConfig();
  const cutoff = new Date(now.getTime() - config.BACKUP_RETENTION_DAYS * DAY_MS);
  const objects = await listBackupObjects();
  const stale = objects.filter((obj) => obj.lastModified < cutoff);
  for (const obj of stale) {
    await deleteBackupObject(obj.key);
  }
  if (stale.length > 0) {
    logger.info(
      { pruned: stale.length, retentionDays: config.BACKUP_RETENTION_DAYS },
      "db-backup retention prune removed stale backups",
    );
  }
  return stale.map((obj) => obj.key);
}

/**
 * Stream `pg_dump` → in-process gzip → `gpg --symmetric` and buffer the
 * ciphertext. The passphrase is handed to gpg over a dedicated fd (never argv),
 * so it can't leak via the process list.
 *
 * Every stream in the pipeline routes errors into THIS promise's failure path
 * (an unhandled `gpg.stdin` EPIPE would otherwise escalate to
 * uncaughtException), and a hard timeout kills a hung pipeline.
 */
function pgDumpGzipGpg(databaseUrl: string, passphrase: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const stderr: string[] = [];
    const out: Buffer[] = [];
    let settled = false;

    // Plain SQL dump; no ownership/ACL noise (restore into any role/db).
    const dump = spawn("pg_dump", ["--no-owner", "--no-privileges", databaseUrl]);
    // fd 3 carries the passphrase → gpg reads it via --passphrase-fd 3.
    const gpg = spawn(
      "gpg",
      [
        "--batch",
        "--yes",
        "--symmetric",
        "--cipher-algo",
        "AES256",
        "--passphrase-fd",
        "3",
        "--output",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );

    const killPipeline = (): void => {
      try {
        dump.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        gpg.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      fail(new Error(`backup pipeline timed out after ${PIPELINE_TIMEOUT_MS / 60_000} min`));
    }, PIPELINE_TIMEOUT_MS);
    timer.unref();

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killPipeline();
      reject(err);
    };

    dump.on("error", (err) => fail(new Error(`pg_dump failed to start: ${err.message}`)));
    gpg.on("error", (err) => fail(new Error(`gpg failed to start: ${err.message}`)));
    dump.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    gpg.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    // Stream-level errors (e.g. EPIPE when one side dies mid-pipe) must fail the
    // job — unhandled they would crash the whole process.
    dump.stdout.on("error", (err) => fail(new Error(`pg_dump stdout failed: ${err.message}`)));
    gpg.stdin.on("error", (err) => fail(new Error(`gpg stdin failed: ${err.message}`)));

    // Feed the passphrase, then close fd 3.
    const passFd = gpg.stdio[3] as Writable;
    passFd.on("error", (err) => fail(new Error(`gpg passphrase fd failed: ${err.message}`)));
    passFd.write(`${passphrase}\n`);
    passFd.end();

    // pg_dump → gzip → gpg stdin.
    const gzip = createGzip();
    gzip.on("error", (err) => fail(new Error(`gzip failed: ${err.message}`)));
    dump.stdout.pipe(gzip).pipe(gpg.stdin);

    gpg.stdout.on("data", (chunk: Buffer) => out.push(chunk));

    dump.on("close", (code) => {
      if (code !== 0) fail(new Error(`pg_dump exited ${code}: ${stderr.join("").slice(-500)}`));
    });
    gpg.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`gpg exited ${code}: ${stderr.join("").slice(-500)}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(out));
    });
  });
}

/** Create the queue, register the worker, and schedule the nightly cron. */
export async function registerDbBackup(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(DB_BACKUP_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: DB_BACKUP_QUEUE }, "createQueue skipped");
  }

  await boss.work(
    DB_BACKUP_QUEUE,
    wrapWorker(DB_BACKUP_QUEUE, async () => {
      try {
        await runDbBackup();
      } catch (error) {
        // Durable + paging alert (§24); wrapWorker then logs, Sentry-captures
        // and rethrows so pg-boss retries the backup.
        emitOpsAlert(
          AlertKind.DB_BACKUP_FAILED,
          `Nightly DB backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }),
  );

  await boss.schedule(DB_BACKUP_QUEUE, BACKUP_CRON, {}, { tz: BACKUP_TZ });
  logger.info({ cron: BACKUP_CRON, tz: BACKUP_TZ }, "db-backup scheduled");
}
