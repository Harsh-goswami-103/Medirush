import type { StoreConfig } from "@prisma/client";
import { getPrisma } from "./db";
import { AppError } from "./errors";

/**
 * StoreConfig accessor (single row, id="store") with a 60s in-process cache
 * (§12), plus the geo/hours/fee helpers every checkout path shares (§9.2).
 */

const CACHE_TTL_MS = 60_000;

let cached: { config: StoreConfig; expiresAt: number } | null = null;

/** Cached single-row StoreConfig. Throws 500 STORE_CONFIG_MISSING when unseeded. */
export async function getStoreConfig(): Promise<StoreConfig> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;

  const config = await getPrisma().storeConfig.findUnique({ where: { id: "store" } });
  if (!config) {
    throw new AppError("STORE_CONFIG_MISSING", "StoreConfig row is missing — seed the database", 500);
  }
  cached = { config, expiresAt: now + CACHE_TTL_MS };
  return config;
}

/** Explicit bust — admin settings save (Phase 3) and tests. */
export function bustStoreConfigCache(): void {
  cached = null;
}

/* ----------------------------------------------------------------- geo */

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two points, in integer meters (§9.2). */
export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
}

/* --------------------------------------------------------------- hours */

// Store hours are IST wall-clock strings; Asia/Kolkata has no DST but we let
// Intl own the offset rather than hard-coding +05:30.
const IST_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

function minutesOfDayInIST(at: Date): number {
  let hour = 0;
  let minute = 0;
  for (const part of IST_TIME_FORMAT.formatToParts(at)) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

function parseHHMM(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Is the store open at `now`? — manual kill-switch AND inside the
 * `[openTime, closeTime)` IST window. Windows where close ≤ open wrap past
 * midnight; open === close means always open.
 * (The `maintenance_banner` flag is a separate checkout gate, §9.2.)
 */
export function isStoreOpenNow(
  config: Pick<StoreConfig, "isOpen" | "openTime" | "closeTime">,
  now: Date = new Date(),
): boolean {
  if (!config.isOpen) return false;

  const minutes = minutesOfDayInIST(now);
  const open = parseHHMM(config.openTime);
  const close = parseHHMM(config.closeTime);

  if (open === close) return true;
  if (open < close) return minutes >= open && minutes < close;
  return minutes >= open || minutes < close;
}

/* ---------------------------------------------------------------- fees */

/** Delivery fee for an items subtotal (§9.2): free at/above the threshold. */
export function deliveryFeePaise(
  config: Pick<StoreConfig, "deliveryBasePaise" | "freeDeliveryAbovePaise">,
  itemsPaise: number,
): number {
  return itemsPaise >= config.freeDeliveryAbovePaise ? 0 : config.deliveryBasePaise;
}
