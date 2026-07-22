import * as Sentry from "@sentry/nextjs";

/**
 * Sentry server/edge init via Next's native instrumentation hook (§7 Phase 7).
 * Config-selected no-op (mirrors the backend `core/sentry.ts` + Razorpay/R2
 * stub posture): reports only when NEXT_PUBLIC_SENTRY_DSN is set at deploy.
 */
export function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    // Silent in dev (no DSN there is normal); loud in production, where an
    // unreported deploy is indistinguishable from a healthy one. No pino here,
    // so console.warn — it lands in the platform's server logs.
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "sentry disabled — NEXT_PUBLIC_SENTRY_DSN is not set in this production build, " +
          "so server/edge errors will not be reported. Fix: set NEXT_PUBLIC_SENTRY_DSN " +
          "at build time and redeploy.",
      );
    }
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Ties events to a deploy: explicit NEXT_PUBLIC_COMMIT_SHA wins, Vercel's
    // build-time sha is the fallback; undefined (no release tag) otherwise.
    release: process.env.NEXT_PUBLIC_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });
}

/** Report errors thrown while rendering nested Server Components (Next 15 hook). */
export const onRequestError = Sentry.captureRequestError;
