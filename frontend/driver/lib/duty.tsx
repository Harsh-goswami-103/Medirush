import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ApiError } from "./api";
import { useAuth } from "./auth";
import { useSetOnline } from "./queries";

/**
 * Duty (online/offline) status. The API has no GET for it (PATCH-only, §7.2), so
 * the app owns the state: persisted locally and re-asserted to the server on
 * launch so both agree even after an app restart mid-shift. `isVerified` comes
 * back on every toggle — an unverified driver cannot go online.
 */

interface DutyState {
  online: boolean;
  /** null until we've heard from the server at least once. */
  verified: boolean | null;
  busy: boolean;
  error: string | null;
  setOnline: (next: boolean) => Promise<void>;
}

const DutyContext = createContext<DutyState | null>(null);
const ONLINE_KEY = "medrush.driver.online";

export function DutyProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const setOnlineMutation = useSetOnline();
  const [online, setOnlineState] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resynced = useRef(false);
  const hadToken = useRef(false);

  const setOnline = useCallback(
    async (next: boolean) => {
      setError(null);
      try {
        const status = await setOnlineMutation.mutateAsync(next);
        setOnlineState(status.isOnline);
        setVerified(status.isVerified);
        await AsyncStorage.setItem(ONLINE_KEY, status.isOnline ? "1" : "0").catch(() => undefined);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Couldn't update status");
        throw e;
      }
    },
    [setOnlineMutation],
  );

  // On first authenticated mount, if we were online last time, tell the server
  // again (idempotent) so a restart doesn't silently drop the driver off duty.
  useEffect(() => {
    if (!token || resynced.current) return;
    resynced.current = true;
    (async () => {
      const persisted = (await AsyncStorage.getItem(ONLINE_KEY).catch(() => null)) === "1";
      if (persisted) await setOnline(true).catch(() => undefined);
    })();
  }, [token, setOnline]);

  // Sign-out: drop the cached "online" so the next sign-in on this device can't
  // resurrect a stale shift via the resync above. Only on a token that went
  // away — at cold start `token` is null until auth resolves, and clearing then
  // would erase the flag a restart mid-shift depends on.
  useEffect(() => {
    if (token) {
      hadToken.current = true;
      return;
    }
    if (!hadToken.current) return;
    hadToken.current = false;
    resynced.current = false;
    setOnlineState(false);
    setVerified(null);
    setError(null);
    void AsyncStorage.removeItem(ONLINE_KEY).catch(() => undefined);
  }, [token]);

  return (
    <DutyContext.Provider value={{ online, verified, busy: setOnlineMutation.isPending, error, setOnline }}>
      {children}
    </DutyContext.Provider>
  );
}

export function useDuty(): DutyState {
  const ctx = useContext(DutyContext);
  if (!ctx) throw new Error("useDuty must be used within <DutyProvider>");
  return ctx;
}
