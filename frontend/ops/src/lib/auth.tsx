"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  onIdTokenChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  type ConfirmationResult,
} from "firebase/auth";
import type { Role } from "@medrush/contracts";
import { api, ApiError, setAuthToken, setAuthTokenRefresher } from "./api";
import { FIREBASE_ENABLED } from "./env";
import { getFirebaseAuth, RECAPTCHA_CONTAINER_ID } from "./firebase";

/**
 * Auth context for the ops/admin console — staff only (INVENTORY/ADMIN).
 *
 * Production (NEXT_PUBLIC_FIREBASE_* set): Firebase phone-OTP. `sendOtp` →
 * `confirmOtp` verifies the code, POSTs /v1/auth/sync ONCE (never on token
 * refresh — it is rate-limited), loads /v1/me and gates on the staff roles;
 * any other role is signed straight back out. `onIdTokenChanged` keeps the
 * bearer current across the SDK's hourly refresh, and api.ts replays one 401
 * with a force-refreshed token as a fallback.
 *
 * Dev/local (Firebase unconfigured, dev build): `devLogin` mints the backend
 * dev token `dev:<firebaseUid>:<phone>` — the seeded staff users just work.
 * The dev token (only) is mirrored to localStorage so a refresh restores it;
 * Firebase sessions restore from the SDK's own persistence instead.
 *
 * Production with Firebase unconfigured has NO sign-in path — the login page
 * renders an explicit "not configured" card rather than a dev fallback.
 */

const TOKEN_KEY = "medrush.ops.token";

/**
 * Local const on purpose: NODE_ENV is inlined by `next build`, so the whole
 * dev-token branch folds to `false` and is stripped from production bundles.
 */
const DEV_LOGIN_ENABLED = process.env.NODE_ENV !== "production" && !FIREBASE_ENABLED;

const NOT_OPS_MESSAGE = "This account is not authorized for the ops console.";

/**
 * True when /v1/me (or the role gate) rejected the ACCOUNT rather than the
 * attempt: wrong role, or an ApiError the backend would repeat for this bearer
 * (401 invalid/unsynced, 403 blocked). Everything else — network (status 0),
 * 5xx during a deploy, 429 from the global rate limiter — is transient: tearing
 * the Firebase session down for those would permanently sign staff out over an
 * API blip, since every page load routes through the restore path.
 */
function isDefinitiveAuthRejection(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 401 || err.status === 403;
  return err instanceof Error && err.message === NOT_OPS_MESSAGE;
}

export interface AuthUser {
  id: string;
  phone: string;
  name: string | null;
  role: Role;
}

interface AuthState {
  user: AuthUser | null;
  /** Current bearer token (for the socket handshake); null when signed out. */
  token: string | null;
  loading: boolean;
  /** Send a 6-digit OTP to an E.164 phone (+91…) — Firebase builds only. */
  sendOtp: (phoneE164: string) => Promise<void>;
  /** Verify the OTP, sync the account once, then load /v1/me (staff roles only). */
  confirmOtp: (code: string) => Promise<AuthUser>;
  /** Dev-token sign-in — available only in dev builds without Firebase. */
  devLogin: (firebaseUid: string, phone: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const confirmationRef = useRef<ConfirmationResult | null>(null);
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
  /** uid whose /v1/me profile is already in state — stops hourly refreshes re-fetching it. */
  const loadedUidRef = useRef<string | null>(null);
  /** True while confirmOtp() drives sync + /v1/me itself — the listener must not race it. */
  const signInFlowRef = useRef(false);

  const clearSession = useCallback(() => {
    loadedUidRef.current = null;
    setAuthToken(null);
    setUser(null);
    setToken(null);
    if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
  }, []);

  const logout = useCallback(async () => {
    clearSession();
    if (FIREBASE_ENABLED) {
      // Also revoke the SDK session, or onIdTokenChanged would restore it on reload.
      await signOut(getFirebaseAuth()).catch(() => undefined);
    }
  }, [clearSession]);

  /**
   * Load /v1/me for a bearer and gate on INVENTORY/ADMIN.
   *
   * Full teardown (Firebase signOut included) is reserved for DEFINITIVE
   * rejections — wrong role, blocked, unsynced (401/403) — so a non-staff
   * account never lingers half signed-in. Transient failures (network, 5xx,
   * 429) rethrow WITHOUT touching the session: the user stays null (the
   * console layout falls back to /login), and because `loadedUidRef` is only
   * set on success, the next token refresh or page reload retries the profile
   * load and restores the session once the API is reachable again.
   */
  const applyToken = useCallback(
    async (bearer: string, uid: string | null): Promise<AuthUser> => {
      try {
        const { data } = await api.get<AuthUser>("/v1/me", { token: bearer });
        if (!isOps(data.role)) throw new Error(NOT_OPS_MESSAGE);
        setAuthToken(bearer);
        setToken(bearer);
        setUser(data);
        loadedUidRef.current = uid;
        // Only dev tokens are persisted here; Firebase restores from the SDK.
        if (!FIREBASE_ENABLED && typeof window !== "undefined") {
          localStorage.setItem(TOKEN_KEY, bearer);
        }
        return data;
      } catch (err) {
        if (isDefinitiveAuthRejection(err)) await logout();
        throw err;
      }
    },
    [logout],
  );

  useEffect(() => {
    if (!FIREBASE_ENABLED) {
      // Dev builds restore the persisted dev token. Production without Firebase
      // has no sign-in path — the login page renders the "not configured" card.
      const stored =
        DEV_LOGIN_ENABLED && typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
      if (!stored) {
        setLoading(false);
        return;
      }
      // A REJECTED dev token (401/403 — e.g. reseeded DB) is cleared by
      // applyToken's logout; a transient failure (API not up yet) keeps it in
      // localStorage so the next reload retries.
      applyToken(stored, null)
        .catch(() => undefined)
        .finally(() => setLoading(false));
      return;
    }

    const auth = getFirebaseAuth();

    // 401 fallback for api.ts: force-refresh the ID token once and replay.
    setAuthTokenRefresher(async () => {
      const current = auth.currentUser;
      if (!current) return null;
      const fresh = await current.getIdToken(true);
      setAuthToken(fresh);
      setToken(fresh);
      return fresh;
    });

    // Fires on sign-in, sign-out and every hourly token refresh: keep the
    // stored bearer current; fetch the profile only for a *new* session (never
    // on refresh), and never while confirmOtp() is mid-flight — it owns
    // sync + /v1/me + the role gate for fresh sign-ins.
    const unsubscribe = onIdTokenChanged(auth, (fbUser) => {
      void (async () => {
        if (!fbUser) {
          clearSession();
          setLoading(false);
          return;
        }
        try {
          const idToken = await fbUser.getIdToken();
          setAuthToken(idToken);
          setToken(idToken);
          if (!signInFlowRef.current && loadedUidRef.current !== fbUser.uid) {
            // Restored session: profile + role gate only — no /v1/auth/sync.
            await applyToken(idToken, fbUser.uid);
          }
        } catch {
          // Definitive rejections already tore the session down inside
          // applyToken (incl. Firebase signOut); transient failures keep the
          // Firebase session so a refresh/reload retries. Either way the user
          // stays null and `loading` resolves below.
        } finally {
          setLoading(false);
        }
      })();
    });

    return () => {
      unsubscribe();
      setAuthTokenRefresher(null);
    };
  }, [applyToken, clearSession]);

  const clearRecaptcha = useCallback(() => {
    if (recaptchaRef.current) {
      try {
        recaptchaRef.current.clear();
      } catch {
        // Container already unmounted — nothing to clear.
      }
      recaptchaRef.current = null;
    }
  }, []);

  const sendOtp = useCallback(
    async (phoneE164: string): Promise<void> => {
      const auth = getFirebaseAuth();
      // A consumed invisible reCAPTCHA can't be reused — fresh verifier per send.
      clearRecaptcha();
      const verifier = new RecaptchaVerifier(auth, RECAPTCHA_CONTAINER_ID, { size: "invisible" });
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
      if (!confirmation) throw new Error("Request a new code first.");
      signInFlowRef.current = true;
      try {
        const credential = await confirmation.confirm(code);
        try {
          const idToken = await credential.user.getIdToken();
          // Fresh sign-in: sync ONCE (upserts the User row — rate-limited, so
          // never on refresh/restore), then profile + INVENTORY/ADMIN gate.
          await api.post("/v1/auth/sync", {}, { token: idToken });
          const me = await applyToken(idToken, credential.user.uid);
          confirmationRef.current = null;
          clearRecaptcha();
          return me;
        } catch (err) {
          // Wrong role / blocked / sync failure — never leave the Firebase
          // session behind. logout() is idempotent with applyToken's teardown.
          await logout();
          throw err;
        }
      } finally {
        signInFlowRef.current = false;
      }
    },
    [applyToken, clearRecaptcha, logout],
  );

  const devLogin = useCallback(
    async (firebaseUid: string, phone: string): Promise<AuthUser> => {
      if (!DEV_LOGIN_ENABLED) throw new Error("Dev sign-in is not available in this build.");
      return applyToken(`dev:${firebaseUid}:${phone}`, null);
    },
    [applyToken],
  );

  return (
    <AuthContext.Provider value={{ user, token, loading, sendOtp, confirmOtp, devLogin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

/** Ops screens: INVENTORY or ADMIN. Admin-only screens additionally check ADMIN. */
export function isOps(role: Role | undefined): boolean {
  return role === "INVENTORY" || role === "ADMIN";
}
export function isAdmin(role: Role | undefined): boolean {
  return role === "ADMIN";
}
