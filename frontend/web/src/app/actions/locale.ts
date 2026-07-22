"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";

/**
 * Persists the language choice. A server action rather than `document.cookie`
 * so the attributes (path, max-age, sameSite) are set in one place and the
 * server layout re-renders with the new catalog in the same round trip.
 */
export async function setLocale(value: string): Promise<void> {
  if (!isLocale(value)) return;

  (await cookies()).set(LOCALE_COOKIE, value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    // Readable by JS on purpose: nothing sensitive, and the offline shell may
    // need it to pick a cached catalog.
    httpOnly: false,
  });

  // The locale is read in the root layout, so every route's RSC payload is stale.
  revalidatePath("/", "layout");
}
