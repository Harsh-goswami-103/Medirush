import { z } from "zod";

/**
 * Environment configuration (docs/BLUEPRINT.md §26).
 *
 * - `DATABASE_URL` is always required.
 * - Third-party / deploy keys are optional in development & test, required in
 *   production — boot fails loudly with a readable list of missing keys.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),

  // Firebase Admin (Phase 1)
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().min(1).optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),

  // Razorpay (Phase 2)
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Cloudflare R2 (Phase 2)
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_PUBLIC_BUCKET: z.string().min(1).optional(),
  R2_PRIVATE_BUCKET: z.string().min(1).optional(),
  R2_PUBLIC_CDN_URL: z.url().optional(),

  // Maps / observability (optional in dev/test, required in production — §26)
  OLA_MAPS_API_KEY: z.string().min(1).optional(),
  SENTRY_DSN: z.string().min(1).optional(),

  // Internal
  REVALIDATE_SECRET: z.string().min(1).optional(),
  BACKUP_GPG_PASSPHRASE: z.string().min(1).optional(),

  // Backup hardening (Phase 7 §24) — all optional, config-stub posture:
  // - BACKUP_HEARTBEAT_URL: dead-man's-switch GET after a successful backup.
  // - BACKUP_RETENTION_DAYS: prune backup objects older than this (default 60).
  // - BACKUP_R2_*: optional dedicated backup bucket/credentials; each falls back
  //   to the runtime R2 value when unset (a compromised runtime key must not be
  //   able to destroy every backup — use a separate key with write-only access).
  BACKUP_HEARTBEAT_URL: z.url().optional(),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
  BACKUP_R2_BUCKET: z.string().min(1).optional(),
  BACKUP_R2_ACCOUNT_ID: z.string().min(1).optional(),
  BACKUP_R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  BACKUP_R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  // Perimeter / proxy trust (Phase 7 §10 hardening):
  // - TRUST_PROXY_HOPS: how many proxy hops to trust when deriving request.ip
  //   from X-Forwarded-For (fastify `trustProxy`). Unset → 1 in production
  //   (Railway's edge proxy) and fully-trusting `true` in dev/test, preserving
  //   inject()/localhost behaviour. Trusting the whole chain in production
  //   would let a client spoof its own XFF prefix past the rate limiter.
  // - RATE_LIMIT_TRUST_CF_HEADER: once the Cloudflare perimeter exists (CF
  //   strips/sets CF-Connecting-IP), prefer that header as the rate-limit key.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(16).optional(),
  RATE_LIMIT_TRUST_CF_HEADER: z.stringbool().default(false),

  // CORS origins (defaulted for local dev; required in production)
  WEB_ORIGIN: z.url().optional(),
  OPS_ORIGIN: z.url().optional(),

  // Optional integrations
  RESEND_API_KEY: z.string().min(1).optional(),

  // Uptime monitoring (§24 observability) — both optional, config-stub posture:
  // - UPTIME_CHECK_URL: what the 5-minute self-check GETs. Unset → the LOCAL
  //   readiness probe (`http://127.0.0.1:<PORT>/readyz`), which catches a wedged
  //   process/DB from inside; point it at the public URL to cover the edge too.
  // - UPTIME_ALERT_WEBHOOK_URL: Slack-compatible incoming webhook the job POSTs
  //   `{ text }` to on failure. Unset → the job is not scheduled at all, so
  //   dev/CI stay silent (same posture as the backup gate).
  UPTIME_CHECK_URL: z.url().optional(),
  UPTIME_ALERT_WEBHOOK_URL: z.url().optional(),
});

/** Keys that MUST be present when NODE_ENV === "production". */
const PROD_REQUIRED_KEYS = [
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
  // REVALIDATE_SECRET is accepted but optional — nothing consumes it yet, so
  // operators are not forced to mint a secret that gates nothing.
  "BACKUP_GPG_PASSPHRASE",
  "WEB_ORIGIN",
  "OPS_ORIGIN",
] as const;

type ParsedEnv = z.infer<typeof envSchema>;

export type Config = Omit<ParsedEnv, "WEB_ORIGIN" | "OPS_ORIGIN"> & {
  WEB_ORIGIN: string;
  OPS_ORIGIN: string;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
};

/**
 * Parse + validate an environment map. Pure — safe to call from tests with a
 * synthetic env. Throws a single readable Error listing every problem.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (common in .env templates) as absent.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`,
    );
    throw new Error(`Environment validation failed:\n${lines.join("\n")}`);
  }
  const parsed = result.data;

  if (parsed.NODE_ENV === "production") {
    const missing = PROD_REQUIRED_KEYS.filter((key) => parsed[key] === undefined);
    if (missing.length > 0) {
      throw new Error(
        `Environment validation failed: missing keys required in production:\n${missing
          .map((key) => `  - ${key}`)
          .join("\n")}`,
      );
    }
  }

  return {
    ...parsed,
    WEB_ORIGIN: parsed.WEB_ORIGIN ?? "http://localhost:3000",
    OPS_ORIGIN: parsed.OPS_ORIGIN ?? "http://localhost:3001",
    isProduction: parsed.NODE_ENV === "production",
    isDevelopment: parsed.NODE_ENV === "development",
    isTest: parsed.NODE_ENV === "test",
  };
}

/** FIREBASE_* keys `plugins/auth.ts` needs before it stops accepting dev tokens. */
const FIREBASE_KEYS = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
] as const;

/**
 * Boot gate (defence-in-depth over the runtime guard in `plugins/auth.ts`):
 * refuse to start a production process that could accept a dev token. No-op
 * outside production. Called from `server.ts` before the app is built.
 */
export function assertNoDevTokenBypass(config: Config): void {
  if (!config.isProduction) return;

  const missing = FIREBASE_KEYS.filter((key) => config[key] === undefined);
  if (missing.length === 0) return;

  throw new Error(
    "FATAL: dev-token authentication bypass is reachable in this production process. " +
      `Missing environment variable(s): ${missing.join(", ")}. ` +
      "With FIREBASE_PROJECT_ID unset, verifyToken() in backend/api/src/plugins/auth.ts " +
      "falls back to the `dev:<firebaseUid>:<phone>` bearer token and will accept ANY " +
      "attacker-chosen identity. Fix: set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and " +
      "FIREBASE_PRIVATE_KEY (same Firebase project as the web/ops/driver apps) on this " +
      "service, then restart. Do NOT work around this by changing NODE_ENV.",
  );
}

let cached: Config | null = null;

/** Lazily-parsed process env singleton used by the app. */
export function getConfig(): Config {
  if (cached === null) {
    // Local dev convenience: tsx/node do not auto-load .env (Prisma CLI does).
    // Only attempted when the shell didn't already provide DATABASE_URL, so
    // deploy environments (Railway) and tests keep full precedence.
    if (process.env.DATABASE_URL === undefined) {
      try {
        process.loadEnvFile();
      } catch {
        // no .env file — validation below reports what's missing
      }
    }
    cached = loadConfig();
  }
  return cached;
}

/** Test-only: drop the cached env parse (proxy-trust suites vary the env). */
export function resetConfigForTests(): void {
  cached = null;
}
