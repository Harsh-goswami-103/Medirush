import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { createGzip } from "node:zlib";
import type PgBoss from "pg-boss";
import { getConfig, type Config } from "../core/config";
import { logger } from "../core/logger";
import { putPrivateObject } from "../core/storage";

/**
 * Nightly encrypted database backup (BLUEPRINT §11/§24): `pg_dump | gzip | gpg
 * --symmetric` → private R2, on a pg-boss cron. Config-selected no-op — like the
 * Razorpay/R2/Sentry stubs, it runs ONLY when both a GPG passphrase and R2
 * credentials are present; unset (dev/test) → a logged skip, nothing spawned.
 *
 * Best-effort: a failed backup is logged (and, in prod, should page ops via the
 * alert channel — §24 Observability) but never crashes the worker. The restore
 * side is a documented drill — see `docs/runbooks/restore.md`; backups are only
 * trustworthy once that drill has passed.
 */

export const DB_BACKUP_QUEUE = "db-backup";
/** 02:00 IST nightly. */
const BACKUP_CRON = "0 2 * * *";
const BACKUP_TZ = "Asia/Kolkata";

/**
 * Are both halves of the backup pipeline configured? Requires a GPG passphrase
 * (encryption) AND full R2 credentials incl. the private bucket (destination).
 * Exported so the gating is unit-testable without spawning anything.
 */
export function isBackupConfigured(config: Config): boolean {
  return Boolean(
    config.BACKUP_GPG_PASSPHRASE &&
      config.R2_ACCOUNT_ID &&
      config.R2_ACCESS_KEY_ID &&
      config.R2_SECRET_ACCESS_KEY &&
      config.R2_PRIVATE_BUCKET,
  );
}

export interface BackupResult {
  skipped: boolean;
  key?: string;
  bytes?: number;
}

/**
 * Run one backup: `pg_dump` (plain SQL) → gzip → gpg AES-256 symmetric → upload
 * to `backups/<iso>.sql.gz.gpg` on the private bucket. Returns `{ skipped:true }`
 * when unconfigured. Never throws — errors are logged and surfaced as a rejected
 * BackupResult only to the worker wrapper, which logs them.
 */
export async function runDbBackup(): Promise<BackupResult> {
  const config = getConfig();
  if (!isBackupConfigured(config)) {
    logger.warn(
      "db-backup skipped — needs BACKUP_GPG_PASSPHRASE + R2 credentials (private bucket)",
    );
    return { skipped: true };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backups/medrush-${stamp}.sql.gz.gpg`;
  const encrypted = await pgDumpGzipGpg(config.DATABASE_URL, config.BACKUP_GPG_PASSPHRASE as string);
  await putPrivateObject(key, encrypted, "application/octet-stream");
  logger.info({ key, bytes: encrypted.length }, "db-backup uploaded");
  return { skipped: false, key, bytes: encrypted.length };
}

/**
 * Stream `pg_dump` → in-process gzip → `gpg --symmetric` and buffer the
 * ciphertext. The passphrase is handed to gpg over a dedicated fd (never argv),
 * so it can't leak via the process list.
 */
function pgDumpGzipGpg(databaseUrl: string, passphrase: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const stderr: string[] = [];
    const out: Buffer[] = [];
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

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

    dump.on("error", (err) => fail(new Error(`pg_dump failed to start: ${err.message}`)));
    gpg.on("error", (err) => fail(new Error(`gpg failed to start: ${err.message}`)));
    dump.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    gpg.stderr.on("data", (chunk) => stderr.push(String(chunk)));

    // Feed the passphrase, then close fd 3.
    const passFd = gpg.stdio[3] as Writable;
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

  await boss.work(DB_BACKUP_QUEUE, async () => {
    try {
      await runDbBackup();
    } catch (error) {
      // Best-effort: a backup failure must not crash the worker (§24 alerting
      // is a follow-up). Log loudly so it's caught by the log-based alert.
      logger.error({ err: error }, "db-backup FAILED");
    }
  });

  await boss.schedule(DB_BACKUP_QUEUE, BACKUP_CRON, {}, { tz: BACKUP_TZ });
  logger.info({ cron: BACKUP_CRON, tz: BACKUP_TZ }, "db-backup scheduled");
}
