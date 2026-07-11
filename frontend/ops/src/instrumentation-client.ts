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
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Session Replay is opt-in per privacy review — off by default.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

/** App Router navigation instrumentation (Next 15.3+). */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
