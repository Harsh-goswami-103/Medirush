/** Backend base URL. Defaults to the local API; set NEXT_PUBLIC_API_URL in prod. */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Whether real Firebase auth is configured (else the dev-login path is used). */
export const FIREBASE_ENABLED = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);
