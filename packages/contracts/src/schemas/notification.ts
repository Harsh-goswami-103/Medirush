/**
 * Notification-center endpoints (BLUEPRINT §7.2, Phase 6).
 *
 * | Endpoint                                | Query / Params        | Response data              |
 * |-----------------------------------------|-----------------------|----------------------------|
 * | GET  /v1/notifications                  | NotificationListQuery | NotificationSchema[] + meta |
 * | GET  /v1/notifications/unread-count     | —                     | UnreadCountSchema          |
 * | POST /v1/notifications/:id/read         | IdParams              | { ok: true }               |
 * | POST /v1/notifications/read-all         | —                     | { ok: true }               |
 *
 * Rows are per-user (own only — ownership enforced in the service, not just the
 * guard). Written by the backend `notifyUser` helper at order/payout lifecycle
 * points; delivered live via socket + persisted here for the center.
 */
import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, envelope, paginatedEnvelope } from "./common";

/**
 * Notification kind — a stable string the client switches on for icon/route.
 * Known values (extend as lifecycle grows): `ORDER_PLACED`, `ORDER_RX_APPROVED`,
 * `ORDER_RX_REJECTED`, `ORDER_READY`, `ORDER_ASSIGNED`, `ORDER_PICKED_UP`,
 * `ORDER_DELIVERED`, `ORDER_CANCELLED`, `PAYOUT_APPROVED`, `PAYOUT_PAID`.
 * Kept loose (string) so a new type never breaks an older client.
 */
export const NotificationTypeSchema = z.string().min(1).max(64);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/** A single notification-center row (the owning user's `userId` is never exposed). */
export const NotificationSchema = z.object({
  id: IdSchema,
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string(),
  /** Opaque payload for client deep-linking (e.g. `{ orderId }`); null when none. */
  data: z.unknown().nullable(),
  /** When the user read it; null = unread. */
  readAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;

/** GET /v1/notifications — cursor pagination + optional unread-only filter. */
export const NotificationListQuerySchema = z.object({
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * When `"true"`/`"1"`, return only unread rows (`readAt = null`). Parsed from a
   * query string, so NOT `z.coerce.boolean()` — that treats `"false"` as `true`
   * (`Boolean("false") === true`); anything but `"true"`/`"1"` means "all".
   */
  unreadOnly: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
export const ListNotificationsResponseSchema = paginatedEnvelope(NotificationSchema);

/** GET /v1/notifications/unread-count — for the bell badge. */
export const UnreadCountSchema = z.object({ count: z.number().int().min(0) });
export type UnreadCount = z.infer<typeof UnreadCountSchema>;
export const UnreadCountResponseSchema = envelope(UnreadCountSchema);
