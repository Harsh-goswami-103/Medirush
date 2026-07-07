/**
 * Ops endpoints (BLUEPRINT §7.2 — role INVENTORY or ADMIN).
 *
 * | Endpoint                                  | Body / Query / Params        | Response data                 |
 * |-------------------------------------------|------------------------------|-------------------------------|
 * | GET    /v1/ops/orders                     | OpsOrderListQuerySchema      | OpsOrderSummarySchema[] + meta|
 * | GET    /v1/ops/orders/:id                 | IdParams                     | OpsOrderDetailSchema          |
 * | POST   /v1/ops/orders/:id/rx-review       | RxReviewBodySchema           | OpsOrderDetailSchema          |
 * | POST   /v1/ops/orders/:id/start-packing   | IdParams                     | OpsOrderDetailSchema          |
 * | POST   /v1/ops/orders/:id/ready           | ReadyBodySchema              | OpsOrderDetailSchema          |
 * | POST   /v1/ops/orders/:id/cancel          | OpsCancelOrderBodySchema     | OpsOrderDetailSchema          |
 * | GET    /v1/ops/products                   | OpsProductListQuerySchema    | OpsProductSchema[] + meta     |
 * | POST   /v1/ops/products                   | CreateProductBodySchema      | OpsProductSchema              |
 * | GET    /v1/ops/products/:id               | IdParams                     | OpsProductSchema              |
 * | PATCH  /v1/ops/products/:id               | UpdateProductBodySchema      | OpsProductSchema              |
 * | DELETE /v1/ops/products/:id               | IdParams (soft-deactivate)   | OkSchema                      |
 * | GET    /v1/ops/categories                 | —                            | OpsCategorySchema[]           |
 * | POST   /v1/ops/categories                 | CreateCategoryBodySchema     | OpsCategorySchema             |
 * | PATCH  /v1/ops/categories/:id             | UpdateCategoryBodySchema     | OpsCategorySchema             |
 * | DELETE /v1/ops/categories/:id             | IdParams (soft-deactivate)   | OkSchema                      |
 * | POST   /v1/ops/products/:id/batches       | CreateBatchBodySchema (GRN)  | CreateBatchResultSchema       |
 * | POST   /v1/ops/stock/adjust               | StockAdjustBodySchema        | StockAdjustResultSchema       |
 * | GET    /v1/ops/stock/low                  | —                            | LowStockItemSchema[]          |
 * | GET    /v1/ops/stock/near-expiry          | NearExpiryQuerySchema        | NearExpiryItemSchema[]        |
 */
import { z } from "zod";
import {
  AdjustReason,
  OrderStatusSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  RxStatus,
  RxStatusSchema,
  ScheduleClassSchema,
} from "../enums";
import {
  CountSchema,
  CursorQuerySchema,
  GstRateSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  OkSchema,
  PaiseSchema,
  PhoneSchema,
  QtySchema,
  SlugSchema,
  envelope,
  paginatedEnvelope,
} from "./common";
import { OrderEventSchema, OrderItemSchema, OrderSchema } from "./order";

/* ---------------------------------------------------------- order queue */

/** Row on the live order board (New / Rx queue / Packing / Ready). */
export const OpsOrderSummarySchema = z.object({
  id: IdSchema,
  orderNo: z.string(),
  status: OrderStatusSchema,
  paymentMethod: PaymentMethodSchema,
  paymentStatus: PaymentStatusSchema,
  requiresRx: z.boolean(),
  rxStatus: RxStatusSchema,
  totalPaise: PaiseSchema,
  itemCount: CountSchema,
  customerName: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  placedAt: IsoDateTimeSchema.nullable(),
  readyAt: IsoDateTimeSchema.nullable(),
});
export type OpsOrderSummary = z.infer<typeof OpsOrderSummarySchema>;

/** GET /v1/ops/orders?status&cursor */
export const OpsOrderListQuerySchema = CursorQuerySchema.extend({
  status: OrderStatusSchema.optional(),
});
export type OpsOrderListQuery = z.infer<typeof OpsOrderListQuerySchema>;
export const OpsListOrdersResponseSchema = paginatedEnvelope(OpsOrderSummarySchema);

/* ---------------------------------------------------------- order detail */

/** Batch allocation snapshot on an order item (traceability + H1 register). */
export const ItemBatchAllocSchema = z.object({
  batchId: IdSchema,
  batchNoSnap: z.string(),
  /** Batch expiry, calendar date. */
  expirySnap: IsoDateSchema,
  qty: QtySchema,
});
export type ItemBatchAlloc = z.infer<typeof ItemBatchAllocSchema>;

/** Server-proposed FEFO pick (expiry ASC, excluding batches expiring < 30d, §9.4). */
export const FefoSuggestionSchema = z.object({
  batchId: IdSchema,
  batchNo: z.string(),
  expiryDate: IsoDateSchema,
  /** Units available in this batch right now. */
  qtyAvailable: CountSchema,
  /** Units the server suggests pulling from this batch. */
  qty: QtySchema,
});
export type FefoSuggestion = z.infer<typeof FefoSuggestionSchema>;

/** Order line enriched for the packing screen. */
export const OpsOrderItemSchema = OrderItemSchema.extend({
  /** Shelf address, e.g. "R2-S3" — packing speed. */
  binLocation: z.string(),
  /** Confirmed allocations (set at READY); empty until then. */
  allocations: z.array(ItemBatchAllocSchema),
  /** Pre-filled FEFO proposal for the ready dialog; empty once allocated. */
  fefoSuggestions: z.array(FefoSuggestionSchema),
});
export type OpsOrderItem = z.infer<typeof OpsOrderItemSchema>;

/**
 * Ops view of a prescription. `fileUrl` is a short-TTL (~10 min) presigned GET
 * on the private R2 bucket — the raw R2 key is never part of the contract.
 */
export const OpsPrescriptionSchema = z.object({
  id: IdSchema,
  status: RxStatusSchema,
  mimeType: z.string(),
  /** Presigned URL for the zoomable viewer; re-fetch the order when expired. */
  fileUrl: z.url(),
  patientName: z.string().nullable(),
  doctorName: z.string().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema.nullable(),
});
export type OpsPrescription = z.infer<typeof OpsPrescriptionSchema>;

/** Delivery/driver block on the ops order detail. */
export const OpsDeliveryInfoSchema = z.object({
  driverId: IdSchema,
  driverName: z.string().nullable(),
  driverPhone: PhoneSchema,
  acceptedAt: IsoDateTimeSchema,
  pickedUpAt: IsoDateTimeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  codCollectedPaise: PaiseSchema.nullable(),
});
export type OpsDeliveryInfo = z.infer<typeof OpsDeliveryInfoSchema>;

/**
 * GET /v1/ops/orders/:id — full working detail. Note: `deliveryOtp` is NOT
 * exposed to ops (customer-only, §9.7); the packing slip is OTP-less.
 */
export const OpsOrderDetailSchema = OrderSchema.omit({
  items: true,
  deliveryOtp: true,
}).extend({
  customer: z.object({
    id: IdSchema,
    name: z.string().nullable(),
    phone: PhoneSchema,
  }),
  items: z.array(OpsOrderItemSchema),
  prescriptions: z.array(OpsPrescriptionSchema),
  events: z.array(OrderEventSchema),
  /** Null until a driver accepts. */
  delivery: OpsDeliveryInfoSchema.nullable(),
  /**
   * True when the customer requested cancellation of a PACKING/READY order
   * (§18.3) — derived from the order events; ops must approve/deny.
   */
  cancelRequested: z.boolean(),
});
export type OpsOrderDetail = z.infer<typeof OpsOrderDetailSchema>;
export const GetOpsOrderResponseSchema = envelope(OpsOrderDetailSchema);

/* --------------------------------------------------------- order actions */

/**
 * POST /v1/ops/orders/:id/rx-review.
 * REJECTED auto-cancels the order (+refund +restock, §9.1), so the wire
 * contract requires a non-empty `note` explaining why — the reason is recorded
 * on the order and shown to the customer. `patientName`/`doctorName` feed the
 * Schedule H1 register — capture them on approval of H1 items.
 */
export const RxReviewBodySchema = z
  .object({
    status: z.enum([RxStatus.APPROVED, RxStatus.REJECTED]),
    note: z.string().trim().min(1).max(500).optional(),
    patientName: z.string().trim().min(1).max(100).optional(),
    doctorName: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.status === RxStatus.REJECTED && body.note === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "note is required when rejecting a prescription",
      });
    }
  });
export type RxReviewBody = z.infer<typeof RxReviewBodySchema>;
export const RxReviewResponseSchema = envelope(OpsOrderDetailSchema);

/** POST /v1/ops/orders/:id/start-packing — PLACED/RX_REVIEW(approved) → PACKING. No body. */
export const StartPackingResponseSchema = envelope(OpsOrderDetailSchema);

/** One confirmed allocation line for the ready action. */
export const ReadyAllocationSchema = z.object({
  orderItemId: IdSchema,
  batchId: IdSchema,
  qty: QtySchema,
});
export type ReadyAllocation = z.infer<typeof ReadyAllocationSchema>;

/**
 * POST /v1/ops/orders/:id/ready — PACKING → READY. Allocations start from the
 * FEFO pre-fill; the pharmacist may edit. Σ qty per orderItem must equal the
 * item qty (server-verified); batch `qtyAvailable` is decremented conditionally.
 */
export const ReadyBodySchema = z.object({
  allocations: z.array(ReadyAllocationSchema).min(1),
});
export type ReadyBody = z.infer<typeof ReadyBodySchema>;
export const ReadyResponseSchema = envelope(OpsOrderDetailSchema);

/** POST /v1/ops/orders/:id/cancel — triggers refund + restock per §18.3. */
export const OpsCancelOrderBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type OpsCancelOrderBody = z.infer<typeof OpsCancelOrderBodySchema>;
export const OpsCancelOrderResponseSchema = envelope(OpsOrderDetailSchema);

/* -------------------------------------------------------- products CRUD */

/** Full ops/admin product view — includes internal fields hidden from customers. */
export const OpsProductSchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  brand: z.string().nullable(),
  description: z.string(),
  categoryId: IdSchema,
  /** Public CDN URLs (upload pipeline stores to R2 and returns the CDN URL). */
  images: z.array(z.url()),
  mrpPaise: PaiseSchema,
  /** Selling price ≤ MRP (legal requirement, server-enforced). */
  pricePaise: PaiseSchema,
  gstRatePct: GstRateSchema,
  hsnCode: z.string().nullable(),
  packSize: z.string(),
  composition: z.string(),
  /** Shelf address, e.g. "R2-S3". */
  binLocation: z.string(),
  /** EAN-13, captured at catalog entry. */
  barcode: z.string().nullable(),
  requiresRx: z.boolean(),
  scheduleClass: ScheduleClassSchema,
  isColdChain: z.boolean(),
  /** Cached stock count; batches are the truth. */
  stockQty: CountSchema,
  lowStockThreshold: CountSchema,
  maxPerOrder: QtySchema,
  /** Generic/salt names to boost fuzzy search. */
  searchKeywords: z.string(),
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type OpsProduct = z.infer<typeof OpsProductSchema>;

const productBodyBase = z.object({
  name: z.string().trim().min(1).max(200),
  /** Server generates from name when omitted. */
  slug: SlugSchema.optional(),
  brand: z.string().trim().max(100).optional(),
  description: z.string().max(5000).optional(),
  categoryId: IdSchema,
  images: z.array(z.url()).max(8).optional(),
  mrpPaise: PaiseSchema.min(1),
  pricePaise: PaiseSchema.min(1),
  gstRatePct: GstRateSchema,
  hsnCode: z.string().trim().max(20).optional(),
  packSize: z.string().trim().min(1).max(50),
  composition: z.string().trim().max(500).optional(),
  binLocation: z.string().trim().max(20).optional(),
  /** EAN-8..EAN-14 digits. */
  barcode: z.string().regex(/^\d{8,14}$/).optional(),
  requiresRx: z.boolean().optional(),
  scheduleClass: ScheduleClassSchema.optional(),
  isColdChain: z.boolean().optional(),
  lowStockThreshold: CountSchema.optional(),
  maxPerOrder: QtySchema.optional(),
  searchKeywords: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
});

/** POST /v1/ops/products */
export const CreateProductBodySchema = productBodyBase.refine(
  (b) => b.pricePaise <= b.mrpPaise,
  { message: "pricePaise must be ≤ mrpPaise (legal requirement)", path: ["pricePaise"] },
);
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;
export const CreateProductResponseSchema = envelope(OpsProductSchema);

/** PATCH /v1/ops/products/:id — price ≤ MRP re-checked server-side against merged values. */
export const UpdateProductBodySchema = productBodyBase.partial();
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;
export const UpdateProductResponseSchema = envelope(OpsProductSchema);

/** GET /v1/ops/products */
export const OpsProductListQuerySchema = CursorQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
  /** Category slug filter. */
  category: SlugSchema.optional(),
  /** "true"/"false" in the query string. */
  isActive: z.stringbool().optional(),
});
export type OpsProductListQuery = z.infer<typeof OpsProductListQuerySchema>;
export const OpsListProductsResponseSchema = paginatedEnvelope(OpsProductSchema);
export const GetOpsProductResponseSchema = envelope(OpsProductSchema);

/** DELETE /v1/ops/products/:id — soft-deactivate (order history references must survive). */
export const DeleteProductResponseSchema = envelope(OkSchema);

/* ------------------------------------------------------ categories CRUD */

export const OpsCategorySchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: SlugSchema,
  imageUrl: z.url().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type OpsCategory = z.infer<typeof OpsCategorySchema>;

export const OpsListCategoriesResponseSchema = envelope(z.array(OpsCategorySchema));

/** POST /v1/ops/categories */
export const CreateCategoryBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Server generates from name when omitted. */
  slug: SlugSchema.optional(),
  imageUrl: z.url().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;
export const CreateCategoryResponseSchema = envelope(OpsCategorySchema);

/** PATCH /v1/ops/categories/:id */
export const UpdateCategoryBodySchema = CreateCategoryBodySchema.partial();
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBodySchema>;
export const UpdateCategoryResponseSchema = envelope(OpsCategorySchema);

/** DELETE /v1/ops/categories/:id — soft-deactivate. */
export const DeleteCategoryResponseSchema = envelope(OkSchema);

/* ------------------------------------------------------------ GRN batches */

export const BatchSchema = z.object({
  id: IdSchema,
  productId: IdSchema,
  batchNo: z.string(),
  expiryDate: IsoDateSchema,
  qtyReceived: QtySchema,
  qtyAvailable: CountSchema,
  /** Purchase cost per unit, paise. */
  costPaise: PaiseSchema,
  wholesaler: z.string(),
  /** Wholesaler bill number — inspection-critical. */
  invoiceNo: z.string(),
  receivedAt: IsoDateTimeSchema,
});
export type Batch = z.infer<typeof BatchSchema>;

/**
 * POST /v1/ops/products/:id/batches — GRN (goods received). Creates the batch,
 * bumps the product stock cache and writes a `RECEIVED` StockAdjustment.
 * (productId comes from the route param.)
 */
export const CreateBatchBodySchema = z.object({
  batchNo: z.string().trim().min(1).max(50),
  /** Must be in the future (server-enforced). */
  expiryDate: IsoDateSchema,
  qtyReceived: QtySchema,
  /** Purchase cost per unit, paise. */
  costPaise: PaiseSchema.min(1),
  wholesaler: z.string().trim().min(1).max(100),
  invoiceNo: z.string().trim().min(1).max(50),
});
export type CreateBatchBody = z.infer<typeof CreateBatchBodySchema>;

export const CreateBatchResultSchema = z.object({
  batch: BatchSchema,
  /** Updated stock cache after the GRN. */
  product: z.object({ id: IdSchema, stockQty: CountSchema }),
});
export type CreateBatchResult = z.infer<typeof CreateBatchResultSchema>;
export const CreateBatchResponseSchema = envelope(CreateBatchResultSchema);

/* --------------------------------------------------------- stock adjust */

/** Manual adjust reasons — RECEIVED/SALE/CANCEL_RESTOCK are system-written, never manual. */
export const ManualAdjustReasonSchema = z.enum([
  AdjustReason.RETURN,
  AdjustReason.DAMAGE,
  AdjustReason.EXPIRY,
  AdjustReason.CORRECTION,
]);
export type ManualAdjustReason = z.infer<typeof ManualAdjustReasonSchema>;

/** POST /v1/ops/stock/adjust */
export const StockAdjustBodySchema = z.object({
  productId: IdSchema,
  /** Optional: also decrement a specific batch's qtyAvailable. */
  batchId: IdSchema.optional(),
  /** Signed units; must not be 0. Stock can never go negative (DB CHECK). */
  delta: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: "delta must not be 0" }),
  reason: ManualAdjustReasonSchema,
  note: z.string().trim().max(500).optional(),
});
export type StockAdjustBody = z.infer<typeof StockAdjustBodySchema>;

export const StockAdjustResultSchema = z.object({
  adjustmentId: IdSchema,
  productId: IdSchema,
  /** Stock cache after the adjustment. */
  stockQty: CountSchema,
});
export type StockAdjustResult = z.infer<typeof StockAdjustResultSchema>;
export const StockAdjustResponseSchema = envelope(StockAdjustResultSchema);

/* ---------------------------------------------------------------- alerts */

/** GET /v1/ops/stock/low — products at/below their lowStockThreshold. */
export const LowStockItemSchema = z.object({
  productId: IdSchema,
  name: z.string(),
  stockQty: CountSchema,
  lowStockThreshold: CountSchema,
  binLocation: z.string(),
});
export type LowStockItem = z.infer<typeof LowStockItemSchema>;
export const LowStockResponseSchema = envelope(z.array(LowStockItemSchema));

/** GET /v1/ops/stock/near-expiry?days=60 */
export const NearExpiryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(60),
});
export type NearExpiryQuery = z.infer<typeof NearExpiryQuerySchema>;

export const NearExpiryItemSchema = z.object({
  batchId: IdSchema,
  productId: IdSchema,
  productName: z.string(),
  batchNo: z.string(),
  expiryDate: IsoDateSchema,
  qtyAvailable: CountSchema,
  /** Whole days from today (IST) to expiry; can be negative if already expired. */
  daysToExpiry: z.number().int(),
});
export type NearExpiryItem = z.infer<typeof NearExpiryItemSchema>;
export const NearExpiryResponseSchema = envelope(z.array(NearExpiryItemSchema));
