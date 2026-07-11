/**
 * Runtime config. The API base URL is read from `EXPO_PUBLIC_API_URL` (Expo
 * inlines any `EXPO_PUBLIC_*` var at build time) with a sensible dev default.
 *
 * Dev defaults by target:
 *  - Android emulator → the host loopback is `10.0.2.2`, not `localhost`.
 *  - Physical device  → set EXPO_PUBLIC_API_URL to your PC's LAN IP, e.g.
 *    `EXPO_PUBLIC_API_URL=http://192.168.1.5:4000` (same Wi-Fi as the phone).
 */
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "") ?? "http://10.0.2.2:4000";

/** Semver sent as `x-app-version`; the backend gates `/v1/driver/*` on it. */
export const APP_VERSION = "1.0.0";

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
