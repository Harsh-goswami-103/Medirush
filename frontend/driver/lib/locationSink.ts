import type { DriverLocationPing } from "@medrush/contracts";

/**
 * Tiny hand-off between the background-location task (lib/backgroundLocation.ts,
 * module scope — no React) and the live dispatch socket (lib/dispatch.tsx,
 * component scope). The socket owner registers a sender while it is connected;
 * the task forwards batches through it. No sender registered (signed out,
 * socket torn down, or disconnected) → points are DROPPED, never buffered —
 * stale pings are worse than missing ones for live tracking.
 */

type LocationSender = (points: DriverLocationPing[]) => void;

let sender: LocationSender | null = null;

/** Registered by the dispatch socket lifecycle; pass null on teardown. */
export function setBackgroundLocationSender(next: LocationSender | null): void {
  sender = next;
}

/** Forward a batch of pings to the active sender, or drop them. */
export function sendBackgroundLocations(points: DriverLocationPing[]): void {
  if (points.length === 0) return;
  sender?.(points);
}
