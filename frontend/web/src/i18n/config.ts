/**
 * Bilingual EN/HI support (§20.1: "bilingual-ready — EN + Hindi strings via
 * i18n keys from day one; Devanagari-safe fonts"). The Devanagari font half
 * already ships via next/font in the root layout.
 *
 * Locale comes from a COOKIE, not the URL. This is a PWA for one market where
 * language is a user preference: locale-segmented routes would break the
 * installed app's `start_url: "/"` and every existing deep link, for no SEO
 * gain. next-intl runs in its routing-free mode accordingly.
 */
export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie the language toggle writes and the server layout reads. */
export const LOCALE_COOKIE = "medrush.locale";

/** Native names — a language picker should never list languages in English only. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  hi: "हिन्दी",
};

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}
