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
  loading: boolean;
  devLogin: (firebaseUid: string, phone: string) => Promise<AuthUser>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const applyToken = useCallback(async (token: string): Promise<AuthUser> => {
    setAuthToken(token);
    const { data } = await api.get<AuthUser>("/v1/me", { token });
    setUser(data);
    if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, token);
    return data;
  }, []);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (!token) {
      setLoading(false);
      return;
    }
    applyToken(token)
      .catch(() => {
        setAuthToken(null);
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
    if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, devLogin, logout }}>
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
