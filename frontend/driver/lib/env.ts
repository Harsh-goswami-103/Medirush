/**
 * Runtime config. The API base URL is read from `EXPO_PUBLIC_API_URL` (Expo
 * inlines any `EXPO_PUBLIC_*` var at build time) with a DEV-ONLY default.
 *
 * Dev defaults by target:
 *  - Android emulator → the host loopback is `10.0.2.2`, not `localhost`.
 *  - Physical device  → set EXPO_PUBLIC_API_URL to your PC's LAN IP, e.g.
 *    `EXPO_PUBLIC_API_URL=http://192.168.1.5:4000` (same Wi-Fi as the phone).
 *
 * Release bundles get NO fallback: a production build without a real
 * EXPO_PUBLIC_API_URL (or still carrying the eas.json placeholder) throws at
 * startup instead of silently pointing at the emulator loopback.
 */
import Constants from "expo-constants";

function resolveApiBaseUrl(): string {
  const raw = process.env.EXPO_PUBLIC_API_URL;
  // Treat the eas.json placeholder as unset so an unconfigured build fails here.
  const url = raw && !raw.includes("REPLACE-BEFORE-BUILD") ? raw : undefined;
  if (url) return url.replace(/\/+$/, "");
  if (!__DEV__) {
    throw new Error(
      "EXPO_PUBLIC_API_URL is not set (or is still the eas.json placeholder) — a release build would point at the emulator loopback. Set the real API URL in eas.json / the EAS build env.",
    );
  }
  return "http://10.0.2.2:4000";
}

export const API_BASE_URL: string = resolveApiBaseUrl();

/**
 * Semver sent as `x-app-version`; the backend 426-gates `/v1/driver/*` on it
 * (StoreConfig.minDriverAppVersion, default "1.0.0"). Derived at runtime from
 * the app.config.js `version` — one source of truth — with the launch version
 * as a defensive fallback if the manifest is ever unavailable.
 */
export const APP_VERSION: string = Constants.expoConfig?.version ?? "1.0.0";

/**
 * Sentry DSN (crash/error reporting). Read from `EXPO_PUBLIC_SENTRY_DSN` so it is
 * inlined into the bundle; unset (dev) → Sentry is a no-op (see lib/sentry.ts).
 */
export const SENTRY_DSN: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN || undefined;

/** Seeded local driver identity (matches `backend/api/prisma/seed.ts`). */
export const SEED_DRIVER = {
  firebaseUid: "seed-firebase-driver",
  phone: "+919876543211",
} as const;
