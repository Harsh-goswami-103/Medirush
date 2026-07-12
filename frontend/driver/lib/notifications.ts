import { useEffect } from "react";
import { Platform } from "react-native";
import type { RegisterDeviceBody } from "@medrush/contracts";
import { api } from "./api";
import { isNativeFirebaseAvailable } from "./firebase";

/**
 * FCM push registration (§14). The backend already has the whole server side —
 * POST /v1/devices upserts the token and the notification fanout sends through
 * firebase-admin — but no driver device ever registered. This closes the loop:
 * after a successful login, request notification permission, fetch the NATIVE
 * FCM token (`getDevicePushTokenAsync` — the backend sends via firebase-admin,
 * NOT the Expo push service), POST it to /v1/devices, and re-register on token
 * rotation.
 *
 * AVAILABILITY: `expo-notifications` is a native module that exists only in
 * builds produced AFTER it was added (same situation as lib/firebase.ts), and
 * FCM itself needs google-services.json — the exact gate native Firebase auth
 * already probes. Both must be present or everything here is a silent no-op,
 * so the old dev client keeps working unchanged.
 *
 * Logout: the contract has no device-token removal endpoint — /v1/devices
 * upserts BY TOKEN, so the next login on this device re-owns the token instead
 * of duplicating it.
 */

type NotificationsModule = typeof import("expo-notifications");

/* Metro provides CommonJS `require` at runtime; declare it for tsc (no
 * @types/node in this app). */
declare const require: (id: string) => unknown;

/** Cached probe — `undefined` = not probed yet, `null` = unavailable. */
let cachedModule: NotificationsModule | null | undefined;

function getNotificationsModule(): NotificationsModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Throws when the native module is missing (build predates expo-notifications).
    const mod = require("expo-notifications") as NotificationsModule;
    if (typeof mod.getDevicePushTokenAsync !== "function") {
      throw new Error("expo-notifications JS present but incomplete");
    }
    cachedModule = mod;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

async function registerToken(token: string): Promise<void> {
  const body: RegisterDeviceBody = { token, platform: "android" };
  await api.post("/v1/devices", body);
}

/**
 * Register this device for push. Returns a cleanup that unhooks the rotation
 * listener, or null when unavailable (old dev client / no Firebase / iOS —
 * the contract only knows `web` | `android`, and fanout is FCM).
 */
export async function registerForPushNotifications(): Promise<(() => void) | null> {
  if (Platform.OS !== "android") return null;
  // FCM needs google-services.json — the same operator-provisioned gate the
  // native Firebase auth probe checks. Absent → this build cannot receive push.
  if (!isNativeFirebaseAvailable()) return null;
  const mod = getNotificationsModule();
  if (!mod) return null;

  try {
    // Minimal handler so notifications that arrive while the app is
    // foregrounded are still shown (default is to swallow them).
    mod.setNotificationHandler({
      handleNotification: () =>
        Promise.resolve({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
    });

    // Android 13+ POST_NOTIFICATIONS runtime prompt. Denial is not fatal:
    // the token still registers (delivery simply won't display until the
    // driver enables notifications in settings).
    await mod.requestPermissionsAsync().catch(() => undefined);

    const device = await mod.getDevicePushTokenAsync();
    if (typeof device.data === "string" && device.data) {
      await registerToken(device.data);
    }

    // FCM rotates tokens (app data cleared, token expiry) — re-register so
    // the backend never fans out to a dead token.
    const subscription = mod.addPushTokenListener((rotated) => {
      if (typeof rotated.data === "string" && rotated.data) {
        void registerToken(rotated.data).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  } catch {
    // Push is best-effort — never let registration break login.
    return null;
  }
}

/**
 * Hook for the root navigator: register after a successful login, unhook the
 * rotation listener on logout/unmount. No-op whenever push is unavailable.
 */
export function usePushRegistration(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    void registerForPushNotifications()
      .then((unhook) => {
        if (!unhook) return;
        if (cancelled) unhook();
        else cleanup = unhook;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cleanup?.();
      cleanup = null;
    };
  }, [enabled]);
}
