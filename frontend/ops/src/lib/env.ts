/**
 * Backend base URL. NEXT_PUBLIC_* is inlined at build time, so an unset var in
 * a production build would silently ship "http://localhost:4000" — fail the
 * build/boot loudly instead. Dev keeps the localhost fallback.
 */
function resolveApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set — a production build of @medrush/ops would point at localhost. Set it in the build environment.",
    );
  }
  return "http://localhost:4000";
}

export const API_BASE_URL = resolveApiBaseUrl();

/**
 * Whether Firebase phone-OTP sign-in is configured. The client SDK needs all
 * four values, so a partial set is always a misconfiguration — fail the build
 * loudly instead of letting `signInWithPhoneNumber` die with an opaque error.
 * When false: dev builds fall back to the dev-token login; production renders
 * an explicit "sign-in is not configured" card (never a silent dev fallback).
 */
function resolveFirebaseEnabled(): boolean {
  const values = [
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  ];
  const present = values.filter(Boolean).length;
  if (present > 0 && present < values.length) {
    throw new Error(
      "Partial NEXT_PUBLIC_FIREBASE_* config — set all of API_KEY, AUTH_DOMAIN, PROJECT_ID and APP_ID (or none to disable Firebase sign-in).",
    );
  }
  return present === values.length;
}

export const FIREBASE_ENABLED = resolveFirebaseEnabled();
