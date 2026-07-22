/**
 * Retention surfaces: wishlist, refill reminders and the referral programme
 * (§17 v1.1 "referral program, refill reminders (meds repeat!), wishlists").
 *
 * | Endpoint                             | Body / Query                | Response data           |
 * |--------------------------------------|-----------------------------|-------------------------|
 * | GET    /v1/wishlist                  | CursorQuerySchema           | WishlistEntrySchema[]   |
 * | POST   /v1/wishlist                  | ToggleWishlistBodySchema    | WishlistStatusSchema    |
 * | DELETE /v1/wishlist/:productId       | —                           | WishlistStatusSchema    |
 * | GET    /v1/refills                   | —                           | RefillReminderSchema[]  |
 * | POST   /v1/refills                   | UpsertRefillBodySchema      | RefillReminderSchema    |
 * | DELETE /v1/refills/:id               | —                           | OkSchema                |
 * | GET    /v1/referrals                 | —                           | ReferralSummarySchema   |
 *
 * All are customer-auth, owner-scoped. Reminders are opt-in per product and
 * swept daily; the referral reward is issued as a PERSONAL coupon (reusing the
 * existing coupon validation/redemption machinery rather than a second money
 * path), so a reward is spendable exactly like any other code.
 */
import { z } from "zod";
import {
  CountSchema,
  CursorQuerySchema,
  IdSchema,
  IsoDateTimeSchema,
  PaiseSchema,
  envelope,
  paginatedEnvelope,
} from "./common";
import { ProductSummarySchema } from "./catalog";

/* ---------------------------------------------------------------- wishlist */

export const WishlistEntrySchema = z.object({
  id: IdSchema,
  product: ProductSummarySchema,
  createdAt: IsoDateTimeSchema,
});
export type WishlistEntry = z.infer<typeof WishlistEntrySchema>;

export const ToggleWishlistBodySchema = z.object({ productId: IdSchema });
export type ToggleWishlistBody = z.infer<typeof ToggleWishlistBodySchema>;

/** Whether the product is currently on the caller's wishlist. */
export const WishlistStatusSchema = z.object({ productId: IdSchema, wishlisted: z.boolean() });
export type WishlistStatus = z.infer<typeof WishlistStatusSchema>;

export const ListWishlistQuerySchema = CursorQuerySchema;
export const ListWishlistResponseSchema = paginatedEnvelope(WishlistEntrySchema);
export const WishlistStatusResponseSchema = envelope(WishlistStatusSchema);

/* --------------------------------------------------------- refill reminders */

/** Bounds keep the daily sweep sane and the UI honest. */
export const RefillIntervalDaysSchema = z.number().int().min(7).max(180);

export const RefillReminderSchema = z.object({
  id: IdSchema,
  product: ProductSummarySchema,
  intervalDays: RefillIntervalDaysSchema,
  nextDueAt: IsoDateTimeSchema,
  isActive: z.boolean(),
  lastNotifiedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type RefillReminder = z.infer<typeof RefillReminderSchema>;

/**
 * Upsert by (user, product). `startFrom` defaults to now server-side, so the
 * first reminder fires `intervalDays` after the customer sets it up.
 */
export const UpsertRefillBodySchema = z.object({
  productId: IdSchema,
  intervalDays: RefillIntervalDaysSchema,
  startFrom: IsoDateTimeSchema.optional(),
});
export type UpsertRefillBody = z.infer<typeof UpsertRefillBodySchema>;

export const ListRefillsResponseSchema = envelope(z.array(RefillReminderSchema));
export const RefillReminderResponseSchema = envelope(RefillReminderSchema);

/* --------------------------------------------------------------- referrals */

/** A reward the referrer has earned — a personal coupon code they can spend. */
export const ReferralRewardSchema = z.object({
  code: z.string(),
  description: z.string().nullable(),
  /** Paise off (FLAT) — rewards are always flat-value for predictability. */
  valuePaise: PaiseSchema,
  minOrderPaise: PaiseSchema,
  endsAt: IsoDateTimeSchema,
  /** True once the coupon has been redeemed on an order. */
  used: z.boolean(),
});
export type ReferralReward = z.infer<typeof ReferralRewardSchema>;

export const ReferralSummarySchema = z.object({
  /** The caller's shareable code (generated on first read). */
  code: z.string(),
  /** Friends who signed up with the code. */
  signedUp: CountSchema,
  /** …of those, how many completed a first delivery (reward-triggering). */
  rewarded: CountSchema,
  /** What the referrer earns per successful referral, for the share copy. */
  rewardPaise: PaiseSchema,
  /** What a new user gets for using the code. */
  refereeRewardPaise: PaiseSchema,
  rewards: z.array(ReferralRewardSchema),
});
export type ReferralSummary = z.infer<typeof ReferralSummarySchema>;
export const ReferralSummaryResponseSchema = envelope(ReferralSummarySchema);

/** Applied at sign-up: attribute the new account to a referrer's code. */
export const ApplyReferralBodySchema = z.object({
  code: z.string().trim().min(4).max(32),
});
export type ApplyReferralBody = z.infer<typeof ApplyReferralBodySchema>;
