/**
 * Domain constants + pure rule tables from BLUEPRINT §9 (state machine, dispatch,
 * wallet, OTP), §10.3 (fraud) and §18.3 (cancellation matrix).
 *
 * The API's `stateMachine.ts` / services are the enforcement point; clients use
 * these to drive UI affordances (e.g. show/hide the Cancel button) so behavior
 * matches the server without duplicated magic numbers.
 */
import { OrderStatus } from "./enums";

/* ------------------------------------------------------------- headers */

/** Header carrying the client-generated UUID for POST /orders and POST /driver/payouts (§7.1). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** Header carrying the app's semver; `/v1/driver/*` gates on it with 426 UPGRADE_REQUIRED. */
export const APP_VERSION_HEADER = "x-app-version";

/* ------------------------------------------------------- delivery OTP */

/** Delivery OTP is 4 digits, generated at READY, visible only to the customer (§9.7). */
export const DELIVERY_OTP_LENGTH = 4;
/** Wrong-OTP attempts allowed before OTP_LOCKED (ops must unlock) (§9.7). */
export const DELIVERY_OTP_MAX_ATTEMPTS = 5;

/* ------------------------------------------------------------ dispatch */

/** Wave 1 offers go to the N nearest online+verified drivers (§9.5). */
export const DISPATCH_WAVE1_DRIVER_COUNT = 3;
/** Seconds a driver has to accept an offer before it expires (§9.5). */
export const OFFER_EXPIRES_SEC = 25;
/** Seconds after READY with no acceptance before ops is alerted (§9.5: 5 min). */
export const UNASSIGNED_ALERT_AFTER_SEC = 300;

/* ------------------------------------------------------------- payment */

/** Minutes a PREPAID order may sit in PENDING_PAYMENT before auto-cancel + stock release (§9.3). */
export const PAYMENT_TIMEOUT_MIN = 15;

/* -------------------------------------------------------------- wallet */

/** Minimum payout request: ₹500 (§9.6). Value in paise. */
export const MIN_PAYOUT_PAISE = 50_000;

/* ------------------------------------------------------------ Rx upload */

/** Max prescription upload size in bytes (5 MB, §7.2). */
export const RX_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Allowed prescription MIME types — enforced with magic-byte sniffing server-side (§10.1). */
export const RX_ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export type RxAllowedMimeType = (typeof RX_ALLOWED_MIME_TYPES)[number];

/* ---------------------------------------------------------------- FEFO */

/** Batches expiring within this many days are excluded from FEFO picking (§9.4). */
export const FEFO_MIN_SHELF_LIFE_DAYS = 30;
/** Default window for the near-expiry report (§7.2 `?days=60`). */
export const NEAR_EXPIRY_DEFAULT_DAYS = 60;

/* ------------------------------------------------- fraud & abuse (§10.3) */
/* Thresholds below are DEFAULTS — live values are AppSetting flags, tunable without deploys. */

/** COD refusals at door before COD is disabled for the user (`riskFlag=COD_BLOCKED`). */
export const COD_REFUSAL_DISABLE_THRESHOLD = 2;
/** Orders per hour (per user or per address-hash) before 429 + ops alert. */
export const MAX_ORDERS_PER_HOUR = 3;
/** First order of a new account: COD capped at ₹500 (`new_account_cod_cap`). Paise. */
export const NEW_ACCOUNT_COD_CAP_PAISE = 50_000;

/* -------------------------------------------- order state machine (§9.1) */

/**
 * Allowed status transitions (from → to[]). Actor-level rules (who may trigger
 * which edge) live in the API's `stateMachine.ts`; this table is the shape.
 *
 * Notes:
 * - COD orders are created directly as PLACED (or RX_REVIEW) — they never enter PENDING_PAYMENT.
 * - ASSIGNED → READY is the driver-cancel re-dispatch edge.
 * - DELIVERED and CANCELLED are terminal.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PLACED, OrderStatus.RX_REVIEW, OrderStatus.CANCELLED],
  [OrderStatus.PLACED]: [OrderStatus.RX_REVIEW, OrderStatus.PACKING, OrderStatus.CANCELLED],
  [OrderStatus.RX_REVIEW]: [OrderStatus.PACKING, OrderStatus.CANCELLED],
  [OrderStatus.PACKING]: [OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [OrderStatus.ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.ASSIGNED]: [OrderStatus.PICKED_UP, OrderStatus.READY, OrderStatus.CANCELLED],
  [OrderStatus.PICKED_UP]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

/** Pure check used by clients for optimistic UI; the API re-asserts inside the TX. */
export const isValidOrderTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  ORDER_STATUS_TRANSITIONS[from].includes(to);

/* ------------------------------------------- cancellation matrix (§18.3) */

/** Customer may cancel one-tap (immediate CANCELLED + restock + refund). */
export const CUSTOMER_CANCELABLE_STATUSES = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PLACED,
  OrderStatus.RX_REVIEW,
] as const;

/** Customer cancel becomes a REQUEST that ops must approve. */
export const CUSTOMER_CANCEL_REQUEST_STATUSES = [OrderStatus.PACKING, OrderStatus.READY] as const;

/**
 * Ops/Admin may cancel in any non-terminal status. ASSIGNED/PICKED_UP is
 * exceptional: driver returns items, ops restocks via CANCEL_RESTOCK.
 * DELIVERED has a refund-only path (admin) with NO auto restock.
 */
export const STAFF_CANCELABLE_STATUSES = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PLACED,
  OrderStatus.RX_REVIEW,
  OrderStatus.PACKING,
  OrderStatus.READY,
  OrderStatus.ASSIGNED,
  OrderStatus.PICKED_UP,
] as const;
