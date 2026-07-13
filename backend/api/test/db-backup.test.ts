import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * DB-backup gating + hardening (§11/§24). The pg_dump|gzip|gpg→R2 pipeline
 * itself is operator-verified via the restore drill (docs/runbooks/restore.md) —
 * here we pin: the config gate (dev/CI never spawns pg_dump), the dedicated
 * BACKUP_R2_* bucket/credential fallback, the retention prune over the
 * `backups/` prefix (stub storage), the heartbeat ping, and the prefix guard
 * on the backup delete helper.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.BACKUP_GPG_PASSPHRASE;
process.env.BACKUP_HEARTBEAT_URL = "https://heartbeat.example.invalid/ping";

const { utimes } = await import("node:fs/promises");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { loadConfig } = await import("../src/core/config");
const { deleteBackupObject, listBackupObjects, putBackupObject } = await import(
  "../src/core/storage"
);
const { isBackupConfigured, pingBackupHeartbeat, pruneOldBackups, runDbBackup } = await import(
  "../src/jobs/dbBackup"
);

const base = { DATABASE_URL: "postgresql://postgres@localhost:5433/medrush_test" };
const r2 = {
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "k",
  R2_SECRET_ACCESS_KEY: "s",
  R2_PRIVATE_BUCKET: "b",
};

describe("db-backup gating", () => {
  it("is unconfigured without a GPG passphrase or R2 credentials", () => {
    expect(isBackupConfigured(loadConfig(base))).toBe(false);
    // passphrase alone is not enough — the R2 destination is required too
    expect(isBackupConfigured(loadConfig({ ...base, BACKUP_GPG_PASSPHRASE: "p" }))).toBe(false);
    // R2 alone is not enough — encryption is required
    expect(isBackupConfigured(loadConfig({ ...base, ...r2 }))).toBe(false);
  });

  it("is configured only when the GPG passphrase AND all R2 credentials are present", () => {
    const cfg = loadConfig({
      ...base,
      BACKUP_GPG_PASSPHRASE: "secret",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "sec",
      R2_PRIVATE_BUCKET: "medrush-private",
    });
    expect(isBackupConfigured(cfg)).toBe(true);
  });

  it("accepts a dedicated BACKUP_R2_* destination without the runtime R2 creds", () => {
    const cfg = loadConfig({
      ...base,
      BACKUP_GPG_PASSPHRASE: "secret",
      BACKUP_R2_ACCOUNT_ID: "backup-acct",
      BACKUP_R2_ACCESS_KEY_ID: "backup-key",
      BACKUP_R2_SECRET_ACCESS_KEY: "backup-sec",
      BACKUP_R2_BUCKET: "medrush-backups",
    });
    expect(isBackupConfigured(cfg)).toBe(true);

    // A dedicated bucket alone rides on the runtime creds (partial override).
    const mixed = loadConfig({
      ...base,
      ...r2,
      BACKUP_GPG_PASSPHRASE: "secret",
      BACKUP_R2_BUCKET: "medrush-backups",
    });
    expect(isBackupConfigured(mixed)).toBe(true);

    // Partial dedicated creds without a fallback are NOT configured.
    const partial = loadConfig({
      ...base,
      BACKUP_GPG_PASSPHRASE: "secret",
      BACKUP_R2_ACCOUNT_ID: "backup-acct",
      BACKUP_R2_BUCKET: "medrush-backups",
    });
    expect(isBackupConfigured(partial)).toBe(false);
  });

  it("runDbBackup is a logged no-op when unconfigured (nothing spawned)", async () => {
    const result = await runDbBackup();
    expect(result.skipped).toBe(true);
    expect(result.key).toBeUndefined();
  });
});

describe("backup retention prune (stub storage)", () => {
  const STUB_BACKUPS_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".storage",
    "private",
    "backups",
  );
  const suffix = Date.now();
  const oldKey = `backups/medrush-prunetest-old-${suffix}.sql.gz.gpg`;
  const freshKey = `backups/medrush-prunetest-fresh-${suffix}.sql.gz.gpg`;

  afterEach(async () => {
    for (const key of [oldKey, freshKey]) {
      await deleteBackupObject(key).catch(() => undefined);
    }
  });

  it("deletes only backups older than BACKUP_RETENTION_DAYS (default 60)", async () => {
    await putBackupObject(oldKey, Buffer.from("old"), "application/octet-stream");
    await putBackupObject(freshKey, Buffer.from("fresh"), "application/octet-stream");
    // Age the old one past the 60-day default retention.
    const past = new Date(Date.now() - 61 * 86_400_000);
    await utimes(join(STUB_BACKUPS_DIR, oldKey.slice("backups/".length)), past, past);

    const pruned = await pruneOldBackups();
    expect(pruned).toContain(oldKey);
    expect(pruned).not.toContain(freshKey);

    const keys = (await listBackupObjects()).map((obj) => obj.key);
    expect(keys).not.toContain(oldKey);
    expect(keys).toContain(freshKey);
  });

  it("refuses to touch keys outside the backups/ prefix", async () => {
    await expect(deleteBackupObject("private/rx/secret.pdf")).rejects.toThrow(/backups\//);
    await expect(
      putBackupObject("backups/../private/evil", Buffer.from("x"), "text/plain"),
    ).rejects.toThrow(/backups\//);
  });
});

describe("backup heartbeat (dead-man's-switch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the configured URL after a successful backup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await pingBackupHeartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://heartbeat.example.invalid/ping",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("a failed ping is a warn, never a throw (the monitor pages, not us)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(pingBackupHeartbeat()).resolves.toBeUndefined();
  });
});
