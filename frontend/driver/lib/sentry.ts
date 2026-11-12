import * as Sentry from "@sentry/react-native";
import { SENTRY_DSN } from "./env";

/**
 * Driver-app crash/error reporting (§7 Phase 7). Config-selected no-op — same
 * posture as the backend `core/sentry.ts` + web/ops instrumentation: init runs
 * ONLY when EXPO_PUBLIC_SENTRY_DSN is set (dev = off, nothing reported). The
 * native SDK still autolinks; without a DSN it simply never sends.
 *
 * Usage (app/_layout.tsx): call initSentry() once at module load, register the
 * navigation container in an effect, and `export default Sentry.wrap(RootLayout)`.
 */

/** Expo Router navigation instrumentation (React Navigation under the hood). */
export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

/** Initialise Sentry — no-op unless a DSN is configured. */
export function initSentry(): void {
  if (!SENTRY_DSN) {
    // The driver app is the surface where silence hurts most: a release build
    // reports nothing and there is no server log to notice it from. `__DEV__` is
    // compile-time, so this warning is stripped from dev bundles entirely and
    // only ships in a release build that was assembled without the DSN.
    if (!__DEV__) {
      console.warn(
        "[sentry] disabled — EXPO_PUBLIC_SENTRY_DSN was not set at build time, so " +
          "no crash from this release build will be reported. Rebuild with the DSN set.",
      );
    }
    return;
  }
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? "development" : "production",
    // Errors are always captured; traces are sampled.
    tracesSampleRate: __DEV__ ? 1.0 : 0.1,
    integrations: [navigationIntegration],
    // Session Replay is opt-in per privacy review — off by default.
  });
}

/**
 * Live-tracking drop telemetry (lib/locationSink.ts). Both helpers are
 * DSN-gated no-ops, and the caller owns the throttling — the breadcrumb marks
 * the start of an outage, the message is the aggregated report for it.
 */

/** Marks the start of a GPS outage; rides along with the next captured event. */
export function addLocationDropBreadcrumb(data: {
  senderRegistered: boolean;
  droppedTotal: number;
  lastForwardAt: number | null;
}): void {
  if (!SENTRY_DSN) return;
  Sentry.addBreadcrumb({
    category: "gps",
    level: "warning",
    message: "Live location drop started",
    data,
  });
}

/** Aggregated report for an ongoing GPS outage — never one event per ping. */
export function reportDroppedLocationPings(data: {
  dropped: number;
  droppedTotal: number;
  senderRegistered: boolean;
  lastForwardAt: number | null;
}): void {
  if (!SENTRY_DSN) return;
  Sentry.captureMessage("Driver GPS pings dropped — no live location sender", {
    level: "warning",
    tags: { area: "live-tracking" },
    extra: { ...data },
  });
}
