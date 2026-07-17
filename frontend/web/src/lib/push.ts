"use client";

import { api } from "./api";
import { FIREBASE_VAPID_KEY, getFirebaseApp, isPushConfigured } from "./firebase";

/**
 * Web push opt-in (§17 v1 "Push + in-app notifications"). The backend side has
 * existed since Phase 6 — `POST /v1/devices` stores the token and
 * `core/push.ts` fans out via FCM — but the web client never registered a
 * token, so only in-app notifications worked. This wires the missing half:
 * permission → FCM `getToken` (against our own /sw.js registration, which
 * carries the push/notificationclick handlers) → register with the API.
 *
 * Everything is gated on `isPushConfigured` (core Firebase config + sender id
 * + VAPID key): in local dev-token mode this module is a guaranteed no-op.
 */
export type EnablePushResult = "enabled" | "denied" | "unsupported";

export async function enableWebPush(): Promise<EnablePushResult> {
  if (
    typeof window === "undefined" ||
    !isPushConfigured ||
    !("Notification" in window) ||
    !("serviceWorker" in navigator)
  ) {
    return "unsupported";
  }

  // Dynamic import keeps firebase/messaging out of the bundle for the ~100% of
  // sessions that never opt in (and for unconfigured builds entirely).
  const { getMessaging, getToken, isSupported } = await import("firebase/messaging");
  if (!(await isSupported())) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";

  // Reuse the app SW when registered (production); register it on demand
  // otherwise so the push handlers exist wherever the token points.
  const registration =
    (await navigator.serviceWorker.getRegistration("/sw.js")) ??
    (await navigator.serviceWorker.register("/sw.js"));

  const token = await getToken(getMessaging(getFirebaseApp()), {
    vapidKey: FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });
  if (!token) return "denied";

  await api.post("/v1/devices", { token, platform: "web" });
  return "enabled";
}
