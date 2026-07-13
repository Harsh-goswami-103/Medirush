/**
 * Socket.io contract (BLUEPRINT §7.3, verbatim).
 *
 * | Room          | Joined by                 | Server → Client                      | Client → Server                |
 * |---------------|---------------------------|--------------------------------------|--------------------------------|
 * | `order:{id}`  | Customer (own), Ops, Admin| `order:status`, `driver:location`    | —                              |
 * | `driver:{id}` | That driver               | `offer:new`, `offer:cancelled`       | `location:update`, `status:*`  |
 * | `ops`         | Ops/Admin                 | `order:new`, `order:update`, `alert` | —                              |
 *
 * Plus `server:restarting` broadcast to everyone on graceful shutdown (§11) —
 * clients auto-reconnect to the new instance.
 *
 * Handshake: `io(url, { auth: { token: <firebaseIdToken> } })` — verified
 * server-side; room joins are authorization-checked (a customer can only join
 * their own order rooms).
 *
 * Usage with socket.io generics:
 *   `new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(...)`
 *   `io(url) as Socket<ServerToClientEvents, ClientToServerEvents>`
 */
import { z } from "zod";
import type { Role } from "./enums";
import { OrderStatusSchema, PaymentMethodSchema, RxStatusSchema } from "./enums";
import {
  GeoPointSchema,
  IdSchema,
  IsoDateTimeSchema,
  LatSchema,
  LngSchema,
  MetersSchema,
  PaiseSchema,
} from "./schemas/common";

/* ------------------------------------------------------------------ rooms */

/** Room for one order's live updates — joined by the owning customer, ops and admin. */
export const orderRoom = (orderId: string): `order:${string}` => `order:${orderId}`;
/** Room for one driver (key = DriverProfile id, not User id). */
export const driverRoom = (driverProfileId: string): `driver:${string}` => `driver:${driverProfileId}`;
/** Shared ops/admin room. */
export const OPS_ROOM = "ops" as const;

/* -------------------------------------------------------------- handshake */

/** `socket.handshake.auth` payload — a fresh Firebase ID token. */
export const SocketAuthSchema = z.object({
  token: z.string().min(1),
});
export type SocketAuth = z.infer<typeof SocketAuthSchema>;

/* ----------------------------------------------- server → client payloads */

/** `order:status` — emitted to `order:{id}` after every committed transition (§9.1). */
export const OrderStatusEventSchema = z.object({
  orderId: IdSchema,
  status: OrderStatusSchema,
  /** When the transition was committed. */
  at: IsoDateTimeSchema,
});
export type OrderStatusEvent = z.infer<typeof OrderStatusEventSchema>;

/** `driver:location` — throttled live position, emitted to `order:{id}` while ASSIGNED/PICKED_UP. */
export const DriverLocationEventSchema = z.object({
  orderId: IdSchema,
  lat: LatSchema,
  lng: LngSchema,
  /** Device capture time of the ping. */
  ts: IsoDateTimeSchema,
});
export type DriverLocationEvent = z.infer<typeof DriverLocationEventSchema>;

/** `offer:new` — emitted to `driver:{id}` (paired with an FCM push). */
export const OfferNewEventSchema = z.object({
  offerId: IdSchema,
  orderId: IdSchema,
  /** Store pickup point. */
  pickup: GeoPointSchema,
  /** Customer drop point. */
  drop: GeoPointSchema,
  distanceM: MetersSchema,
  /** Earnings shown upfront, paise. */
  commissionPaise: PaiseSchema,
  /** Countdown seconds (25 by default — OFFER_EXPIRES_SEC). */
  expiresInSec: z.number().int().positive(),
});
export type OfferNewEvent = z.infer<typeof OfferNewEventSchema>;

/** `offer:cancelled` — offer expired or another driver won; dismiss the modal. */
export const OfferCancelledEventSchema = z.object({
  offerId: IdSchema,
  orderId: IdSchema,
});
export type OfferCancelledEvent = z.infer<typeof OfferCancelledEventSchema>;

/** `order:new` — new order landed on the ops board (play the sound). */
export const OrderNewEventSchema = z.object({
  orderId: IdSchema,
  orderNo: z.string(),
  status: OrderStatusSchema,
  paymentMethod: PaymentMethodSchema,
  requiresRx: z.boolean(),
  rxStatus: RxStatusSchema,
  totalPaise: PaiseSchema,
  placedAt: IsoDateTimeSchema,
});
export type OrderNewEvent = z.infer<typeof OrderNewEventSchema>;

/** `order:update` — any status/rx change; ops boards re-fetch or patch the row. */
export const OrderUpdateEventSchema = z.object({
  orderId: IdSchema,
  orderNo: z.string(),
  status: OrderStatusSchema,
  rxStatus: RxStatusSchema,
  at: IsoDateTimeSchema,
});
export type OrderUpdateEvent = z.infer<typeof OrderUpdateEventSchema>;

/** Known `alert.kind` values (open set — always handle unknown kinds generically). */
export const AlertKind = {
  /** Order stuck past a watchdog threshold (PLACED>10m, READY>7m, PICKED_UP>40m). */
  STUCK_ORDER: "STUCK_ORDER",
  /** 5 min unassigned after READY — assign manually / call a driver (§9.5). */
  UNASSIGNED_ORDER: "UNASSIGNED_ORDER",
  /** Fraud velocity rule tripped (§10.3). */
  FRAUD_VELOCITY: "FRAUD_VELOCITY",
  /** Nightly wallet ledger drift detected (§9.6). */
  WALLET_DRIFT: "WALLET_DRIFT",
  /** Nightly encrypted DB backup failed (§11/§24) — investigate before the next window. */
  DB_BACKUP_FAILED: "DB_BACKUP_FAILED",
  /** Automated refund could not be executed — ops must refund by hand (§18.3). */
  MANUAL_REFUND_REQUIRED: "MANUAL_REFUND_REQUIRED",
  GENERIC: "GENERIC",
} as const;
export type AlertKind = (typeof AlertKind)[keyof typeof AlertKind];

/** `alert` — ops room banner/toast. */
export const AlertEventSchema = z.object({
  kind: z.string(),
  msg: z.string(),
  /** Optional entity reference (usually an orderId). */
  refId: IdSchema.optional(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

/* ----------------------------------------------- client → server payloads */

/**
 * `location:update` — driver position ping; accepted only while the driver has
 * an active delivery (ASSIGNED/PICKED_UP). Held in memory server-side (§11).
 */
export const LocationUpdateEventSchema = z.object({
  lat: LatSchema,
  lng: LngSchema,
  /** Optional device capture time; server time is used when omitted. */
  ts: IsoDateTimeSchema.optional(),
});
export type LocationUpdateEvent = z.infer<typeof LocationUpdateEventSchema>;

/* ------------------------------------------------------- socket.io generics */

export interface ServerToClientEvents {
  "order:status": (payload: OrderStatusEvent) => void;
  "driver:location": (payload: DriverLocationEvent) => void;
  "offer:new": (payload: OfferNewEvent) => void;
  "offer:cancelled": (payload: OfferCancelledEvent) => void;
  "order:new": (payload: OrderNewEvent) => void;
  "order:update": (payload: OrderUpdateEvent) => void;
  alert: (payload: AlertEvent) => void;
  /** Graceful shutdown broadcast (§11) — reconnect with backoff; no payload. */
  "server:restarting": () => void;
}

export interface ClientToServerEvents {
  "location:update": (payload: LocationUpdateEvent) => void;
  /** Driver duty toggle mirrors of PATCH /v1/driver/status; no payload. */
  "status:online": () => void;
  "status:offline": () => void;
}

/** No server-to-server events in v1 (single instance; Redis adapter is the scale path). */
export type InterServerEvents = Record<string, never>;

/** Per-connection data attached after handshake verification. */
export interface SocketData {
  userId: string;
  role: Role;
  /** Present only for DRIVER connections. */
  driverProfileId?: string;
}
