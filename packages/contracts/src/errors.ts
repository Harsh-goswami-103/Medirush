/**
 * API error codes — single source of truth (phase-0 conventions, verbatim list).
 * Clients switch on `error.code`, NEVER parse `error.message`.
 * Error envelope: `{ "error": { "code", "message", "details"? } }` (BLUEPRINT §7.1).
 */
import { z } from "zod";

export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  STOCK_INSUFFICIENT: "STOCK_INSUFFICIENT",
  OFFER_TAKEN: "OFFER_TAKEN",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  STORE_CLOSED: "STORE_CLOSED",
  OUT_OF_SERVICE_AREA: "OUT_OF_SERVICE_AREA",
  MIN_ORDER_NOT_MET: "MIN_ORDER_NOT_MET",
  COD_LIMIT_EXCEEDED: "COD_LIMIT_EXCEEDED",
  COD_DISABLED: "COD_DISABLED",
  COUPON_INVALID: "COUPON_INVALID",
  RX_REQUIRED: "RX_REQUIRED",
  OTP_INVALID: "OTP_INVALID",
  OTP_LOCKED: "OTP_LOCKED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  STORE_CONFIG_MISSING: "STORE_CONFIG_MISSING",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
export const ErrorCodeSchema = z.enum(ErrorCode);

/** The `error` object inside the envelope. */
export const ApiErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  /**
   * Optional structured context — e.g. zod issue list for VALIDATION_ERROR,
   * or `StockShortageDetail[]` for STOCK_INSUFFICIENT.
   */
  details: z.unknown().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** Full error envelope: `{ error: { code, message, details? } }`. */
export const ApiErrorSchema = z.object({
  error: ApiErrorBodySchema,
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Per-item detail entry used in STOCK_INSUFFICIENT `details` (§9.4). */
export const StockShortageDetailSchema = z.object({
  productId: z.string().min(1),
  /** Quantity the client asked for. */
  requestedQty: z.number().int().min(1),
  /** Quantity actually available at reservation time. */
  availableQty: z.number().int().min(0),
});
export type StockShortageDetail = z.infer<typeof StockShortageDetailSchema>;

/**
 * Default HTTP status per code (BLUEPRINT §7.1 status conventions).
 * The API error handler uses this map unless an `AppError` overrides it.
 * 409 = state/stock conflicts · 422 = business-rule rejections · 426 = app too old.
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STOCK_INSUFFICIENT: 409,
  OFFER_TAKEN: 409,
  INVALID_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STORE_CLOSED: 422,
  OUT_OF_SERVICE_AREA: 422,
  MIN_ORDER_NOT_MET: 422,
  COD_LIMIT_EXCEEDED: 422,
  COD_DISABLED: 422,
  COUPON_INVALID: 422,
  RX_REQUIRED: 422,
  OTP_INVALID: 422,
  OTP_LOCKED: 422,
  PAYMENT_FAILED: 422,
  UPGRADE_REQUIRED: 426,
  RATE_LIMITED: 429,
  STORE_CONFIG_MISSING: 500,
  INTERNAL: 500,
};
