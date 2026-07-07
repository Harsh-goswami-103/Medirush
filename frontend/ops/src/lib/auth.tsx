"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Role } from "@medrush/contracts";
import { api, setAuthToken } from "./api";

/**
 * Auth context for the ops/admin console.
 *
 * Dev/local: a "dev login" mints the backend dev token `dev:<firebaseUid>:<phone>`
 * (the P1 auth path) — no Firebase project needed; the seeded INVENTORY/ADMIN
 * users just work. Production: swap `devLogin` for the Firebase phone-OTP SDK
 * (NEXT_PUBLIC_FIREBASE_* set) — same token-in, `/v1/me`-out shape.
 *
 * The token is held in module scope (for the API client) + mirrored to
 * localStorage so a refresh restores the session.
 */

const TOKEN_KEY = "medrush.ops.token";

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
  devLogin: (firebaseUid: string, phone: string) => Promise<AuthUser>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const applyToken = useCallback(async (bearer: string): Promise<AuthUser> => {
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
    applyToken(stored)
      .catch(() => {
        setAuthToken(null);
        setToken(null);
        if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => setLoading(false));
  }, [applyToken]);

  const devLogin = useCallback(
    (firebaseUid: string, phone: string) => applyToken(`dev:${firebaseUid}:${phone}`),
    [applyToken],
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

/** Ops screens: INVENTORY or ADMIN. Admin-only screens additionally check ADMIN. */
export function isOps(role: Role | undefined): boolean {
  return role === "INVENTORY" || role === "ADMIN";
}
export function isAdmin(role: Role | undefined): boolean {
  return role === "ADMIN";
}
