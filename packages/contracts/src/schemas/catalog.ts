/**
 * Public store / catalog / serviceability endpoints (BLUEPRINT §7.2 — ⭘ public).
 *
 * | Endpoint                              | Body / Query / Params        | Response data                |
 * |---------------------------------------|------------------------------|------------------------------|
 * | GET  /v1/store                        | —                            | StoreInfoSchema              |
 * | GET  /v1/categories                   | —                            | CategorySchema[]             |
 * | GET  /v1/products                     | ProductListQuerySchema       | ProductSummarySchema[] + meta|
 * | GET  /v1/products/:slug               | ProductParamsSchema          | ProductSchema                |
 * | GET  /v1/products/:slug/substitutes   | ProductParamsSchema          | ProductSummarySchema[]       |
 * | POST /v1/serviceability               | ServiceabilityBodySchema     | ServiceabilityResultSchema   |
 * | POST /v1/products/:slug/stock-alert   | ProductParamsSchema (auth)   | StockAlertStatusSchema       |
 * | GET  /v1/products/:slug/stock-alert   | ProductParamsSchema (auth)   | StockAlertStatusSchema       |
 * | DELETE /v1/products/:slug/stock-alert | ProductParamsSchema (auth)   | StockAlertStatusSchema       |
 */
import { z } from "zod";
import { ScheduleClassSchema } from "../enums";
import {
  CursorQuerySchema,
  GstRateSchema,
  IdSchema,
  LatLngSchema,
  LatSchema,
  LngSchema,
  MetersSchema,
  PaiseSchema,
  QtySchema,
  SemverSchema,
  SlugSchema,
  TimeHHMMSchema,
  envelope,
  paginatedEnvelope,
} from "./common";

/* ------------------------------------------------------------ GET /store */

/**
 * Client feature flags served with the store payload (from `AppSetting` rows).
 * `codEnabled` is always present; additional flags may appear over time —
 * clients must ignore unknown keys.
 */
export const StoreFeatureFlagsSchema = z
  .object({
    codEnabled: z.boolean(),
  })
  .catchall(z.union([z.boolean(), z.number(), z.string()]));
export type StoreFeatureFlags = z.infer<typeof StoreFeatureFlagsSchema>;

/**
 * GET /v1/store — everything a client needs before checkout, plus the
 * regulatory identity that must be displayed in-app (§10.2) and the min-app
 * -version gate values (§7.1).
 */
export const StoreInfoSchema = z.object({
  name: z.string(),
  address: z.string(),
  lat: LatSchema,
  lng: LngSchema,
  /** Delivery radius in meters from the store point. */
  serviceRadiusM: MetersSchema,
  /** Manual kill-switch — when false, checkout is blocked (STORE_CLOSED). */
  isOpen: z.boolean(),
  /** IST wall-clock `HH:mm`. */
  openTime: TimeHHMMSchema,
  closeTime: TimeHHMMSchema,
  minOrderPaise: PaiseSchema,
  deliveryBasePaise: PaiseSchema,
  /** Order item total at/above which delivery is free. */
  freeDeliveryAbovePaise: PaiseSchema,
  /** Max order total allowed for COD. */
  codLimitPaise: PaiseSchema,
  supportPhone: z.string(),
  /** 426 UPGRADE_REQUIRED gate values. */
  minCustomerAppVersion: SemverSchema,
  minDriverAppVersion: SemverSchema,
  featureFlags: StoreFeatureFlagsSchema,
  /* Regulatory display (app footer + invoices, §10.2). */
  drugLicenseNo: z.string().nullable(),
  pharmacistName: z.string().nullable(),
  pharmacistRegNo: z.string().nullable(),
  gstin: z.string().nullable(),
  fssaiNo: z.string().nullable(),
});
export type StoreInfo = z.infer<typeof StoreInfoSchema>;
export const GetStoreResponseSchema = envelope(StoreInfoSchema);

/* ------------------------------------------------------- GET /categories */

/** Active categories only; sorted by `sortOrder`. */
export const CategorySchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  /** Public CDN URL (raw R2 keys are never exposed). */
  imageUrl: z.url().nullable(),
  sortOrder: z.number().int(),
});
export type Category = z.infer<typeof CategorySchema>;
export const ListCategoriesResponseSchema = envelope(z.array(CategorySchema));

/* --------------------------------------------------------- GET /products */

/**
 * Customer-safe product card (list view).
 * Internal fields (binLocation, barcode, searchKeywords, lowStockThreshold,
 * costs, raw stockQty) are ops-only — see inventory.ts `OpsProductSchema`.
 */
export const ProductSummarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  brand: z.string().nullable(),
  /** e.g. "Strip of 10", "200ml". */
  packSize: z.string(),
  /** Maximum retail price (strike-through display). */
  mrpPaise: PaiseSchema,
  /** Selling price ≤ MRP (legal requirement). GST-inclusive (§9.2). */
  pricePaise: PaiseSchema,
  /** First product image as a public CDN URL; null when no images. */
  imageUrl: z.url().nullable(),
  requiresRx: z.boolean(),
  scheduleClass: ScheduleClassSchema,
  isColdChain: z.boolean(),
  /** Availability flag only — exact stock counts are not exposed to customers. */
  inStock: z.boolean(),
  /** Per-order quantity cap. */
  maxPerOrder: QtySchema,
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

/**
 * Structured medical information (§17 PDP). Pharmacist-authored free text;
 * empty string means "not documented" and the client hides that section.
 */
export const ProductMedicalInfoSchema = z.object({
  uses: z.string(),
  directions: z.string(),
  sideEffects: z.string(),
  storageInfo: z.string(),
  warnings: z.string(),
  manufacturer: z.string().nullable(),
});
export type ProductMedicalInfo = z.infer<typeof ProductMedicalInfoSchema>;

/** Full product detail (GET /v1/products/:slug). */
export const ProductSchema = ProductSummarySchema.extend({
  description: z.string(),
  categoryId: IdSchema,
  /** All images as public CDN URLs. */
  images: z.array(z.url()),
  /** Salt + strength, e.g. "Paracetamol 650mg". */
  composition: z.string(),
  /** GST-inclusive pricing; rate shown for transparency/invoice preview. */
  gstRatePct: GstRateSchema,
}).extend(ProductMedicalInfoSchema.shape);
export type Product = z.infer<typeof ProductSchema>;

/* -------------------------------------------------- health-concern browse */

/** "Shop by health concern" — fever, cold & cough, diabetes care, … */
export const HealthConcernSchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  imageUrl: z.url().nullable(),
  sortOrder: z.number().int(),
});
export type HealthConcern = z.infer<typeof HealthConcernSchema>;
export const ListHealthConcernsResponseSchema = envelope(z.array(HealthConcernSchema));
export const ConcernParamsSchema = z.object({ slug: SlugSchema });

/**
 * Tri-state boolean query param. Unset → no filter; `"true"`/`"1"` → true;
 * anything else → false. NOT `z.coerce.boolean()` — `Boolean("false") === true`.
 */
const TriStateBoolQuery = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));

/** Sort orders beyond the default id-keyset listing. */
export const ProductSortSchema = z.enum(["price_asc", "price_desc", "discount", "name"]);
export type ProductSort = z.infer<typeof ProductSortSchema>;

/**
 * GET /v1/products?category&search&cursor&limit&sort&inStock&requiresRx&minPricePaise&maxPricePaise&discounted
 * — search is pg_trgm fuzzy (word similarity). Filters compose with category
 * AND search. `sort` (like `search`) returns top-N only — `nextCursor` is null
 * because the keyset cursor is id-ordered (documented simplification).
 */
export const ProductListQuerySchema = CursorQuerySchema.extend({
  /** Category slug filter. */
  category: SlugSchema.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  /** Health-concern slug filter (shop-by-concern browse). */
  concern: SlugSchema.optional(),
  sort: ProductSortSchema.optional(),
  /** true → only in-stock; false → only out-of-stock (rarely useful). */
  inStock: TriStateBoolQuery,
  /** true → Rx-only; false → OTC-only. */
  requiresRx: TriStateBoolQuery,
  /** Selling-price band, inclusive, in paise. */
  minPricePaise: z.coerce.number().int().nonnegative().optional(),
  maxPricePaise: z.coerce.number().int().nonnegative().optional(),
  /** true → only discounted (price < MRP). */
  discounted: TriStateBoolQuery,
});
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;
export const ProductListResponseSchema = paginatedEnvelope(ProductSummarySchema);

export const ProductParamsSchema = z.object({ slug: SlugSchema });
export type ProductParams = z.infer<typeof ProductParamsSchema>;
export const GetProductResponseSchema = envelope(ProductSchema);

/**
 * GET /v1/products/:slug/substitutes — same-composition alternatives (§17 v1.1
 * "substitutes suggestions"): active products whose normalized `composition`
 * matches, Rx-parity enforced, in-stock first then price ASC, self excluded.
 */
export const ListSubstitutesResponseSchema = envelope(z.array(ProductSummarySchema));

/** Back-in-stock alert state for the calling customer on one product. */
export const StockAlertStatusSchema = z.object({ subscribed: z.boolean() });
export type StockAlertStatus = z.infer<typeof StockAlertStatusSchema>;
export const StockAlertResponseSchema = envelope(StockAlertStatusSchema);

/* -------------------------------------------------- POST /serviceability */

/** POST /v1/serviceability — `{lat,lng}` → in-radius? fee? */
export const ServiceabilityBodySchema = LatLngSchema;
export type ServiceabilityBody = z.infer<typeof ServiceabilityBodySchema>;

export const ServiceabilityResultSchema = z.object({
  serviceable: z.boolean(),
  /** Haversine store→point distance in meters. */
  distanceM: MetersSchema,
  /**
   * Base delivery fee for this point in paise; `null` when not serviceable.
   * Free-delivery threshold is applied at checkout, not here.
   */
  deliveryPaise: PaiseSchema.nullable(),
});
export type ServiceabilityResult = z.infer<typeof ServiceabilityResultSchema>;
export const ServiceabilityResponseSchema = envelope(ServiceabilityResultSchema);

/* ----------------------------------------------------------- misc reuse */

/** Small product ref reused by cart/order lists. */
export const ProductRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  imageUrl: z.url().nullable(),
});
export type ProductRef = z.infer<typeof ProductRefSchema>;
