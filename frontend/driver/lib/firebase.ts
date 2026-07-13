import type {
  ConfirmationResult,
  User as FirebaseUser,
} from "@react-native-firebase/auth";

/**
 * Lazy access to NATIVE Firebase Auth (@react-native-firebase/auth).
 *
 * The RNFirebase native module only exists in builds produced AFTER the
 * operator provisions `google-services.json` (app.config.js gates the config
 * plugins on that file). The currently-installed dev client predates it, so a
 * top-level `import` would crash at bundle evaluation ("Native module
 * RNFBAppModule not found"). Every touch point therefore goes through a lazy
 * `require` inside try/catch, cached after the first probe.
 *
 * Behavior matrix (consumed by lib/auth.tsx + app/login.tsx):
 *  - module available            → phone-OTP sign-in + hourly ID-token refresh
 *  - module absent + __DEV__     → dev-token login (local workflow unchanged)
 *  - module absent + production  → loud "sign-in is not configured" screen
 */

type FirebaseAuthModule = typeof import("@react-native-firebase/auth");

/* Metro provides CommonJS `require` at runtime; declare it for tsc (no
 * @types/node in this app). */
declare const require: (id: string) => unknown;

/** Cached probe — `undefined` = not probed yet, `null` = unavailable. */
let cachedModule: FirebaseAuthModule | null | undefined;

/** The Firebase Auth module, or null when this build has no native Firebase. */
export function getFirebaseAuthModule(): FirebaseAuthModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    const mod = require("@react-native-firebase/auth") as FirebaseAuthModule;
    // Throws when the native module is missing (build predates RNFirebase) or
    // no [DEFAULT] app exists (built without google-services.json).
    mod.getAuth();
    cachedModule = mod;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function isNativeFirebaseAvailable(): boolean {
  return getFirebaseAuthModule() !== null;
}

function requireFirebase(): FirebaseAuthModule {
  const mod = getFirebaseAuthModule();
  if (!mod) throw new Error("Native Firebase is not available in this build");
  return mod;
}

export type PhoneConfirmation = ConfirmationResult;
export type { FirebaseUser };

/** Send the OTP SMS; the returned confirmation verifies the typed code. */
export function startPhoneAuth(phoneE164: string): Promise<ConfirmationResult> {
  const mod = requireFirebase();
  return mod.signInWithPhoneNumber(mod.getAuth(), phoneE164);
}

/**
 * Subscribe to sign-in/sign-out/token-refresh events. Fires immediately with
 * the current (natively persisted) session, then on every hourly refresh —
 * lib/auth.tsx uses it to keep the stored bearer current.
 */
export function subscribeIdToken(listener: (user: FirebaseUser | null) => void): () => void {
  const mod = requireFirebase();
  return mod.onIdTokenChanged(mod.getAuth(), listener);
}

/** The natively persisted Firebase session, if any (null when unavailable). */
export function currentFirebaseUser(): FirebaseUser | null {
  const mod = getFirebaseAuthModule();
  return mod ? mod.getAuth().currentUser : null;
}

/**
 * The current Firebase ID token (`forceRefresh` bypasses the SDK cache — used
 * by the api client's 401-retry path). Null when signed out or unavailable.
 */
export async function currentIdToken(forceRefresh = false): Promise<string | null> {
  const user = currentFirebaseUser();
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

/** Sign out of Firebase — a no-op when native Firebase is absent. */
export async function firebaseSignOut(): Promise<void> {
  const mod = getFirebaseAuthModule();
  if (!mod) return;
  try {
    const auth = mod.getAuth();
    if (auth.currentUser) await mod.signOut(auth);
  } catch {
    // Local session teardown (lib/auth.tsx) proceeds regardless.
  }
}

/** Friendly copy for the Firebase phone-auth error codes users actually hit. */
export function phoneAuthErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  switch (typeof code === "string" ? code : "") {
    case "auth/invalid-phone-number":
    case "auth/missing-phone-number":
      return "That phone number doesn't look right — enter your 10-digit mobile number.";
    case "auth/invalid-verification-code":
      return "That code isn't right — check the SMS and try again.";
    case "auth/code-expired":
    case "auth/session-expired":
      return "That code has expired — tap Resend to get a new one.";
    case "auth/too-many-requests":
      return "Too many attempts — wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "Network error — check your connection and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact support.";
    default:
      return err instanceof Error && err.message ? err.message : "Sign-in failed — try again.";
  }
}
