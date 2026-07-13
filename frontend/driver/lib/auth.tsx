import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { User } from "@medrush/contracts";
import { api, ApiError, setAuthToken, setAuthTokenRefreshHandler } from "./api";
import {
  currentFirebaseUser,
  currentIdToken,
  firebaseSignOut,
  isNativeFirebaseAvailable,
  startPhoneAuth,
  subscribeIdToken,
  type PhoneConfirmation,
} from "./firebase";
import { clearStoredToken, readStoredToken, writeStoredToken } from "./tokenStore";

/**
 * Driver auth.
 *
 * Production (build contains native Firebase — see lib/firebase.ts): phone-OTP
 * via @react-native-firebase/auth. `startPhoneSignIn` sends the SMS,
 * `confirmOtp` verifies it, POSTs /v1/auth/sync ONCE (fresh sign-in only —
 * the route is rate-limited 20/min and must never see token refreshes), then
 * loads /v1/me. Firebase ID tokens expire hourly; `onIdTokenChanged` rotates
 * the stored bearer, and the api client's 401 path force-refreshes once and
 * retries (setAuthTokenRefreshHandler).
 *
 * Dev/local (no native Firebase, __DEV__): dev-login mints the backend dev
 * token `dev:<firebaseUid>:<phone>` — the seeded verified driver just works.
 *
 * The bearer is persisted via lib/tokenStore (SecureStore, AsyncStorage
 * fallback) so the driver stays signed in across app restarts (a shift can
 * span hours).
 */

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  /** True when this build has native Firebase — login shows phone-OTP. */
  firebaseAvailable: boolean;
  /** Sync-or-create the account for a verified identity, then load /v1/me. */
  devLogin: (firebaseUid: string, phone: string, name?: string) => Promise<User>;
  /** Send (or resend) the OTP SMS to an E.164 phone number. */
  startPhoneSignIn: (phoneE164: string) => Promise<void>;
  /** Verify the typed OTP, sync the account (once), then load /v1/me. */
  confirmOtp: (code: string) => Promise<User>;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Mirror of `user` for the token-refresh listener (avoids stale closures). */
  const userRef = useRef<User | null>(null);
  /** Pending OTP confirmation between startPhoneSignIn and confirmOtp. */
  const confirmationRef = useRef<PhoneConfirmation | null>(null);
  /** /v1/auth/sync fires at most once per session (fresh sign-in, never refresh). */
  const syncedRef = useRef(false);

  // Probe once (cached); the module never appears/disappears within a build.
  const firebaseAvailable = isNativeFirebaseAvailable();

  const loadMe = useCallback(async (bearer: string): Promise<User> => {
    setAuthToken(bearer);
    const { data } = await api.get<User>("/v1/me", { token: bearer });
    setUser(data);
    userRef.current = data;
    setToken(bearer);
    await writeStoredToken(bearer);
    return data;
  }, []);

  /** Adopt a freshly refreshed bearer without touching the profile. */
  const rotateBearer = useCallback(async (bearer: string) => {
    setAuthToken(bearer);
    setToken(bearer);
    await writeStoredToken(bearer);
  }, []);

  const resetSession = useCallback(async () => {
    setAuthToken(null);
    setUser(null);
    userRef.current = null;
    setToken(null);
    await clearStoredToken();
  }, []);

  /**
   * Load the profile for a fresh Firebase ID token; if the backend says the
   * account was never synced (401 on /v1/me), run /v1/auth/sync once and
   * retry — covers Android auto-verified sign-ins that bypass confirmOtp.
   */
  const loadMeSyncingOnce = useCallback(
    async (bearer: string): Promise<User> => {
      try {
        return await loadMe(bearer);
      } catch (e) {
        const unsynced = e instanceof ApiError && e.status === 401;
        if (!unsynced || syncedRef.current) throw e;
        syncedRef.current = true;
        await api.post("/v1/auth/sync", {}, { token: bearer });
        return loadMe(bearer);
      }
    },
    [loadMe],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    // 401 mid-shift (hourly expiry raced a request) → force refresh, retry once.
    setAuthTokenRefreshHandler(async () => {
      const fresh = await currentIdToken(true);
      if (fresh && !cancelled) await rotateBearer(fresh);
      return fresh;
    });

    (async () => {
      if (firebaseAvailable) {
        // The native Firebase session is the source of truth. The listener
        // fires immediately with the persisted session (fresh sign-ins land
        // here too), then on every hourly token refresh.
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          unsubscribe = subscribeIdToken((fbUser) => {
            void (async () => {
              try {
                if (cancelled || !fbUser) return;
                const idToken = await fbUser.getIdToken();
                if (cancelled) return;
                if (userRef.current) {
                  // Routine refresh — rotate the bearer only, NEVER /auth/sync.
                  await rotateBearer(idToken);
                } else {
                  await loadMeSyncingOnce(idToken);
                }
              } catch {
                // Transient — the next refresh (or the 401 path) retries.
              } finally {
                settle();
              }
            })();
          });
          // Defensive: never hang startup on a listener that fails to fire.
          setTimeout(settle, 4000);
        });
        // Firebase signed out — in dev a stored `dev:` token may still be
        // valid against a local API running without Firebase configured.
        if (!cancelled && !userRef.current && __DEV__) {
          const stored = await readStoredToken();
          if (stored?.startsWith("dev:") && !cancelled) {
            await loadMe(stored).catch(() => resetSession());
          }
        }
      } else {
        const stored = await readStoredToken();
        if (stored && !cancelled) await loadMe(stored);
      }
    })()
      .catch(async () => {
        if (!cancelled) await resetSession();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      setAuthTokenRefreshHandler(null);
    };
  }, [firebaseAvailable, loadMe, loadMeSyncingOnce, resetSession, rotateBearer]);

  const devLogin = useCallback(
    async (firebaseUid: string, phone: string, name?: string) => {
      const bearer = `dev:${firebaseUid}:${phone}`;
      // Ensure the User row exists (first sign-in creates it, §8.2). Idempotent.
      await api.post("/v1/auth/sync", name ? { name } : {}, { token: bearer }).catch(() => undefined);
      return loadMe(bearer);
    },
    [loadMe],
  );

  const startPhoneSignIn = useCallback(async (phoneE164: string) => {
    confirmationRef.current = await startPhoneAuth(phoneE164);
  }, []);

  const confirmOtp = useCallback(
    async (code: string): Promise<User> => {
      const confirmation = confirmationRef.current;
      if (!confirmation) throw new Error("Request a code first");
      try {
        await confirmation.confirm(code);
      } catch (e) {
        // Android may auto-verify the SMS before the code is typed — if a
        // session already exists, proceed with it.
        if (!currentFirebaseUser()) throw e;
      }
      const idToken = await currentIdToken();
      if (!idToken) throw new Error("Sign-in did not produce a session — try again");
      confirmationRef.current = null;
      // Fresh sign-in: create/refresh the User row ONCE (rate-limited 20/min —
      // hourly token refreshes must never hit this route).
      syncedRef.current = true;
      await api.post("/v1/auth/sync", {}, { token: idToken }).catch(() => undefined);
      return loadMe(idToken);
    },
    [loadMe],
  );

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get<User>("/v1/me");
      setUser(data);
      userRef.current = data;
    } catch {
      // Keep the current user on a transient failure.
    }
  }, []);

  const logout = useCallback(async () => {
    confirmationRef.current = null;
    syncedRef.current = false;
    await firebaseSignOut(); // no-op when native Firebase is absent
    await resetSession();
  }, [resetSession]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        firebaseAvailable,
        devLogin,
        startPhoneSignIn,
        confirmOtp,
        refreshUser,
        logout,
      }}
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
