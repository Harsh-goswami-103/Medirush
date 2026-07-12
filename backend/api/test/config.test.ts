import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";

const DB_URL = "postgresql://medrush:medrush@localhost:5432/medrush";

describe("loadConfig", () => {
  it("dev env with only DATABASE_URL passes and applies defaults", () => {
    const config = loadConfig({ DATABASE_URL: DB_URL, NODE_ENV: "development" });
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(4000);
    expect(config.WEB_ORIGIN).toBe("http://localhost:3000");
    expect(config.OPS_ORIGIN).toBe("http://localhost:3001");
    expect(config.isDevelopment).toBe(true);
    expect(config.isProduction).toBe(false);
  });

  it("defaults NODE_ENV to development when unset", () => {
    const config = loadConfig({ DATABASE_URL: DB_URL });
    expect(config.NODE_ENV).toBe("development");
  });

  it("treats empty strings as absent (env-file style)", () => {
    const config = loadConfig({ DATABASE_URL: DB_URL, PORT: "", FIREBASE_PROJECT_ID: "" });
    expect(config.PORT).toBe(4000);
    expect(config.FIREBASE_PROJECT_ID).toBeUndefined();
  });

  it("missing DATABASE_URL throws a readable error naming the key", () => {
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrowError(/DATABASE_URL/);
  });

  it("production env with missing keys throws listing every missing key", () => {
    let message = "";
    try {
      loadConfig({ DATABASE_URL: DB_URL, NODE_ENV: "production" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("production");
    for (const key of [
      "FIREBASE_PROJECT_ID",
      "FIREBASE_CLIENT_EMAIL",
      "FIREBASE_PRIVATE_KEY",
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_PUBLIC_BUCKET",
      "R2_PRIVATE_BUCKET",
      "R2_PUBLIC_CDN_URL",
      "OLA_MAPS_API_KEY",
      "SENTRY_DSN",
      "BACKUP_GPG_PASSPHRASE",
      "WEB_ORIGIN",
      "OPS_ORIGIN",
    ]) {
      expect(message).toContain(key);
    }
    // Nothing consumes REVALIDATE_SECRET — it must NOT be forced on operators.
    expect(message).not.toContain("REVALIDATE_SECRET");
  });

  it("backup hardening keys are optional with a 60-day retention default", () => {
    const config = loadConfig({ DATABASE_URL: DB_URL });
    expect(config.BACKUP_HEARTBEAT_URL).toBeUndefined();
    expect(config.BACKUP_RETENTION_DAYS).toBe(60);
    expect(config.BACKUP_R2_BUCKET).toBeUndefined();

    const tuned = loadConfig({
      DATABASE_URL: DB_URL,
      BACKUP_HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/abc",
      BACKUP_RETENTION_DAYS: "14",
      BACKUP_R2_BUCKET: "medrush-backups",
      BACKUP_R2_ACCOUNT_ID: "backup-acct",
      BACKUP_R2_ACCESS_KEY_ID: "backup-key",
      BACKUP_R2_SECRET_ACCESS_KEY: "backup-secret",
    });
    expect(tuned.BACKUP_HEARTBEAT_URL).toBe("https://uptime.betterstack.com/api/v1/heartbeat/abc");
    expect(tuned.BACKUP_RETENTION_DAYS).toBe(14);
    expect(tuned.BACKUP_R2_BUCKET).toBe("medrush-backups");
  });

  it("production env with all required keys passes", () => {
    const config = loadConfig({
      DATABASE_URL: DB_URL,
      NODE_ENV: "production",
      FIREBASE_PROJECT_ID: "medrush",
      FIREBASE_CLIENT_EMAIL: "svc@medrush.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      RAZORPAY_KEY_ID: "rzp_live_x",
      RAZORPAY_KEY_SECRET: "secret",
      RAZORPAY_WEBHOOK_SECRET: "whsecret",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_PUBLIC_BUCKET: "medrush-public",
      R2_PRIVATE_BUCKET: "medrush-private",
      R2_PUBLIC_CDN_URL: "https://cdn.medrush.in",
      OLA_MAPS_API_KEY: "ola-key",
      SENTRY_DSN: "https://x@sentry.io/1",
      REVALIDATE_SECRET: "reval",
      BACKUP_GPG_PASSPHRASE: "gpg-pass",
      WEB_ORIGIN: "https://medrush.in",
      OPS_ORIGIN: "https://ops.medrush.in",
    });
    expect(config.isProduction).toBe(true);
    expect(config.WEB_ORIGIN).toBe("https://medrush.in");
  });
});
