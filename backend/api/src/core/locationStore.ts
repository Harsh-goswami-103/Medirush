/**
 * In-memory driver-location store (BLUEPRINT §11). Live driver pings are volatile
 * and high-frequency, so they never hit Postgres — the last known position per
 * ACTIVE order is held here and read by `GET /v1/orders/:id/track`. A process
 * restart simply drops the cache; the next ping repopulates it.
 */

export interface DriverLocation {
  lat: number;
  lng: number;
  /** ISO capture time of the ping. */
  ts: string;
}

/** orderId → last known driver position for that active delivery. */
const byOrder = new Map<string, DriverLocation>();

/** Record the latest ping for an order's active delivery. */
export function setDriverLocation(orderId: string, location: DriverLocation): void {
  byOrder.set(orderId, location);
}

/** Last known driver position for an order, or null when none has arrived. */
export function getDriverLocation(orderId: string): DriverLocation | null {
  return byOrder.get(orderId) ?? null;
}

/** Drop an order's cached location (called when a delivery terminates). */
export function clearDriverLocation(orderId: string): void {
  byOrder.delete(orderId);
}

/** Test helper: wipe the whole cache. */
export function resetLocationStore(): void {
  byOrder.clear();
}
