/** Backend base URL. Defaults to the local API; set NEXT_PUBLIC_API_URL in prod. */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Whether real Firebase auth is configured (else the dev-login path is used). */
export const FIREBASE_ENABLED = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

/** Support line for WhatsApp/help deep-links. Digits are stripped for `wa.me`. */
export const SUPPORT_PHONE = process.env.NEXT_PUBLIC_SUPPORT_PHONE ?? "+919876543210";

/** Build a `wa.me` deep-link to support, optionally pre-filling a message. */
export function whatsappUrl(text?: string): string {
  const digits = SUPPORT_PHONE.replace(/\D/g, "");
  const query = text ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${query}`;
}
