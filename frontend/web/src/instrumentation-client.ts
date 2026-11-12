import * as Sentry from "@sentry/nextjs";

/**
 * Sentry browser init via Next's native client instrumentation (§7 Phase 7).
 * Config-selected no-op: reports only when NEXT_PUBLIC_SENTRY_DSN is set.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Pin events to the deployed commit so stack traces line up with the
    // published source maps. Only NEXT_PUBLIC_* vars are inlined into browser
    // bundles, so VERCEL_GIT_COMMIT_SHA is a build-server-only fallback here.
    release: process.env.NEXT_PUBLIC_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Session Replay is opt-in per privacy review — off by default (health data).
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
} else if (process.env.NODE_ENV === "production") {
  // Both the DSN and NODE_ENV are inlined at build time, so this branch is
  // compiled away entirely in dev — a missing DSN is normal there and a warning
  // on every page load would just train people to ignore it. In a production
  // bundle it is a real defect worth surfacing in the browser console.
  console.warn(
    "sentry disabled — NEXT_PUBLIC_SENTRY_DSN was not set when this production bundle " +
      "was built, so browser errors will not be reported. Fix: set NEXT_PUBLIC_SENTRY_DSN " +
      "at build time and redeploy.",
  );
}

/** App Router navigation instrumentation (Next 15.3+). */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
