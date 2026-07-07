import type { Auth } from "firebase-admin/auth";
import { getConfig } from "./config";
import { AppError } from "./errors";

/**
 * Firebase Admin — lazy app init (§8.1).
 *
 * The SDK is only imported and initialized when the FIREBASE_* keys are
 * configured (production always is — config.ts fails boot otherwise). In
 * dev/test without credentials, plugins/auth.ts falls back to dev tokens and
 * this module is never touched.
 */

let auth: Auth | null = null;

/** True when the verification chain must use firebase-admin (§8, phase-1 brief). */
export function isFirebaseConfigured(): boolean {
  return getConfig().FIREBASE_PROJECT_ID !== undefined;
}

async function getFirebaseAuth(): Promise<Auth> {
  if (auth) return auth;

  const config = getConfig();
  if (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
    // Partial configuration is an ops error — surface it, never silently
    // degrade to unauthenticated or dev-token behaviour.
    throw new AppError(
      "INTERNAL",
      "Firebase is misconfigured: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must all be set",
      500,
    );
  }

  // Dynamic import keeps firebase-admin out of the boot path when unused.
  const { cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");

  const existing = getApps()[0];
  const app =
    existing ??
    initializeApp({
      credential: cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        // Env stores commonly escape newlines in PEM keys.
        privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });

  auth = getAuth(app);
  return auth;
}

/**
 * Verify a Firebase ID token → `{ uid, phone }`.
 * Throws 401 UNAUTHENTICATED on invalid/expired tokens or tokens without a
 * phone number (Phone-OTP is the only identity provider, §8.1).
 */
export async function verifyFirebaseToken(token: string): Promise<{ uid: string; phone: string }> {
  const firebaseAuth = await getFirebaseAuth();

  let uid: string;
  let phone: string | undefined;
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    uid = decoded.uid;
    phone = decoded.phone_number;
  } catch {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired token", 401);
  }

  if (!phone) {
    throw new AppError("UNAUTHENTICATED", "Token has no verified phone number", 401);
  }
  return { uid, phone };
}
