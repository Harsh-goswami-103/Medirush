"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Role } from "@medrush/contracts";
import { api, setAuthToken } from "./api";

/**
 * Customer auth. Dev/local: dev-login mints the backend dev token
 * `dev:<firebaseUid>:<phone>` (P1 auth path) — the seeded customer just works and
 * a fresh uid self-serves via POST /v1/auth/sync. Production: Firebase phone-OTP
 * when NEXT_PUBLIC_FIREBASE_* is set. Browsing is public; the token gates cart,
 * checkout, orders and account.
 */

const TOKEN_KEY = "medrush.web.token";

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
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async (bearer: string): Promise<AuthUser> => {
    setAuthToken(bearer);
    const { data } = await api.get<AuthUser>("/v1/me", { token: bearer });
    setUser(data);
    setToken(bearer);
    if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, bearer);
    return data;
  }, []);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (!stored) {
      setLoading(false);
      return;
    }
    loadMe(stored)
      .catch(() => {
        setAuthToken(null);
        setToken(null);
        if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => setLoading(false));
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

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
    setToken(null);
    if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, devLogin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
