import * as Location from "expo-location";
import type { DriverLocationPing } from "@medrush/contracts";
import { sendBackgroundLocations } from "./locationSink";

/**
 * Background GPS during an active delivery (§11 live tracking). Without this,
 * location streams only while the app is foregrounded (lib/dispatch.tsx
 * watcher) — tracking freezes the moment the rider pockets the phone. An
 * Android foreground service (started via expo-location background updates)
 * keeps the JS process — and therefore the dispatch socket — alive, and this
 * module's TaskManager task forwards each location batch through the socket
 * send path (lib/locationSink.ts).
 *
 * AVAILABILITY: `expo-task-manager` is a native module that exists only in
 * builds produced AFTER it was added (same situation as lib/firebase.ts — the
 * currently-installed dev client predates it). Every touch point goes through
 * a lazy `require` probe; when unavailable the app keeps exactly today's
 * foreground-only behavior.
 *
 * The task definition MUST live at module scope (TaskManager requirement) in a
 * file imported from the root layout, so it is registered on every bundle
 * evaluation — including headless starts by the foreground service.
 */

type TaskManagerModule = typeof import("expo-task-manager");

/* Metro provides CommonJS `require` at runtime; declare it for tsc (no
 * @types/node in this app). */
declare const require: (id: string) => unknown;

/** Cached probe — `undefined` = not probed yet, `null` = unavailable. */
let cachedTaskManager: TaskManagerModule | null | undefined;

function getTaskManager(): TaskManagerModule | null {
  if (cachedTaskManager !== undefined) return cachedTaskManager;
  try {
    // Throws when the native module is missing (build predates expo-task-manager).
    cachedTaskManager = require("expo-task-manager") as TaskManagerModule;
  } catch {
    cachedTaskManager = null;
  }
  return cachedTaskManager;
}

export const BACKGROUND_LOCATION_TASK = "medrush-driver-location";

// Module-scope task definition — required by TaskManager (must run during
// bundle evaluation, before any startLocationUpdatesAsync references it).
const taskManagerAtLoad = getTaskManager();
if (taskManagerAtLoad) {
  try {
    // async because TaskManager executors must return a Promise.
    taskManagerAtLoad.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
      if (error || !data) return;
      const locations =
        (data as { locations?: Location.LocationObject[] }).locations ?? [];
      const points: DriverLocationPing[] = locations.map((pos) => ({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        ts: new Date(pos.timestamp).toISOString(),
      }));
      sendBackgroundLocations(points);
    });
  } catch {
    // defineTask itself blew up → treat the module as unavailable.
    cachedTaskManager = null;
  }
}

/** True when this build can run background location updates. */
export function isBackgroundLocationAvailable(): boolean {
  return (
    getTaskManager() !== null &&
    typeof Location.startLocationUpdatesAsync === "function"
  );
}

export type BackgroundTrackingResult = "started" | "denied" | "unavailable" | "cancelled";

/**
 * Ask for background permission and start the foreground-service location
 * stream. Callers must already hold foreground location permission (Android
 * requires it before the background request). Graceful on every failure:
 *  - "denied"      → caller keeps the foreground watcher + shows a warning
 *  - "unavailable" → old dev client / API error — exactly today's behavior
 *  - "cancelled"   → `isCancelled()` turned true while the permission modal
 *                    was up (delivery ended / sign-out) — nothing was started
 */
export async function startBackgroundTracking(
  isCancelled?: () => boolean,
): Promise<BackgroundTrackingResult> {
  if (!isBackgroundLocationAvailable()) return "unavailable";
  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    if (status !== "granted") return "denied";
    // The permission modal can stay up indefinitely; if the caller cancelled
    // meanwhile, starting now would orphan the Android foreground service
    // (its cleanup already ran) — bail out before the service exists.
    if (isCancelled?.()) return "cancelled";
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
      return "started";
    }
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      // Same accuracy/backoff posture as the foreground watcher (dispatch.tsx).
      accuracy: Location.Accuracy.High,
      timeInterval: 5_000,
      distanceInterval: 20,
      // Android: the sticky notification keeps the JS process (and the
      // dispatch socket) alive for the whole delivery.
      foregroundService: {
        notificationTitle: "Delivery in progress",
        notificationBody: "MedRush is sharing your live location with the customer.",
        killServiceOnDestroy: true,
      },
      // iOS (Android-first for launch, but keep parity with UIBackgroundModes).
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
    });
    return "started";
  } catch {
    return "unavailable";
  }
}

/** Stop the background stream (delivery done/unassigned, driver signed out). */
export async function stopBackgroundTracking(): Promise<void> {
  if (!isBackgroundLocationAvailable()) return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch {
    // Already stopped / task not registered — nothing to do.
  }
}
