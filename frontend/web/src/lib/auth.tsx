"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  RecaptchaVerifier,
  onIdTokenChanged,
  signInWithPhoneNumber,
  signOut as firebaseSignOut,
  type ConfirmationResult,
} from "firebase/auth";
import type { Role } from "@medrush/contracts";
import { api, ApiError, setAuthToken, setUnauthorizedHandler } from "./api";
import { getFirebaseAuth, isFirebaseConfigured } from "./firebase";

/**
 * Customer auth. Production: Firebase phone-OTP when NEXT_PUBLIC_FIREBASE_* is
 * set — `sendOtp` (invisible reCAPTCHA) → `confirmOtp` → POST /v1/auth/sync
 * once → GET /v1/me; Firebase persistence is the session source of truth and
 * `onIdTokenChanged` keeps the stored bearer current across the hourly ID-token
 * expiry (no re-sync on refresh). Dev/local: dev-login mints the backend dev
 * token `dev:<firebaseUid>:<phone>` (accepted only when the backend has no
 * Firebase config and is not production). Browsing is public; the token gates
 * cart, checkout, orders and account.
 *
 * NO bearer is ever written to Web Storage. The dev token lives in memory only
 * (module scope via setAuthToken + React state), so a dev-mode refresh signs
 * out — the accepted trade. Caveat: an in-memory token is still readable by
 * JavaScript running on the page; what this buys is that nothing survives a
 * page close and nothing is reachable from another tab. Moving the production
 * bearer to an httpOnly cookie is a separate, out-of-scope migration.
 */

/**
 * Key older builds mirrored the dev bearer to. Migration cleanup only — purged
 * once on mount so existing installs lose their stored token; safe to delete
 * after a release or two.
 */
const LEGACY_TOKEN_KEY = "medrush.web.token";

/** Invisible-reCAPTCHA host node — recreated per OTP attempt (a consumed widget can't be reused). */
const RECAPTCHA_CONTAINER_ID = "medrush-recaptcha";

function freshRecaptchaContainer(): HTMLElement {
  document.getElementById(RECAPTCHA_CONTAINER_ID)?.remove();
  const el = document.createElement("div");
  el.id = RECAPTCHA_CONTAINER_ID;
  document.body.appendChild(el);
  return el;
}

export interface AuthUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  role: Role;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  /** Sync-or-create the account for a verified identity, then load /v1/me. */
  devLogin: (firebaseUid: string, phone: string, name?: string) => Promise<AuthUser>;
  /** Firebase mode: send an OTP to the E.164 phone via invisible reCAPTCHA. */
  sendOtp: (phoneE164: string) => Promise<void>;
  /** Firebase mode: verify the 6-digit code, sync the account once, load /v1/me. */
  confirmOtp: (code: string) => Promise<AuthUser>;
  /** Re-fetch /v1/me into context (call after a profile PATCH). */
  refreshUser: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
  const confirmationRef = useRef<ConfirmationResult | null>(null);

  const loadMe = useCallback(async (bearer: string): Promise<AuthUser> => {
    setAuthToken(bearer);
    const { data } = await api.get<AuthUser>("/v1/me", { token: bearer });
    setUser(data);
    setToken(bearer);
    return data;
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.removeItem(LEGACY_TOKEN_KEY);

    if (isFirebaseConfigured) {
      // Firebase persistence is the session source of truth — `loading` resolves
      // on the FIRST onIdTokenChanged callback, never from a stale stored token.
      // Later callbacks are hourly refreshes: update the bearer everywhere but
      // never re-sync or re-fetch /v1/me for them.
      let first = true;
      const unsubscribe = onIdTokenChanged(getFirebaseAuth(), (fbUser) => {
        void (async () => {
          try {
            if (!fbUser) {
              setAuthToken(null);
              setToken(null);
              setUser(null);
              return;
            }
            const idToken = await fbUser.getIdToken();
            setAuthToken(idToken);
            setToken(idToken);
            if (first) {
              // Session restore on load: hydrate the profile (sync already
              // happened at the original sign-in). A transient failure keeps
              // the token; gated screens recover via refreshUser/queries.
              await loadMe(idToken).catch(() => undefined);
            }
          } finally {
            if (first) {
              first = false;
              setLoading(false);
            }
          }
        })();
      });
      return unsubscribe;
    }

    // Dev mode: the bearer is memory-only, so there is nothing to restore — a
    // reload starts signed out and the gated screens fall back to /login.
    setLoading(false);
  }, [loadMe]);

  const devLogin = useCallback(
    async (firebaseUid: string, phone: string, name?: string) => {
      const bearer = `dev:${firebaseUid}:${phone}`;
      // Ensure the User row exists (first sign-in creates it, §8.2). Idempotent.
      await api.post("/v1/auth/sync", name ? { name } : {}, { token: bearer }).catch(() => undefined);
      return loadMe(bearer);
    },
    [loadMe],
  );

  const clearRecaptcha = useCallback(() => {
    try {
      recaptchaRef.current?.clear();
    } catch {
      // Already consumed/destroyed — nothing to release.
    }
    recaptchaRef.current = null;
    if (typeof document !== "undefined") {
      document.getElementById(RECAPTCHA_CONTAINER_ID)?.remove();
    }
  }, []);

  const sendOtp = useCallback(
    async (phoneE164: string) => {
      const auth = getFirebaseAuth();
      // A consumed reCAPTCHA cannot be reused — tear down and rebuild per attempt.
      clearRecaptcha();
      const verifier = new RecaptchaVerifier(auth, freshRecaptchaContainer(), {
        size: "invisible",
      });
      recaptchaRef.current = verifier;
      try {
        confirmationRef.current = await signInWithPhoneNumber(auth, phoneE164, verifier);
      } catch (err) {
        clearRecaptcha();
        throw err;
      }
    },
    [clearRecaptcha],
  );

  const confirmOtp = useCallback(
    async (code: string): Promise<AuthUser> => {
      const confirmation = confirmationRef.current;
      if (!confirmation) throw new Error("Request a code first");
      // A wrong code throws here and the confirmation stays usable for a retry.
      const credential = await confirmation.confirm(code);
      confirmationRef.current = null;
      clearRecaptcha();
      const idToken = await credential.user.getIdToken();
      // Sync exactly ONCE per fresh sign-in (creates/updates the User row,
      // §8.2; rate-limited server-side) — token refreshes never re-sync.
      try {
        await api.post("/v1/auth/sync", {}, { token: idToken });
      } catch (err) {
        // No backend account exists for this identity yet — keeping the
        // Firebase session would leave every /v1 call 401ing with developer
        // copy ("Account not synced …"). Sign out so a retry starts clean,
        // and reject with a message the login screen can show as-is.
        void firebaseSignOut(getFirebaseAuth()).catch(() => undefined);
        const status = err instanceof ApiError ? err.status : 0;
        throw new ApiError(
          err instanceof ApiError ? err.code : "INTERNAL",
          status === 429
            ? "Too many sign-in attempts — please wait a minute and try again"
            : "We couldn't finish setting up your account — please try again",
          status,
        );
      }
      return loadMe(idToken);
    },
    [clearRecaptcha, loadMe],
  );

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get<AuthUser>("/v1/me");
      setUser(data);
    } catch {
      // Keep the current user on a transient failure.
    }
  }, []);

  const logout = useCallback(() => {
    if (isFirebaseConfigured) {
      // Fire-and-forget: local state clears synchronously below; the resulting
      // onIdTokenChanged(null) callback is a harmless repeat.
      void firebaseSignOut(getFirebaseAuth()).catch(() => undefined);
    }
    setAuthToken(null);
    setUser(null);
    setToken(null);
    // Drop every cached query (notifications, orders, addresses, cart …) so a
    // subsequent sign-in on a shared device never renders the prior user's data.
    qc.clear();
  }, [qc]);

  // A request that stays 401 after a forced token refresh means the session is
  // dead server-side (revoked/blocked) — clear it like an explicit logout.
  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{ user, token, loading, devLogin, sendOtp, confirmOtp, refreshUser, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
