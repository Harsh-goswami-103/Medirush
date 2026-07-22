/**
 * Post-delivery feedback: order/delivery ratings and issue reports (§17 v1.1
 * "Ratings", §18.3 DELIVERED row — "manual return handling").
 *
 * | Endpoint                       | Body / Query              | Response data        |
 * |--------------------------------|---------------------------|----------------------|
 * | POST /v1/orders/:id/rating     | CreateRatingBodySchema    | RatingSchema         |
 * | GET  /v1/orders/:id/rating     | IdParams                  | RatingSchema \| null  |
 * | POST /v1/orders/:id/returns    | CreateReturnBodySchema    | ReturnRequestSchema  |
 * | GET  /v1/returns               | CursorQuerySchema         | ReturnRequestSchema[]|
 *
 * Both are DELIVERED-only and owner-scoped. A rating is one-per-order (the
 * POST is an upsert so an accidental double-submit is not an error); a return
 * raises a durable ops alert for the pharmacist to work.
 */
import { z } from "zod";
import { CursorQuerySchema, IdSchema, IsoDateTimeSchema, envelope, paginatedEnvelope } from "./common";

/** 1–5 stars. */
export const StarsSchema = z.number().int().min(1).max(5);

export const RatingSchema = z.object({
  id: IdSchema,
  orderId: IdSchema,
  /** Overall order experience. */
  orderStars: StarsSchema,
  /** Delivery-partner rating; null when the order never had a driver. */
  driverStars: StarsSchema.nullable(),
  comment: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Rating = z.infer<typeof RatingSchema>;

export const CreateRatingBodySchema = z.object({
  orderStars: StarsSchema,
  driverStars: StarsSchema.optional(),
  comment: z.string().trim().min(1).max(500).optional(),
});
export type CreateRatingBody = z.infer<typeof CreateRatingBodySchema>;
export const RatingResponseSchema = envelope(RatingSchema);
/** GET returns null when the customer has not rated the order yet. */
export const GetRatingResponseSchema = envelope(RatingSchema.nullable());

/* ------------------------------------------------------------------ returns */

export const ReturnReason = {
  DAMAGED: "DAMAGED",
  WRONG_ITEM: "WRONG_ITEM",
  MISSING: "MISSING",
  EXPIRED: "EXPIRED",
  OTHER: "OTHER",
} as const;
export type ReturnReason = (typeof ReturnReason)[keyof typeof ReturnReason];
export const ReturnReasonSchema = z.enum(ReturnReason);

export const ReturnStatus = {
  REQUESTED: "REQUESTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;
export type ReturnStatus = (typeof ReturnStatus)[keyof typeof ReturnStatus];
export const ReturnStatusSchema = z.enum(ReturnStatus);

export const ReturnRequestSchema = z.object({
  id: IdSchema,
  orderId: IdSchema,
  /** Human order number, so the list can render without a second fetch. */
  orderNo: z.string(),
  reason: ReturnReasonSchema,
  note: z.string().nullable(),
  status: ReturnStatusSchema,
  /** Pharmacist's response once resolved. */
  resolutionNote: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type ReturnRequest = z.infer<typeof ReturnRequestSchema>;

export const CreateReturnBodySchema = z.object({
  reason: ReturnReasonSchema,
  note: z.string().trim().min(1).max(500).optional(),
});
export type CreateReturnBody = z.infer<typeof CreateReturnBodySchema>;
export const ReturnRequestResponseSchema = envelope(ReturnRequestSchema);
export const ListReturnsQuerySchema = CursorQuerySchema;
export const ListReturnsResponseSchema = paginatedEnvelope(ReturnRequestSchema);
