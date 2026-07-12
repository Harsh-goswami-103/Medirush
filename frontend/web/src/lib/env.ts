/**
 * Backend base URL. NEXT_PUBLIC_* is inlined at build time, so an unset var in
 * a production build would silently ship "http://localhost:4000" — fail the
 * build/boot loudly instead. Dev keeps the localhost fallback.
 */
function resolveApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set — a production build of @medrush/web would point at localhost. Set it in the build environment.",
    );
  }
  return "http://localhost:4000";
}

export const API_BASE_URL = resolveApiBaseUrl();

/** Whether real Firebase auth is configured (else the dev-login path is used). */
export const FIREBASE_ENABLED = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

/**
 * Support line for WhatsApp/help deep-links (digits are stripped for `wa.me`).
 * Deliberately NO default: a fake fallback number would render a live link to a
 * stranger's phone. When unset, support CTAs are hidden.
 */
export const SUPPORT_PHONE: string | undefined =
  process.env.NEXT_PUBLIC_SUPPORT_PHONE || undefined;

/**
 * Build a `wa.me` deep-link to support, optionally pre-filling a message.
 * Returns `null` when no support phone is configured — hide the CTA.
 */
export function whatsappUrl(text?: string): string | null {
  if (!SUPPORT_PHONE) return null;
  const digits = SUPPORT_PHONE.replace(/\D/g, "");
  const query = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${query}`;
}
