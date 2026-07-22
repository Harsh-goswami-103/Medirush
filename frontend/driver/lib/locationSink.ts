import type { DriverLocationPing } from "@medrush/contracts";
import { addLocationDropBreadcrumb, reportDroppedLocationPings } from "./sentry";

/**
 * Tiny hand-off between the background-location task (lib/backgroundLocation.ts,
 * module scope — no React) and the live dispatch socket (lib/dispatch.tsx,
 * component scope). The socket owner registers a sender while it is connected;
 * the task forwards batches through it. No sender registered (signed out,
 * socket torn down, or disconnected) → points are DROPPED, never buffered —
 * stale pings are worse than missing ones for live tracking.
 *
 * Drops stay drops, but they are no longer silent: they are counted, exposed as
 * a snapshot the UI can subscribe to (components/LiveTrackingBanner.tsx), and
 * reported to Sentry in aggregate.
 *
 * Keep this module React-free and dependency-light — it is imported at module
 * scope by the TaskManager task, which can run headless.
 */

/** Returns true when the batch actually left the device. */
type LocationSender = (points: DriverLocationPing[]) => boolean;

export interface LocationSinkState {
  /** A sender is registered — the dispatch socket lifecycle is up. */
  senderRegistered: boolean;
  /** Points dropped since the last successful forward (0 while healthy). */
  droppedRecent: number;
  /** Points dropped since app start. */
  droppedTotal: number;
  /** epoch ms of the last batch that reached a sender, null if never. */
  lastForwardAt: number | null;
  /** epoch ms of the last dropped batch, null if never. */
  lastDropAt: number | null;
}

type Listener = () => void;

/*
 * Sentry throttling: a rider streams ~1 point per 5s, so an event per dropped
 * point would flood the project during any outage. Each drop only bumps
 * counters; Sentry sees a breadcrumb when an outage STARTS (first drop after a
 * quiet gap) and at most one aggregated event per cooldown, once an outage has
 * cost more than a handful of points.
 */
const OUTAGE_GAP_MS = 60_000;
const DROP_EVENT_THRESHOLD = 50;
const DROP_EVENT_COOLDOWN_MS = 15 * 60_000;

let sender: LocationSender | null = null;
let droppedRecent = 0;
let droppedTotal = 0;
let droppedSinceReport = 0;
let lastForwardAt: number | null = null;
let lastDropAt: number | null = null;
let lastReportAt = 0;

const listeners = new Set<Listener>();

function buildSnapshot(): LocationSinkState {
  return {
    senderRegistered: sender !== null,
    droppedRecent,
    droppedTotal,
    lastForwardAt,
    lastDropAt,
  };
}

let snapshot: LocationSinkState = buildSnapshot();

/**
 * Rebuild the immutable snapshot. Subscribers are woken only for drops,
 * registration changes and recoveries — a healthy forward every 5s must not
 * re-render the whole provider tree.
 */
function commit(notify: boolean): void {
  snapshot = buildSnapshot();
  if (!notify) return;
  for (const listener of listeners) listener();
}

/** Subscribe to sink telemetry (useSyncExternalStore-shaped). */
export function subscribeLocationSink(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current telemetry snapshot — stable identity until something changes. */
export function getLocationSinkState(): LocationSinkState {
  return snapshot;
}

/** Registered by the dispatch socket lifecycle; pass null on teardown. */
export function setBackgroundLocationSender(next: LocationSender | null): void {
  sender = next;
  commit(true);
}

/** Forward a batch of pings to the active sender, or drop them (counted). */
export function sendBackgroundLocations(points: DriverLocationPing[]): void {
  if (points.length === 0) return;
  if (sender?.(points)) {
    lastForwardAt = Date.now();
    const recovered = droppedRecent > 0;
    droppedRecent = 0;
    commit(recovered);
    return;
  }
  noteDrop(points.length);
}

function noteDrop(count: number): void {
  const now = Date.now();
  const outageStart = lastDropAt === null || now - lastDropAt > OUTAGE_GAP_MS;
  droppedRecent += count;
  droppedTotal += count;
  droppedSinceReport += count;
  lastDropAt = now;
  commit(true);

  if (outageStart) {
    addLocationDropBreadcrumb({
      senderRegistered: sender !== null,
      droppedTotal,
      lastForwardAt,
    });
  }
  if (droppedSinceReport >= DROP_EVENT_THRESHOLD && now - lastReportAt >= DROP_EVENT_COOLDOWN_MS) {
    reportDroppedLocationPings({
      dropped: droppedSinceReport,
      droppedTotal,
      senderRegistered: sender !== null,
      lastForwardAt,
    });
    droppedSinceReport = 0;
    lastReportAt = now;
  }
}
