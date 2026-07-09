import { Linking, Platform } from "react-native";
import type { GeoPoint } from "@medrush/contracts";

/** Paise → `₹123.45` (money is integer paise everywhere; never float math). */
export function rupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}₹${(abs / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Paise → `₹123` (whole rupees, for big hero numbers). */
export function rupeesWhole(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

/** Meters → `1.5 km` / `450 m`. */
export function distance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** ISO → `4:05 PM`. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** ISO → `9 Jul, 4:05 PM`. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Seconds → `M:SS` countdown label. */
export function countdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

/** Open the phone dialer for the customer call button. */
export function callNumber(phone: string): void {
  void Linking.openURL(`tel:${phone}`).catch(() => undefined);
}

/**
 * Open turn-by-turn navigation to a drop/pickup point. Prefers the native
 * Google Maps geo intent on Android; falls back to the universal maps URL.
 */
export function navigateTo(point: Pick<GeoPoint, "lat" | "lng"> & { address?: string }): void {
  const label = point.address ? encodeURIComponent(point.address) : "";
  const url =
    Platform.OS === "android"
      ? `google.navigation:q=${point.lat},${point.lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;
  Linking.openURL(url).catch(() => {
    void Linking.openURL(
      `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}${
        label ? `(${label})` : ""
      }`,
    );
  });
}
