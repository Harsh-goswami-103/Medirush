import { describe, expect, it } from "vitest";
import { assertNoDevTokenBypass, loadConfig, type Config } from "../src/core/config";

/**
 * Boot gate for the dev-token bypass (§8.1). `plugins/auth.ts` `verifyToken()`
 * already refuses dev tokens at runtime; this asserts the loud boot-time
 * defence-in-depth check, and that it stays a no-op in dev/test.
 */

const DB_URL = "postgresql://medrush:medrush@localhost:5432/medrush";

const PROD_ENV: Record<string, string> = {
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
  BACKUP_GPG_PASSPHRASE: "gpg-pass",
  WEB_ORIGIN: "https://medrush.in",
  OPS_ORIGIN: "https://ops.medrush.in",
};

/** A production config whose FIREBASE_* keys were somehow dropped after parse. */
function prodConfigWithout(...keys: Array<keyof Config>): Config {
  const config = loadConfig(PROD_ENV);
  const stripped = { ...config };
  for (const key of keys) stripped[key] = undefined as never;
  return stripped;
}

describe("assertNoDevTokenBypass", () => {
  it("throws in production when FIREBASE_PROJECT_ID is absent", () => {
    expect(() => assertNoDevTokenBypass(prodConfigWithout("FIREBASE_PROJECT_ID"))).toThrowError(
      /FIREBASE_PROJECT_ID/,
    );
  });

  it("names the accepting code path and the fix in the message", () => {
    let message = "";
    try {
      assertNoDevTokenBypass(
        prodConfigWithout("FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("FATAL");
    expect(message).toContain("src/plugins/auth.ts");
    expect(message).toContain("verifyToken()");
    expect(message).toContain("dev:<firebaseUid>:<phone>");
    for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) {
      expect(message).toContain(key);
    }
  });

  it("throws when the FIREBASE_* set is only partially configured", () => {
    expect(() => assertNoDevTokenBypass(prodConfigWithout("FIREBASE_PRIVATE_KEY"))).toThrowError(
      /FIREBASE_PRIVATE_KEY/,
    );
  });

  it("passes in production when every FIREBASE_* key is set", () => {
    expect(() => assertNoDevTokenBypass(loadConfig(PROD_ENV))).not.toThrow();
  });

  it("is a no-op in development and test without Firebase (dev tokens stay usable)", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const config = loadConfig({ DATABASE_URL: DB_URL, NODE_ENV });
      expect(config.FIREBASE_PROJECT_ID).toBeUndefined();
      expect(() => assertNoDevTokenBypass(config)).not.toThrow();
    }
  });
});
