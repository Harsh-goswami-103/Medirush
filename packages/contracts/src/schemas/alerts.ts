/**
 * Durable ops-alert endpoints (Phase 7 hardening — role INVENTORY or ADMIN).
 *
 * | Endpoint                        | Body / Query / Params  | Response data       |
 * |---------------------------------|------------------------|---------------------|
 * | GET  /v1/ops/alerts             | OpsAlertListQuerySchema| OpsAlertSchema[] + meta |
 * | POST /v1/ops/alerts/:id/ack     | IdParams               | OpsAlertSchema      |
 *
 * Every `emitOpsAlert` socket emit is also persisted as an OpsAlert row, so
 * alerts raised while no ops tab was open (e.g. the 02:30 IST drift audit)
 * survive for morning review. Ack is idempotent — the first `acknowledgedAt`
 * sticks.
 */
import { z } from "zod";
import { CursorQuerySchema, IdSchema, IsoDateTimeSchema, envelope, paginatedEnvelope } from "./common";

/** A durable ops alert row. `kind` is the open AlertKind set (socket-events). */
export const OpsAlertSchema = z.object({
  id: IdSchema,
  kind: z.string(),
  message: z.string(),
  /** Optional entity reference (usually an orderId / walletId); null when none. */
  refId: IdSchema.nullable(),
  /** Opaque structured context captured at emit time; null when none. */
  meta: z.unknown().nullable(),
  createdAt: IsoDateTimeSchema,
  /** When an operator acked it; null = outstanding. */
  acknowledgedAt: IsoDateTimeSchema.nullable(),
});
export type OpsAlert = z.infer<typeof OpsAlertSchema>;

/** GET /v1/ops/alerts — cursor pagination, unacknowledged-only by default. */
export const OpsAlertListQuerySchema = CursorQuerySchema.extend({
  /**
   * When `"true"`/`"1"`, include acknowledged alerts too. Parsed from a query
   * string, so NOT `z.coerce.boolean()` — that treats `"false"` as `true`
   * (`Boolean("false") === true`); anything but `"true"`/`"1"` means unacked only.
   */
  includeAcked: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});
export type OpsAlertListQuery = z.infer<typeof OpsAlertListQuerySchema>;
export const ListOpsAlertsResponseSchema = paginatedEnvelope(OpsAlertSchema);

/** POST /v1/ops/alerts/:id/ack — returns the (now acked) row. */
export const AckOpsAlertResponseSchema = envelope(OpsAlertSchema);
