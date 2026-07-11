import { getConfig } from "./config";
import { getPrisma } from "./db";
import { getFirebaseApp } from "./firebase";
import { logger } from "./logger";

/**
 * FCM push sender with a config-selected stub (mirrors the Razorpay/R2 pattern).
 *
 * - `FIREBASE_PROJECT_ID` set → real send via firebase-admin `sendEachForMulticast`
 *   to every `DeviceToken` the user has registered (reuses the shared app from
 *   `core/firebase.ts`).
 * - unset (dev/test) → structured log no-op; the persisted notification row is
 *   still the durable source of truth for the in-app center.
 *
 * Best-effort by design: never throws — push is fired after a lifecycle
 * transition has already committed, so a delivery failure must not surface.
 */

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendPushToUser(userId: string, msg: PushMessage): Promise<void> {
  try {
    const rows = await getPrisma().deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    const tokens = rows.map((row) => row.token);
    if (tokens.length === 0) return;

    // Stub mode: no Firebase creds locally — log and no-op (row already durable).
    if (getConfig().FIREBASE_PROJECT_ID === undefined) {
      logger.info(
        { userId, deviceCount: tokens.length, title: msg.title },
        "push (stub) — FIREBASE_PROJECT_ID unset, no-op",
      );
      return;
    }

    const data = coerceData(msg.data);
    const { getMessaging } = await import("firebase-admin/messaging");
    const app = await getFirebaseApp();
    const result = await getMessaging(app).sendEachForMulticast({
      tokens,
      notification: { title: msg.title, body: msg.body },
      ...(data ? { data } : {}),
    });
    logger.info(
      { userId, sent: result.successCount, failed: result.failureCount },
      "push sent",
    );
  } catch (error) {
    // Swallow: caller is post-commit and must not fail on push delivery.
    logger.warn({ err: error, userId }, "push send failed");
  }
}

/** FCM `data` values must all be strings — coerce (JSON-encode non-strings). */
function coerceData(
  data: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!data) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
