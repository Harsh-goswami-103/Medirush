/**
 * Customer order endpoints (BLUEPRINT §7.2 — Customer).
 *
 * | Endpoint                              | Body / Query / Params           | Response data                  |
 * |----------------------------------------|---------------------------------|--------------------------------|
 * | POST /v1/orders (Idempotency-Key)      | CreateOrderBodySchema           | CreateOrderResultSchema        |
 * | GET  /v1/orders                        | OrderListQuerySchema            | OrderSummarySchema[] + meta    |
 * | GET  /v1/orders/:id                    | IdParams                        | OrderDetailSchema              |
 * | GET  /v1/orders/:id/track              | IdParams                        | TrackOrderResultSchema         |
 * | POST /v1/orders/:id/cancel             | CancelOrderBodySchema           | CancelOrderResultSchema        |
 * | GET  /v1/orders/:id/payment            | IdParams                        | RetryPaymentResultSchema       |
 * | POST /v1/orders/:id/prescriptions      | multipart file (≤5MB jpeg/png/pdf) | PrescriptionSchema          |
 * | GET  /v1/orders/:id/invoice            | IdParams                        | OrderInvoiceSchema             |
 *
 * Order items always come from the SERVER cart — the create body carries no
 * items or prices (price integrity, §9.2). POST /v1/orders requires the
 * `Idempotency-Key` header (UUID, replayed for 24h) — see IDEMPOTENCY_KEY_HEADER.
 */
import { z } from "zod";
import {
  ActorTypeSchema,
  OrderStatusSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  RxStatusSchema,
} from "../enums";
import {
  CountSchema,
  GstRateSchema,
  IdSchema,
  IsoDateTimeSchema,
  LatLngSchema,
  LatSchema,
  LngSchema,
  MetersSchema,
  OtpSchema,
  PaiseSchema,
  PhoneSchema,
  PincodeSchema,
  QtySchema,
  envelope,
  paginatedEnvelope,
} from "./common";

/* ------------------------------------------------------------- snapshots */

/** `Order.addressSnapshot` — frozen at order time (address edits never mutate past orders). */
export const AddressSnapshotSchema = z.object({
  name: z.string(),
  phone: PhoneSchema,
  label: z.string().optional(),
  line1: z.string(),
  line2: z.string().nullish(),
  landmark: z.string().nullish(),
  pincode: PincodeSchema,
  lat: LatSchema,
  lng: LngSchema,
});
export type AddressSnapshot = z.infer<typeof AddressSnapshotSchema>;

/** Order line — all `*Snap` fields are frozen catalog values from order time. */
export const OrderItemSchema = z.object({
  id: IdSchema,
  productId: IdSchema,
  nameSnap: z.string(),
  packSizeSnap: z.string(),
  /** Unit selling price in paise (GST-inclusive). */
  pricePaise: PaiseSchema,
  mrpPaise: PaiseSchema,
  gstRatePct: GstRateSchema,
  hsnSnap: z.string().nullable(),
  requiresRx: z.boolean(),
  qty: QtySchema,
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

/* ----------------------------------------------------------------- order */

export const OrderSchema = z.object({
  id: IdSchema,
  /** Human order number, e.g. `MR-250705-0042`. */
  orderNo: z.string(),
  status: OrderStatusSchema,
  paymentMethod: PaymentMethodSchema,
  paymentStatus: PaymentStatusSchema,
  addressSnapshot: AddressSnapshotSchema,
  /** Store→customer haversine distance in meters. */
  distanceM: MetersSchema,
  itemsPaise: PaiseSchema,
  deliveryPaise: PaiseSchema,
  discountPaise: PaiseSchema,
  /** `items + delivery − discount`. Recomputed server-side; client totals are ignored. */
  totalPaise: PaiseSchema,
  couponCode: z.string().nullable(),
  requiresRx: z.boolean(),
  rxStatus: RxStatusSchema,
  /**
   * 4-digit delivery OTP. Non-null ONLY for the owning customer once status is
   * READY or later; always null in every other context (drivers enter it, never see it).
   */
  deliveryOtp: OtpSchema.nullable(),
  cancelReason: z.string().nullable(),
  /** GST invoice number `MR/25-26/000123`; null until the invoice job runs post-DELIVERED. */
  invoiceNo: z.string().nullable(),
  placedAt: IsoDateTimeSchema.nullable(),
  packedAt: IsoDateTimeSchema.nullable(),
  readyAt: IsoDateTimeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  cancelledAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  items: z.array(OrderItemSchema),
});
export type Order = z.infer<typeof OrderSchema>;

/** Lighter row for GET /v1/orders history list. */
export const OrderSummarySchema = z.object({
  id: IdSchema,
  orderNo: z.string(),
  status: OrderStatusSchema,
  paymentMethod: PaymentMethodSchema,
  paymentStatus: PaymentStatusSchema,
  totalPaise: PaiseSchema,
  itemCount: CountSchema,
  requiresRx: z.boolean(),
  rxStatus: RxStatusSchema,
  createdAt: IsoDateTimeSchema,
  deliveredAt: IsoDateTimeSchema.nullable(),
});
export type OrderSummary = z.infer<typeof OrderSummarySchema>;

/** Append-only audit-trail entry (actor ids are internal — only the type is exposed). */
export const OrderEventSchema = z.object({
  from: OrderStatusSchema.nullable(),
  to: OrderStatusSchema,
  actorType: ActorTypeSchema,
  note: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type OrderEvent = z.infer<typeof OrderEventSchema>;

/**
 * Customer view of a prescription. The R2 `fileKey` is internal-only and never
 * exposed; ops access files via short-lived presigned URLs (inventory.ts).
 */
export const PrescriptionSchema = z.object({
  id: IdSchema,
  status: RxStatusSchema,
  mimeType: z.string(),
  reviewNote: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema.nullable(),
});
export type Prescription = z.infer<typeof PrescriptionSchema>;

/** Assigned-driver card shown to the customer (call button + vehicle). */
export const OrderDriverSchema = z.object({
  name: z.string().nullable(),
  phone: PhoneSchema,
  vehicleType: z.string(),
  vehicleNo: z.string().nullable(),
});
export type OrderDriver = z.infer<typeof OrderDriverSchema>;

/** GET /v1/orders/:id */
export const OrderDetailSchema = OrderSchema.extend({
  events: z.array(OrderEventSchema),
  prescriptions: z.array(PrescriptionSchema),
  /** Null until a driver accepts (status ASSIGNED). */
  driver: OrderDriverSchema.nullable(),
});
export type OrderDetail = z.infer<typeof OrderDetailSchema>;
export const GetOrderResponseSchema = envelope(OrderDetailSchema);

/* ---------------------------------------------------------------- create */

/**
 * POST /v1/orders — items/prices come from the server cart; the client sends
 * only intent. Requires `Idempotency-Key` header (UUID).
 */
export const CreateOrderBodySchema = z.object({
  addressId: IdSchema,
  paymentMethod: PaymentMethodSchema,
  /** Uppercase coupon code; validated server-side (window/limits/minOrder). */
  couponCode: z.string().trim().min(1).max(32).optional(),
});
export type CreateOrderBody = z.infer<typeof CreateOrderBodySchema>;

/** Razorpay checkout handoff for PREPAID orders. */
export const RazorpayCheckoutSchema = z.object({
  /** Razorpay order id (`order_...`) to open Checkout.js with. */
  rzpOrderId: z.string(),
  /** Public Razorpay key id (`rzp_...`). */
  rzpKeyId: z.string(),
  amountPaise: PaiseSchema,
  currency: z.literal("INR"),
});
export type RazorpayCheckout = z.infer<typeof RazorpayCheckoutSchema>;

/**
 * PREPAID → order is PENDING_PAYMENT and `razorpay` is present (open the sheet).
 * COD → order lands PLACED/RX_REVIEW directly with `paymentStatus=COD_DUE` and
 * `razorpay` is absent.
 */
export const CreateOrderResultSchema = z.object({
  order: OrderDetailSchema,
  razorpay: RazorpayCheckoutSchema.optional(),
});
export type CreateOrderResult = z.infer<typeof CreateOrderResultSchema>;
export const CreateOrderResponseSchema = envelope(CreateOrderResultSchema);

/* ------------------------------------------------------------------ list */

export const OrderListQuerySchema = z.object({
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: OrderStatusSchema.optional(),
});
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;
export const ListOrdersResponseSchema = paginatedEnvelope(OrderSummarySchema);

/* ----------------------------------------------------------------- track */

/** One transition on the customer's status timeline (§18.1 stepper), oldest→newest. */
export const TrackTimelineEntrySchema = z.object({
  status: OrderStatusSchema,
  at: IsoDateTimeSchema,
});
export type TrackTimelineEntry = z.infer<typeof TrackTimelineEntrySchema>;

/**
 * GET /v1/orders/:id/track — drives the live-tracking screen (§3.5, §18.1) and
 * doubles as the polling fallback when the socket is down (3–5s cadence). Carries
 * the map anchors (store + destination), the assigned-driver card, the last known
 * driver ping, the status timeline, and a heuristic ETA.
 */
export const TrackOrderResultSchema = z.object({
  orderId: IdSchema,
  status: OrderStatusSchema,
  /** Pickup origin — the dark store (StoreConfig); map anchor. */
  store: LatLngSchema,
  /** Delivery destination — the order address; map anchor. */
  destination: LatLngSchema,
  /** Assigned-driver card (name/phone/vehicle); null before ASSIGNED. */
  driver: OrderDriverSchema.nullable(),
  /** Last known driver position; null before ASSIGNED or when no ping yet. */
  driverLocation: z
    .object({
      lat: LatSchema,
      lng: LngSchema,
      /** When the ping was recorded. */
      ts: IsoDateTimeSchema,
    })
    .nullable(),
  /** Status transitions for the stepper, oldest→newest. */
  timeline: z.array(TrackTimelineEntrySchema),
  /**
   * Heuristic minutes-to-doorstep from the live position (haversine ÷ avg speed);
   * null before a live ping exists or once terminal.
   */
  etaMinutes: z.number().int().nonnegative().nullable(),
});
export type TrackOrderResult = z.infer<typeof TrackOrderResultSchema>;
export const TrackOrderResponseSchema = envelope(TrackOrderResultSchema);

/* ---------------------------------------------------------------- cancel */

/** POST /v1/orders/:id/cancel — customer side of the §18.3 matrix. */
export const CancelOrderBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type CancelOrderBody = z.infer<typeof CancelOrderBodySchema>;

/** What actually happened, per the cancellation matrix. */
export const CancelOrderOutcome = {
  /** PENDING_PAYMENT/PLACED/RX_REVIEW — cancelled immediately (restock + refund). */
  CANCELLED: "CANCELLED",
  /** PACKING/READY — recorded as a request; ops must approve. */
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
} as const;
export type CancelOrderOutcome = (typeof CancelOrderOutcome)[keyof typeof CancelOrderOutcome];
export const CancelOrderOutcomeSchema = z.enum(CancelOrderOutcome);

export const CancelOrderResultSchema = z.object({
  outcome: CancelOrderOutcomeSchema,
  order: OrderSchema,
});
export type CancelOrderResult = z.infer<typeof CancelOrderResultSchema>;
export const CancelOrderResponseSchema = envelope(CancelOrderResultSchema);

/* ---------------------------------------------------------- retry payment */

/**
 * GET /v1/orders/:id/payment — re-serve the Razorpay checkout handoff for an
 * owned PREPAID order still at PENDING_PAYMENT (the customer dismissed the
 * sheet and navigated away; the cart was already consumed by the create TX).
 * Carries the SAME `razorpay` shape as create — the client reopens Checkout.js
 * with the EXISTING rzpOrderId — plus the auto-cancel deadline.
 */
export const RetryPaymentResultSchema = z.object({
  razorpay: RazorpayCheckoutSchema,
  /** When the still-unpaid order is auto-cancelled (createdAt + payment timeout, §9.3). */
  expiresAt: IsoDateTimeSchema,
});
export type RetryPaymentResult = z.infer<typeof RetryPaymentResultSchema>;
export const RetryPaymentResponseSchema = envelope(RetryPaymentResultSchema);

/* ---------------------------------------------------------- prescriptions */

/**
 * POST /v1/orders/:id/prescriptions — multipart/form-data with a single `file`
 * part (≤ RX_MAX_UPLOAD_BYTES, MIME in RX_ALLOWED_MIME_TYPES; magic-byte
 * checked and re-encoded server-side). No zod body schema — it is not JSON.
 */
export const UploadPrescriptionResponseSchema = envelope(PrescriptionSchema);

/* ---------------------------------------------------------------- invoice */

/** GET /v1/orders/:id/invoice — presigned PDF URL (private R2; short TTL). */
export const OrderInvoiceSchema = z.object({
  url: z.url(),
  /** Seconds until the presigned URL expires (typically 600). */
  expiresInSec: z.number().int().positive(),
});
export type OrderInvoice = z.infer<typeof OrderInvoiceSchema>;
export const OrderInvoiceResponseSchema = envelope(OrderInvoiceSchema);
