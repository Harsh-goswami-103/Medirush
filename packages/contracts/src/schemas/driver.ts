/**
 * Driver endpoints (BLUEPRINT §7.2 — role DRIVER, verified).
 * All `/v1/driver/*` routes are gated by `x-app-version` ≥ minDriverAppVersion
 * (426 UPGRADE_REQUIRED otherwise) — see APP_VERSION_HEADER.
 *
 * | Endpoint                                   | Body / Query / Params       | Response data              |
 * |--------------------------------------------|-----------------------------|----------------------------|
 * | PATCH /v1/driver/status                    | UpdateDriverStatusBodySchema| DriverStatusSchema         |
 * | GET   /v1/driver/offers                    | —                           | OfferSchema[]              |
 * | POST  /v1/driver/offers/:id/accept         | IdParams                    | ActiveDeliverySchema       |
 * | POST  /v1/driver/offers/:id/reject         | IdParams                    | OkSchema                   |
 * | GET   /v1/driver/active                    | —                           | ActiveDeliverySchema|null  |
 * | POST  /v1/driver/deliveries/:id/picked-up  | IdParams                    | ActiveDeliverySchema       |
 * | POST  /v1/driver/deliveries/:id/deliver    | DeliverBodySchema           | DeliverResultSchema        |
 * | POST  /v1/driver/location                  | DriverLocationBatchBodySchema| OkSchema                  |
 * | GET   /v1/driver/history                   | DriverHistoryQuerySchema    | DriverHistorySchema        |
 *
 * Wallet & payout routes live in wallet.ts.
 * Offer delivery is socket-first (`offer:new` in socket-events.ts); GET /offers is the refresh.
 */
import { z } from "zod";
import { OrderStatus, PaymentMethodSchema } from "../enums";
import {
  AckResponseSchema,
  CountSchema,
  GeoPointSchema,
  IdSchema,
  IsoDateTimeSchema,
  LatSchema,
  LngSchema,
  MetersSchema,
  OkSchema,
  OtpSchema,
  PaiseSchema,
  PhoneSchema,
  envelope,
} from "./common";

/* ---------------------------------------------------------------- status */

/** PATCH /v1/driver/status */
export const UpdateDriverStatusBodySchema = z.object({
  isOnline: z.boolean(),
});
export type UpdateDriverStatusBody = z.infer<typeof UpdateDriverStatusBodySchema>;

export const DriverStatusSchema = z.object({
  isOnline: z.boolean(),
  /** Verified drivers only can go online; surfaced so the app can explain a rejected toggle. */
  isVerified: z.boolean(),
});
export type DriverStatus = z.infer<typeof DriverStatusSchema>;
export const UpdateDriverStatusResponseSchema = envelope(DriverStatusSchema);

/* ---------------------------------------------------------------- offers */

/**
 * An open delivery offer. Mirrors the `offer:new` socket payload plus an
 * absolute `expiresAt` (HTTP refresh can arrive with unknown latency, so the
 * relative `expiresInSec` alone is not enough).
 */
export const OfferSchema = z.object({
  offerId: IdSchema,
  orderId: IdSchema,
  orderNo: z.string(),
  /** Store pickup point. */
  pickup: GeoPointSchema,
  /** Customer drop point (approximate address line before accept). */
  drop: GeoPointSchema,
  /** Store→customer distance in meters. */
  distanceM: MetersSchema,
  /** Earnings for this delivery in paise, shown upfront. */
  commissionPaise: PaiseSchema,
  /** Dispatch wave (1 = 3 nearest, 2 = all in radius). */
  wave: z.number().int().min(1),
  /** Seconds left to accept at response time. */
  expiresInSec: z.number().int().min(0),
  expiresAt: IsoDateTimeSchema,
});
export type Offer = z.infer<typeof OfferSchema>;

export const ListOffersResponseSchema = envelope(z.array(OfferSchema));

/* --------------------------------------------------------- active delivery */

/** Statuses an active delivery can be in from the driver's perspective. */
export const ActiveDeliveryStatusSchema = z.enum([OrderStatus.ASSIGNED, OrderStatus.PICKED_UP]);

export const DeliveryCustomerSchema = z.object({
  name: z.string().nullable(),
  /** For the in-app call button. */
  phone: PhoneSchema,
});
export type DeliveryCustomer = z.infer<typeof DeliveryCustomerSchema>;

/**
 * The driver's current assignment. The customer's delivery OTP is NEVER part
 * of this payload — the driver types it in at the door.
 */
export const ActiveDeliverySchema = z.object({
  deliveryId: IdSchema,
  orderId: IdSchema,
  orderNo: z.string(),
  status: ActiveDeliveryStatusSchema,
  paymentMethod: PaymentMethodSchema,
  /** Exact cash to collect in paise; null for PREPAID orders. */
  codDuePaise: PaiseSchema.nullable(),
  customer: DeliveryCustomerSchema,
  /** Store pickup point. */
  pickup: GeoPointSchema,
  /** Full customer address for navigation (Google Maps deep-link). */
  drop: GeoPointSchema,
  distanceM: MetersSchema,
  commissionPaise: PaiseSchema,
  itemCount: CountSchema,
  acceptedAt: IsoDateTimeSchema,
  pickedUpAt: IsoDateTimeSchema.nullable(),
});
export type ActiveDelivery = z.infer<typeof ActiveDeliverySchema>;

/** POST /v1/driver/offers/:id/accept — atomic first-accept-wins; 409 OFFER_TAKEN when lost. */
export const AcceptOfferResponseSchema = envelope(ActiveDeliverySchema);
/** POST /v1/driver/offers/:id/reject */
export const RejectOfferResponseSchema = envelope(OkSchema);
/** GET /v1/driver/active — null when the driver has no live assignment. */
export const GetActiveDeliveryResponseSchema = envelope(ActiveDeliverySchema.nullable());
/** POST /v1/driver/deliveries/:id/picked-up */
export const PickedUpResponseSchema = envelope(ActiveDeliverySchema);

/* --------------------------------------------------------------- deliver */

/** POST /v1/driver/deliveries/:id/deliver — completes the order + credits the wallet (§9.6). */
export const DeliverBodySchema = z.object({
  /** 4-digit OTP told by the customer. 5 wrong attempts → OTP_LOCKED (ops unlock). */
  otp: OtpSchema,
  /**
   * Cash collected in paise — REQUIRED for COD orders and must equal the order
   * `totalPaise` (server-verified). Omit for PREPAID.
   */
  codCollectedPaise: PaiseSchema.optional(),
});
export type DeliverBody = z.infer<typeof DeliverBodySchema>;

export const DeliverResultSchema = z.object({
  deliveredAt: IsoDateTimeSchema,
  /** Commission credited for this delivery: `base + perKm × ceil(distanceM/1000)`. */
  commissionPaise: PaiseSchema,
  /** Wallet balance after the credit. */
  walletBalancePaise: PaiseSchema,
});
export type DeliverResult = z.infer<typeof DeliverResultSchema>;
export const DeliverResponseSchema = envelope(DeliverResultSchema);

/* -------------------------------------------------------------- location */

export const DriverLocationPingSchema = z.object({
  lat: LatSchema,
  lng: LngSchema,
  /** Capture time on the device. */
  ts: IsoDateTimeSchema,
});
export type DriverLocationPing = z.infer<typeof DriverLocationPingSchema>;

/**
 * POST /v1/driver/location — HTTP batch fallback used only when the socket is
 * down. Pings are held in memory server-side (never hit Postgres, §11).
 */
export const DriverLocationBatchBodySchema = z.object({
  points: z.array(DriverLocationPingSchema).min(1).max(60),
});
export type DriverLocationBatchBody = z.infer<typeof DriverLocationBatchBodySchema>;
export const DriverLocationBatchResponseSchema = AckResponseSchema;

/* --------------------------------------------------------------- history */

/** GET /v1/driver/history?date — `date` is an IST calendar day; defaults to today. */
export const DriverHistoryQuerySchema = z.object({
  date: z.iso.date().optional(),
});
export type DriverHistoryQuery = z.infer<typeof DriverHistoryQuerySchema>;

export const DriverHistoryEntrySchema = z.object({
  deliveryId: IdSchema,
  orderId: IdSchema,
  orderNo: z.string(),
  deliveredAt: IsoDateTimeSchema,
  distanceM: MetersSchema,
  commissionPaise: PaiseSchema,
  /** Null for prepaid deliveries. */
  codCollectedPaise: PaiseSchema.nullable(),
});
export type DriverHistoryEntry = z.infer<typeof DriverHistoryEntrySchema>;

export const DriverHistorySchema = z.object({
  date: z.iso.date(),
  deliveries: z.array(DriverHistoryEntrySchema),
  totals: z.object({
    count: CountSchema,
    commissionPaise: PaiseSchema,
    /** Cash the driver owes the store from COD collections that day. */
    codCollectedPaise: PaiseSchema,
  }),
});
export type DriverHistory = z.infer<typeof DriverHistorySchema>;
export const DriverHistoryResponseSchema = envelope(DriverHistorySchema);
