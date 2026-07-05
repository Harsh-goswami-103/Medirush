/**
 * Server-side cart endpoints (BLUEPRINT §7.2 — Customer). The cart lives
 * server-side for price integrity: clients never send prices, only qty.
 *
 * | Endpoint                            | Body / Params                 | Response data            |
 * |-------------------------------------|-------------------------------|--------------------------|
 * | GET    /v1/cart                     | —                             | CartSchema               |
 * | PUT    /v1/cart/items               | UpsertCartItemBodySchema      | CartSchema               |
 * | DELETE /v1/cart/items/:productId    | RemoveCartItemParamsSchema    | CartSchema               |
 * | POST   /v1/cart/validate            | —                             | ValidateCartResultSchema |
 */
import { z } from "zod";
import {
  CountSchema,
  IdSchema,
  IsoDateTimeSchema,
  PaiseSchema,
  QtySchema,
  envelope,
} from "./common";
import { ProductSummarySchema } from "./catalog";

/* ------------------------------------------------------------------ cart */

export const CartItemSchema = z.object({
  productId: IdSchema,
  qty: QtySchema,
  /** Current catalog snapshot — always server-priced. */
  product: ProductSummarySchema,
  /** `product.pricePaise × qty` — convenience for rendering. */
  lineTotalPaise: PaiseSchema,
});
export type CartItem = z.infer<typeof CartItemSchema>;

export const CartSchema = z.object({
  id: IdSchema,
  items: z.array(CartItemSchema),
  /** Σ line totals in paise (before delivery fee / discount — those are checkout-time). */
  itemsPaise: PaiseSchema,
  /** True when any item requires a prescription (Rx upload will be required at checkout). */
  requiresRx: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type Cart = z.infer<typeof CartSchema>;

export const GetCartResponseSchema = envelope(CartSchema);

/* -------------------------------------------------------------- mutations */

/** PUT /v1/cart/items — upsert: sets the line to exactly `qty` (not additive). */
export const UpsertCartItemBodySchema = z.object({
  productId: IdSchema,
  /** 1..99 syntactically; `maxPerOrder` is enforced server-side per product. */
  qty: QtySchema.max(99),
});
export type UpsertCartItemBody = z.infer<typeof UpsertCartItemBodySchema>;
export const UpsertCartItemResponseSchema = envelope(CartSchema);

/** DELETE /v1/cart/items/:productId */
export const RemoveCartItemParamsSchema = z.object({ productId: IdSchema });
export type RemoveCartItemParams = z.infer<typeof RemoveCartItemParamsSchema>;
export const RemoveCartItemResponseSchema = envelope(CartSchema);

/* -------------------------------------------------------------- validate */

/** Problems detected by POST /v1/cart/validate (pre-checkout re-check). */
export const CartIssueKind = {
  /** Price changed since the item was added — cart line was re-priced. */
  PRICE_CHANGED: "PRICE_CHANGED",
  /** Product now completely out of stock. */
  OUT_OF_STOCK: "OUT_OF_STOCK",
  /** Some stock, but less than requested qty (`availableQty` says how much). */
  STOCK_INSUFFICIENT: "STOCK_INSUFFICIENT",
  /** Product was deactivated. */
  PRODUCT_INACTIVE: "PRODUCT_INACTIVE",
  /** Requested qty exceeds the per-order cap. */
  MAX_PER_ORDER_EXCEEDED: "MAX_PER_ORDER_EXCEEDED",
} as const;
export type CartIssueKind = (typeof CartIssueKind)[keyof typeof CartIssueKind];
export const CartIssueKindSchema = z.enum(CartIssueKind);

export const CartIssueSchema = z.object({
  productId: IdSchema,
  kind: CartIssueKindSchema,
  /** Human-readable, display-only — clients branch on `kind`. */
  message: z.string(),
  /** Present for STOCK_INSUFFICIENT / MAX_PER_ORDER_EXCEEDED. */
  availableQty: CountSchema.optional(),
  /** Present for PRICE_CHANGED — the new unit price in paise. */
  currentPricePaise: PaiseSchema.optional(),
});
export type CartIssue = z.infer<typeof CartIssueSchema>;

/**
 * POST /v1/cart/validate — no body. Re-checks stock/price/Rx flags and returns
 * the (possibly re-priced) cart. `valid=false` means checkout must not proceed
 * until the customer resolves the listed issues.
 */
export const ValidateCartResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(CartIssueSchema),
  cart: CartSchema,
});
export type ValidateCartResult = z.infer<typeof ValidateCartResultSchema>;
export const ValidateCartResponseSchema = envelope(ValidateCartResultSchema);
