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
  if (!SENTRY_DSN) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? "development" : "production",
    // Errors are always captured; traces are sampled.
    tracesSampleRate: __DEV__ ? 1.0 : 0.1,
    integrations: [navigationIntegration],
    // Session Replay is opt-in per privacy review — off by default.
  });
}
