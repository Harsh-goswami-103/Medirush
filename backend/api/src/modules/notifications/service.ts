import { Prisma } from "@prisma/client";
import type { Notification } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { logger } from "../../core/logger";
import { enqueuePush } from "../../jobs/notificationFanout";

/**
 * Notification-center service (Phase 6, BLUEPRINT §7.2).
 *
 * `notifyUser` persists a durable row then best-effort enqueues a push; it is
 * called after a lifecycle transition has already committed (co-located with the
 * socket `emit*` calls) and therefore NEVER throws into the caller. The read
 * side (list / unreadCount / markRead / markAllRead) is strictly own-rows-only —
 * ownership is enforced in the query `where`, so cross-user access is impossible.
 */

/** Consent bucket a notification falls into (NotificationPreference columns). */
export type NotificationCategory = "order" | "promo" | "refill";

const PREFERENCE_FIELD = {
  order: "orderUpdates",
  promo: "promotions",
  refill: "refillReminders",
} as const;

export interface NotifyUserInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Consent bucket checked before pushing; defaults to transactional "order". */
  category?: NotificationCategory;
}

/**
 * Notification types that ALWAYS push, whatever `orderUpdates` says. A customer
 * cannot opt out of safety- and money-critical notices about a live order: an
 * Rx rejection (the medicine is NOT coming), a cancellation, a refund, the
 * courier arriving/handing over, and the handover OTP. Everything else —
 * ORDER_PLACED, ORDER_READY, ORDER_RX_APPROVED, driver-side assignment chatter,
 * payouts — honours the toggle, as do the promo/refill buckets.
 */
const ALWAYS_PUSH_TYPES: ReadonlySet<string> = new Set([
  "ORDER_RX_REJECTED",
  "ORDER_CANCELLED",
  "ORDER_REFUNDED",
  "ORDER_PICKED_UP",
  "ORDER_DELIVERED",
  "ORDER_OTP",
]);

/**
 * Whether a push may be sent. Delivery-critical types bypass consent entirely
 * (see ALWAYS_PUSH_TYPES); otherwise the category's own toggle decides. A
 * missing preference row means the user has never opted out ⇒ all-true. Single
 * indexed lookup on the unique userId.
 */
async function pushAllowed(
  userId: string,
  category: NotificationCategory,
  type: string,
): Promise<boolean> {
  if (category === "order" && ALWAYS_PUSH_TYPES.has(type)) return true;
  const row = await getPrisma().notificationPreference.findUnique({
    where: { userId },
    select: { orderUpdates: true, promotions: true, refillReminders: true },
  });
  return row === null ? true : row[PREFERENCE_FIELD[category]];
}

/**
 * Persist a Notification for a user and enqueue its push. Best-effort end to
 * end: any failure (write or enqueue) is logged and swallowed so a post-commit
 * caller is never disrupted.
 *
 * Consent (DPDP/TRAI) gates the PUSH only — the in-app row is always written so
 * notification history stays complete even for an opted-out category. Callers
 * MUST pass `category` for marketing ("promo") and refill ("refill") sends;
 * omitting it means transactional "order".
 */
export async function notifyUser(input: NotifyUserInput): Promise<void> {
  try {
    await getPrisma().notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        ...(input.data !== undefined
          ? { data: input.data as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });

    if (await pushAllowed(input.userId, input.category ?? "order", input.type)) {
      await enqueuePush({
        userId: input.userId,
        title: input.title,
        body: input.body,
        data: input.data,
      });
    }
  } catch (error) {
    // Notifications are a side-channel to the committed transition — log, never throw.
    logger.error({ err: error, userId: input.userId, type: input.type }, "notifyUser failed");
  }
}

interface ListNotificationsQuery {
  cursor?: string;
  limit: number;
  unreadOnly?: boolean;
}

/** Cursor-paginated, newest-first list of the user's own notifications. */
export async function listNotifications(
  userId: string,
  q: ListNotificationsQuery,
): Promise<{ items: Notification[]; nextCursor: string | null }> {
  const rows = await getPrisma().notification.findMany({
    where: { userId, ...(q.unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];

  const items: Notification[] = page.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data ?? null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));

  return { items, nextCursor: hasMore && last ? last.id : null };
}

/** Count of the user's unread notifications (for the bell badge). */
export async function unreadCount(userId: string): Promise<number> {
  return getPrisma().notification.count({ where: { userId, readAt: null } });
}

/**
 * Mark a single notification read. Scoped by `userId` so a row belonging to
 * another user is untouched (and no existence is leaked). Idempotent: an
 * already-read row stays read, and a no-match is a silent success.
 */
export async function markRead(userId: string, id: string): Promise<void> {
  await getPrisma().notification.updateMany({
    where: { id, userId },
    data: { readAt: new Date() },
  });
}

/** Mark every unread notification of the user read. */
export async function markAllRead(userId: string): Promise<void> {
  await getPrisma().notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}
