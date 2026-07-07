/**
 * Auth helpers for integration tests (phase-1 brief).
 *
 * In test/dev without Firebase credentials the API accepts a dev token
 * `dev:<firebaseUid>:<phone>` (plugins/auth.ts). These helpers mint that token
 * and the matching `Authorization` header. Both are synchronous — callers may
 * `await` them harmlessly (a plain value passes straight through `await`).
 */

/** `dev:<firebaseUid>:<phone>` — the phone must be E.164 (no colons). */
export function devToken(uid: string, phone: string): string {
  return `dev:${uid}:${phone}`;
}

/** Bearer header for a user row (needs `firebaseUid` + `phone`). */
export function authHeaders(user: { firebaseUid: string; phone: string }): Record<string, string> {
  return { authorization: `Bearer ${devToken(user.firebaseUid, user.phone)}` };
}
