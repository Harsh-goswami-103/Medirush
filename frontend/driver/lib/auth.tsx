import { createContext, useCallback, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { User } from "@medrush/contracts";
import { api, setAuthToken } from "./api";

/**
 * Driver auth. Dev/local: dev-login mints the backend dev token
 * `dev:<firebaseUid>:<phone>` (P1 auth path) — the seeded verified driver just
 * works. Production: Firebase phone-OTP when the native Firebase config is wired
 * (follow-up; the token exchange point is the only thing that changes here).
 *
 * The token is persisted in AsyncStorage so the driver stays signed in across
 * app restarts (a shift can span hours).
 */

const TOKEN_KEY = "medrush.driver.token";

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  /** Sync-or-create the account for a verified identity, then load /v1/me. */
  devLogin: (firebaseUid: string, phone: string, name?: string) => Promise<User>;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async (bearer: string): Promise<User> => {
    setAuthToken(bearer);
    const { data } = await api.get<User>("/v1/me", { token: bearer });
    setUser(data);
    setToken(bearer);
    await AsyncStorage.setItem(TOKEN_KEY, bearer);
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(TOKEN_KEY);
        if (stored && !cancelled) await loadMe(stored);
      } catch {
        setAuthToken(null);
        setToken(null);
        await AsyncStorage.removeItem(TOKEN_KEY).catch(() => undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get<User>("/v1/me");
      setUser(data);
    } catch {
      // Keep the current user on a transient failure.
    }
  }, []);

  const logout = useCallback(async () => {
    setAuthToken(null);
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem(TOKEN_KEY).catch(() => undefined);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, devLogin, refreshUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
