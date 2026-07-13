import type { App } from "firebase-admin/app";
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

let app: App | null = null;
let auth: Auth | null = null;

/** True when the verification chain must use firebase-admin (§8, phase-1 brief). */
export function isFirebaseConfigured(): boolean {
  return getConfig().FIREBASE_PROJECT_ID !== undefined;
}

/**
 * Initialize (once) and return the shared firebase-admin App. Reused by both
 * token verification (auth) and push messaging (`core/push.ts`) so a single
 * credentialed app services the whole process. Throws 500 when the FIREBASE_*
 * keys are only partially configured (an ops error, never a silent degrade).
 */
export async function getFirebaseApp(): Promise<App> {
  if (app) return app;

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

  const existing = getApps()[0];
  app =
    existing ??
    initializeApp({
      credential: cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        // Env stores commonly escape newlines in PEM keys.
        privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  return app;
}

async function getFirebaseAuth(): Promise<Auth> {
  if (auth) return auth;

  // Dynamic import keeps firebase-admin out of the boot path when unused.
  const { getAuth } = await import("firebase-admin/auth");
  auth = getAuth(await getFirebaseApp());
  return auth;
}

/** The one Auth capability this module consumes (also the test-fake surface). */
interface TokenVerifier {
  verifyIdToken(token: string): Promise<{ uid: string; phone_number?: string }>;
}

/** Test-only: inject a fake verifier so deadline semantics run without credentials. */
export function setFirebaseAuthForTests(fake: TokenVerifier | null): void {
  auth = fake as unknown as Auth | null;
}

/** Deadline on verifyIdToken (§10): Google's cert fetch has no bound of its own. */
const VERIFY_TIMEOUT_MS = 5_000;

/** Internal marker: the deadline fired — NOT an invalid token. */
class FirebaseVerifyTimeoutError extends Error {
  constructor() {
    super(`firebase verifyIdToken timed out after ${VERIFY_TIMEOUT_MS}ms`);
    this.name = "FirebaseVerifyTimeoutError";
  }
}

/** Race the (non-abortable) SDK call against the deadline; the loser dangles. */
async function verifyWithDeadline(
  firebaseAuth: TokenVerifier,
  token: string,
  timeoutMs: number,
): Promise<{ uid: string; phone_number?: string }> {
  const call = firebaseAuth.verifyIdToken(token);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FirebaseVerifyTimeoutError()), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
    // Swallow the dangling loser's eventual rejection (unhandledRejection is fatal).
    call.catch(() => {});
  }
}

/**
 * Verify a Firebase ID token → `{ uid, phone }`.
 * Throws 401 UNAUTHENTICATED on invalid/expired tokens or tokens without a
 * phone number (Phone-OTP is the only identity provider, §8.1). A verification
 * DEADLINE is not an invalid token: it throws 503 (retryable outage) so a hung
 * Google backend never mislabels valid users as unauthenticated — nor pins the
 * request open. `timeoutMs` is overridable for tests only.
 */
export async function verifyFirebaseToken(
  token: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<{ uid: string; phone: string }> {
  const firebaseAuth = await getFirebaseAuth();

  let uid: string;
  let phone: string | undefined;
  try {
    const decoded = await verifyWithDeadline(firebaseAuth, token, timeoutMs);
    uid = decoded.uid;
    phone = decoded.phone_number;
  } catch (error) {
    if (error instanceof FirebaseVerifyTimeoutError) {
      throw new AppError("INTERNAL", "Authentication service timed out — try again", 503);
    }
    throw new AppError("UNAUTHENTICATED", "Invalid or expired token", 401);
  }

  if (!phone) {
    throw new AppError("UNAUTHENTICATED", "Token has no verified phone number", 401);
  }
  return { uid, phone };
}
