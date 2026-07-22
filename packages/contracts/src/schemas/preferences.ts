/**
 * Notification consent and the right to erasure.
 *
 * | Endpoint                          | Body                            | Response data              |
 * |-----------------------------------|---------------------------------|----------------------------|
 * | GET   /v1/me/notification-prefs   | —                               | NotificationPreferences    |
 * | PATCH /v1/me/notification-prefs   | UpdateNotificationPrefsBody     | NotificationPreferences    |
 * | DELETE /v1/me                     | DeleteAccountBodySchema         | OkSchema                   |
 *
 * `orderUpdates` covers transactional messages a customer cannot meaningfully
 * opt out of while an order is live, so it is exposed read-only-ish (settable,
 * but the service still sends delivery-critical notices). `promotions` is a
 * genuine marketing opt-out.
 *
 * DELETE /v1/me is the DPDP-2023 / Play-Store erasure path: it ANONYMISES
 * rather than hard-deletes, because invoices, the Schedule-H1 register and the
 * GST record must survive for their statutory retention periods.
 */
import { z } from "zod";
import { IsoDateTimeSchema, envelope } from "./common";

export const NotificationPreferencesSchema = z.object({
  /** Order lifecycle (placed → delivered), Rx review outcomes, refunds. */
  orderUpdates: z.boolean(),
  /** Offers, coupons, campaigns. */
  promotions: z.boolean(),
  /** "Time to reorder your medicine" nudges. */
  refillReminders: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const UpdateNotificationPrefsBodySchema = z
  .object({
    orderUpdates: z.boolean(),
    promotions: z.boolean(),
    refillReminders: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: "at least one preference is required" });
export type UpdateNotificationPrefsBody = z.infer<typeof UpdateNotificationPrefsBodySchema>;

export const NotificationPrefsResponseSchema = envelope(NotificationPreferencesSchema);

/**
 * Typed confirmation so a stray DELETE can never erase an account: the client
 * must echo the exact phrase the UI shows.
 */
export const ACCOUNT_DELETE_CONFIRMATION = "DELETE" as const;
export const DeleteAccountBodySchema = z.object({
  confirm: z.literal(ACCOUNT_DELETE_CONFIRMATION),
  /** Optional free-text reason, retained in the audit log only. */
  reason: z.string().trim().max(300).optional(),
});
export type DeleteAccountBody = z.infer<typeof DeleteAccountBodySchema>;
