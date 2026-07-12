import { FirebaseError, getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

/**
 * Firebase web SDK — lazy singleton for phone-OTP auth (§8). Config comes from
 * NEXT_PUBLIC_FIREBASE_* (inlined at build time); when unset the app runs in
 * the dev-token mode instead (see lib/auth.tsx) and nothing here initialises.
 * Client-only: consumers are "use client" modules and `getFirebaseAuth` guards
 * against server execution.
 */

const FIREBASE_CONFIG = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** True when the Firebase web app is fully configured (all four keys present). */
export const isFirebaseConfigured = Boolean(
  FIREBASE_CONFIG.apiKey &&
    FIREBASE_CONFIG.authDomain &&
    FIREBASE_CONFIG.projectId &&
    FIREBASE_CONFIG.appId,
);

let authInstance: Auth | null = null;

/** Lazily initialise the app + Auth singleton. Throws when unconfigured or on the server. */
export function getFirebaseAuth(): Auth {
  if (typeof window === "undefined") {
    throw new Error("getFirebaseAuth is client-only");
  }
  if (!isFirebaseConfigured) {
    throw new Error("Firebase is not configured (set NEXT_PUBLIC_FIREBASE_*)");
  }
  if (!authInstance) {
    const app = getApps().length > 0 ? getApp() : initializeApp(FIREBASE_CONFIG);
    authInstance = getAuth(app);
  }
  return authInstance;
}

/** Map Firebase auth error codes to copy the login screen can show as-is. */
export function firebaseAuthErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case "auth/invalid-phone-number":
      case "auth/missing-phone-number":
        return "That phone number doesn't look right — enter the 10-digit mobile number.";
      case "auth/invalid-verification-code":
      case "auth/missing-verification-code":
        return "That code is incorrect. Check the SMS and try again.";
      case "auth/code-expired":
        return "That code has expired — request a new one.";
      case "auth/too-many-requests":
        return "Too many attempts. Please wait a few minutes and try again.";
      case "auth/network-request-failed":
        return "Network error — check your connection and try again.";
    }
  }
  return "Sign-in failed. Please try again.";
}
