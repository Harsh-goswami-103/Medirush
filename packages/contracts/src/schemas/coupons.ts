/**
 * Customer coupon endpoints (feature-gap Batch 2 — offers surface + apply preview).
 *
 * | Endpoint                  | Body / Query             | Response data          |
 * |---------------------------|--------------------------|------------------------|
 * | GET  /v1/coupons          | —                        | PublicCouponSchema[]   |
 * | POST /v1/coupons/validate | ValidateCouponBodySchema | CouponQuoteSchema      |
 *
 * GET lists active, in-window coupons flagged `isPublic` (the admin-only fields
 * — usage limits, redemption counts — are never exposed). POST validates a code
 * against the caller's CURRENT server cart with the exact same rules the order
 * create runs (§9.2: window, usage/per-user limits, min order) and returns the
 * priced quote; an unusable code is a 422 COUPON_INVALID whose message says why
 * — so checkout can show the discount BEFORE the customer commits to paying.
 */
import { z } from "zod";
import { CouponKindSchema } from "../enums";
import { IsoDateTimeSchema, PaiseSchema, envelope } from "./common";

/** Customer-safe view of a promotable coupon. */
export const PublicCouponSchema = z.object({
  code: z.string(),
  /** Marketing copy, e.g. "₹50 off your first order above ₹499". */
  description: z.string().nullable(),
  kind: CouponKindSchema,
  /** FLAT → paise off · PERCENT → % off. */
  valuePaiseOrPct: z.number().int().positive(),
  minOrderPaise: PaiseSchema,
  maxDiscountPaise: PaiseSchema.nullable(),
  /** Window end — clients show "valid till". */
  endsAt: IsoDateTimeSchema,
});
export type PublicCoupon = z.infer<typeof PublicCouponSchema>;
export const ListPublicCouponsResponseSchema = envelope(z.array(PublicCouponSchema));

/** POST /v1/coupons/validate */
export const ValidateCouponBodySchema = z.object({
  /** Uppercased server-side; same constraint as CreateOrderBody.couponCode. */
  code: z.string().trim().min(1).max(32),
});
export type ValidateCouponBody = z.infer<typeof ValidateCouponBodySchema>;

/**
 * Priced quote for a valid code against the caller's current cart. Totals are
 * advisory (the order create re-validates everything §9.2) but computed by the
 * same pricing module, so they match what POST /v1/orders would charge.
 */
export const CouponQuoteSchema = z.object({
  code: z.string(),
  discountPaise: PaiseSchema,
  itemsPaise: PaiseSchema,
  deliveryPaise: PaiseSchema,
  totalPaise: PaiseSchema,
});
export type CouponQuote = z.infer<typeof CouponQuoteSchema>;
export const ValidateCouponResponseSchema = envelope(CouponQuoteSchema);
