import { FirebaseError, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { FIREBASE_ENABLED } from "./env";

/**
 * Firebase client app for staff phone-OTP sign-in (§8.1). The web config comes
 * from NEXT_PUBLIC_FIREBASE_* (inlined at build time — see env.ts, which also
 * rejects partial configs). When Firebase is not configured this module must
 * never construct the SDK: dev builds use the dev-token flow instead, and a
 * production build renders a loud "sign-in is not configured" card.
 */

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;

/** Lazily initialised Auth instance — client-only; only call when {@link FIREBASE_ENABLED}. */
export function getFirebaseAuth(): Auth {
  if (typeof window === "undefined") {
    throw new Error("getFirebaseAuth is client-only");
  }
  if (!FIREBASE_ENABLED) {
    throw new Error("Firebase is not configured (NEXT_PUBLIC_FIREBASE_* unset)");
  }
  if (!app) app = getApps()[0] ?? initializeApp(firebaseConfig);
  return getAuth(app);
}

/** DOM id the invisible reCAPTCHA widget mounts into — the login page renders this div. */
export const RECAPTCHA_CONTAINER_ID = "medrush-recaptcha";

/** Map Firebase auth error codes (and anything else thrown by the sign-in flow) to a friendly message. */
export function friendlyAuthError(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case "auth/invalid-phone-number":
      case "auth/missing-phone-number":
        return "That phone number looks invalid — enter the 10-digit mobile number.";
      case "auth/invalid-verification-code":
      case "auth/missing-verification-code":
        return "That code is incorrect — check the SMS and try again.";
      case "auth/code-expired":
        return "That code has expired — resend a new one.";
      case "auth/too-many-requests":
        return "Too many attempts — wait a few minutes before trying again.";
      case "auth/network-request-failed":
        return "Network error — check your connection and try again.";
      default:
        return "Sign-in failed — please try again.";
    }
  }
  return err instanceof Error && err.message ? err.message : "Sign-in failed";
}
