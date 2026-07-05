/**
 * Shared primitives used across all endpoint schemas.
 *
 * Conventions (binding, phase-0 brief):
 * - Money = integer paise, quantities = int, distance = int meters. No floats near money.
 * - Timestamps = ISO-8601 UTC strings.
 * - IDs = cuid strings, validated loosely (`min(1)` — do not over-pin the format).
 * - Envelope: success `{ data, meta? }` · error `{ error: { code, message, details? } }`.
 * - Pagination: `?cursor=<id>&limit=20` (1–50, default 20) → `meta: { nextCursor }`.
 */
import { z } from "zod";

/* ------------------------------------------------------------ scalars */

/** cuid primary key. Loose validation per conventions. */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** Money in integer paise (₹1 = 100 paise). Always non-negative on the wire. */
export const PaiseSchema = z.number().int().min(0);
export type Paise = z.infer<typeof PaiseSchema>;

/** Distance in integer meters. */
export const MetersSchema = z.number().int().min(0);

/** Non-negative integer count. */
export const CountSchema = z.number().int().min(0);

/** Positive integer quantity (≥ 1). */
export const QtySchema = z.number().int().min(1);

/** E.164 phone, e.g. `+919876543210`. */
export const PhoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, "must be E.164, e.g. +919876543210");

/** ISO-8601 UTC datetime string, e.g. `2026-07-05T09:30:00.000Z`. Clients render IST. */
export const IsoDateTimeSchema = z.iso.datetime();

/** ISO calendar date `YYYY-MM-DD` (expiry dates, report ranges). */
export const IsoDateSchema = z.iso.date();

/** Indian PIN code (6 digits, no leading zero). */
export const PincodeSchema = z.string().regex(/^[1-9]\d{5}$/);

/** URL-safe slug: lowercase alphanumerics separated by single hyphens. */
export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** Semver `MAJOR.MINOR.PATCH` (min-app-version gate, §7.1). */
export const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** 4-digit delivery OTP (§9.7). */
export const OtpSchema = z.string().regex(/^\d{4}$/);

/** Store hours wall-clock `HH:mm` (IST, 24h). */
export const TimeHHMMSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** GST rate percent — only these slabs exist for our catalog (§6.2). */
export const GstRateSchema = z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18)]);
export type GstRate = z.infer<typeof GstRateSchema>;

/* ---------------------------------------------------------------- geo */

export const LatSchema = z.number().min(-90).max(90);
export const LngSchema = z.number().min(-180).max(180);

export const LatLngSchema = z.object({
  lat: LatSchema,
  lng: LngSchema,
});
export type LatLng = z.infer<typeof LatLngSchema>;

/** Geo point with a human-readable address line (offer pickup/drop, active delivery). */
export const GeoPointSchema = LatLngSchema.extend({
  address: z.string(),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

/* --------------------------------------------------------- pagination */

/**
 * Cursor pagination query. `cursor` is the id of the last item of the previous
 * page (opaque to clients); `limit` is coerced from the query string.
 */
export const CursorQuerySchema = z.object({
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export const PaginationMetaSchema = z.object({
  /** id to pass as `?cursor=` for the next page; `null` when no more pages. */
  nextCursor: z.string().nullable(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

/* ------------------------------------------------------------ envelope */

/** Success envelope: `{ data: <shape> }`. */
export const envelope = <T extends z.ZodType>(dataSchema: T) => z.object({ data: dataSchema });

/** Success envelope with custom meta: `{ data, meta }`. */
export const envelopeWithMeta = <D extends z.ZodType, M extends z.ZodType>(
  dataSchema: D,
  metaSchema: M,
) => z.object({ data: dataSchema, meta: metaSchema });

/** Cursor-paginated list envelope: `{ data: T[], meta: { nextCursor } }`. */
export const paginatedEnvelope = <T extends z.ZodType>(itemSchema: T) =>
  z.object({ data: z.array(itemSchema), meta: PaginationMetaSchema });

/** Minimal acknowledgement payload for actions with no meaningful return entity. */
export const OkSchema = z.object({ ok: z.literal(true) });
export const AckResponseSchema = envelope(OkSchema);
export type AckResponse = z.infer<typeof AckResponseSchema>;

/* --------------------------------------------------------------- params */

/** `/:id` route params. */
export const IdParamsSchema = z.object({ id: IdSchema });
export type IdParams = z.infer<typeof IdParamsSchema>;
