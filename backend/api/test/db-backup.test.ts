import { describe, expect, it } from "vitest";

/**
 * DB-backup gating (§11/§24). The pg_dump|gzip|gpg→R2 pipeline itself is
 * operator-verified via the restore drill (docs/runbooks/restore.md) — here we
 * pin the config gate: the job must be a no-op unless BOTH a GPG passphrase and
 * full R2 credentials are present, so dev/CI never spawns pg_dump or writes junk.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.BACKUP_GPG_PASSPHRASE;

const { loadConfig } = await import("../src/core/config");
const { isBackupConfigured, runDbBackup } = await import("../src/jobs/dbBackup");

const base = { DATABASE_URL: "postgresql://postgres@localhost:5433/medrush_test" };

describe("db-backup gating", () => {
  it("is unconfigured without a GPG passphrase or R2 credentials", () => {
    expect(isBackupConfigured(loadConfig(base))).toBe(false);
    // passphrase alone is not enough — the R2 destination is required too
    expect(isBackupConfigured(loadConfig({ ...base, BACKUP_GPG_PASSPHRASE: "p" }))).toBe(false);
    // R2 alone is not enough — encryption is required
    expect(
      isBackupConfigured(
        loadConfig({
          ...base,
          R2_ACCOUNT_ID: "a",
          R2_ACCESS_KEY_ID: "k",
          R2_SECRET_ACCESS_KEY: "s",
          R2_PRIVATE_BUCKET: "b",
        }),
      ),
    ).toBe(false);
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

  it("runDbBackup is a logged no-op when unconfigured (nothing spawned)", async () => {
    const result = await runDbBackup();
    expect(result.skipped).toBe(true);
    expect(result.key).toBeUndefined();
  });
});
