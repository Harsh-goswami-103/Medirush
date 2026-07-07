import { Prisma } from "@prisma/client";
import type { Cart as DbCart, CartItem as DbCartItem, Product as DbProduct } from "@prisma/client";
import type { Cart, CartIssue, CartItem, ValidateCartResult } from "@medrush/contracts";
import { CartIssueKind } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { deliveryFeePaise, getStoreConfig } from "../../core/storeInfo";
import { toProductSummary } from "../catalog/search";

/**
 * Server-side cart (§7.2): the cart is the price-integrity boundary — clients
 * only ever send productId + qty; every paise figure is computed here from
 * live Product rows. Ownership is structural: all entry points take the
 * authenticated `userId` and operate on that user's single cart (§8.3).
 */

export type CartWithItems = DbCart & { items: DbCartItem[] };

/** Get the user's cart, lazily creating it on first touch (User.cart is 1:1). */
export async function getOrCreateCart(userId: string): Promise<CartWithItems> {
  const prisma = getPrisma();

  const existing = await prisma.cart.findUnique({
    where: { userId },
    include: { items: { orderBy: { id: "asc" } } },
  });
  if (existing !== null) return existing;

  try {
    return await prisma.cart.create({
      data: { userId },
      include: { items: { orderBy: { id: "asc" } } },
    });
  } catch (error) {
    // Lost the unique(userId) race against a concurrent first request — the
    // cart exists now; fetch it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.cart.findUniqueOrThrow({
        where: { userId },
        include: { items: { orderBy: { id: "asc" } } },
      });
    }
    throw error;
  }
}

/**
 * PUT semantics: set the line for `productId` to exactly `qty` (not additive).
 * - inactive/unknown product → 404 NOT_FOUND
 * - qty outside 1..maxPerOrder → 422 VALIDATION_ERROR
 */
export async function setItem(userId: string, productId: string, qty: number): Promise<Cart> {
  const prisma = getPrisma();

  if (!Number.isInteger(qty) || qty < 1) {
    throw new AppError("VALIDATION_ERROR", "Quantity must be a positive integer", 422, {
      productId,
      requestedQty: qty,
    });
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (product === null || !product.isActive) {
    throw new AppError("NOT_FOUND", "Product not found", 404);
  }
  if (qty > product.maxPerOrder) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Quantity ${qty} exceeds the per-order limit of ${product.maxPerOrder} for this product`,
      422,
      { productId, requestedQty: qty, maxPerOrder: product.maxPerOrder },
    );
  }

  const cart = await getOrCreateCart(userId);
  // Nested write: line upsert + Cart.updatedAt bump in one atomic statement.
  const updated = await prisma.cart.update({
    where: { id: cart.id },
    data: {
      items: {
        upsert: {
          where: { cartId_productId: { cartId: cart.id, productId } },
          create: { productId, qty },
          update: { qty },
        },
      },
    },
    include: { items: { orderBy: { id: "asc" } } },
  });
  return hydrate(updated);
}

/** Remove a line. Idempotent — deleting an absent line is a no-op. */
export async function removeItem(userId: string, productId: string): Promise<Cart> {
  const prisma = getPrisma();
  const cart = await getOrCreateCart(userId);
  const updated = await prisma.cart.update({
    where: { id: cart.id },
    data: { items: { deleteMany: { productId } } },
    include: { items: { orderBy: { id: "asc" } } },
  });
  return hydrate(updated);
}

async function loadProducts(productIds: string[]): Promise<Map<string, DbProduct>> {
  if (productIds.length === 0) return new Map();
  const rows = await getPrisma().product.findMany({ where: { id: { in: productIds } } });
  return new Map(rows.map((row) => [row.id, row]));
}

function buildCart(cart: CartWithItems, products: Map<string, DbProduct>): Cart {
  const items: CartItem[] = [];
  for (const line of cart.items) {
    const product = products.get(line.productId);
    // CartItem.productId carries no FK (§6.2) — drop dangling lines defensively.
    if (product === undefined) continue;
    items.push({
      productId: line.productId,
      qty: line.qty,
      product: toProductSummary(product),
      lineTotalPaise: product.pricePaise * line.qty,
    });
  }
  return {
    id: cart.id,
    items,
    itemsPaise: items.reduce((sum, item) => sum + item.lineTotalPaise, 0),
    requiresRx: items.some((item) => item.product.requiresRx),
    updatedAt: cart.updatedAt.toISOString(),
  };
}

/** Prisma cart row → contracts `Cart` (live product snapshots, server-priced). */
export async function hydrate(cart: CartWithItems): Promise<Cart> {
  return buildCart(cart, await loadProducts(cart.items.map((line) => line.productId)));
}

/** Checkout-preview totals (§9.2 items/delivery rows + min-order flag). */
export interface CartTotalsPreview {
  itemsPaise: number;
  deliveryPaise: number;
  totalPaise: number;
  minOrderPaise: number;
  /** `itemsPaise >= minOrderPaise` — checkout will 422 MIN_ORDER_NOT_MET when false. */
  minOrderMet: boolean;
}

/**
 * Contract `ValidateCartResult` + totals preview. NOTE: `totals` is not part of
 * `ValidateCartResultSchema` yet, so the route serializer strips it from the
 * wire — reported as a contract mismatch in the phase-1 manifest.
 */
export interface CartValidation extends ValidateCartResult {
  totals: CartTotalsPreview;
}

/**
 * POST /v1/cart/validate (§9.2 pre-checkout re-check): per-item issues using
 * the contracts `CartIssueKind` enum, plus a §9.2 totals preview computed with
 * agent A's `deliveryFeePaise`.
 *
 * `PRICE_CHANGED` is unreachable in Phase 1: `CartItem` stores no price
 * snapshot column (§6.2), so the cart is always live-priced from Product and
 * there is nothing to diff against.
 */
export async function validateCart(userId: string): Promise<CartValidation> {
  const cart = await getOrCreateCart(userId);
  const products = await loadProducts(cart.items.map((line) => line.productId));

  const issues: CartIssue[] = [];
  for (const line of cart.items) {
    const product = products.get(line.productId);

    if (product === undefined || !product.isActive) {
      issues.push({
        productId: line.productId,
        kind: CartIssueKind.PRODUCT_INACTIVE,
        message: "This product is no longer available",
      });
      continue;
    }
    if (product.stockQty === 0) {
      issues.push({
        productId: line.productId,
        kind: CartIssueKind.OUT_OF_STOCK,
        message: `${product.name} is out of stock`,
      });
    } else if (product.stockQty < line.qty) {
      issues.push({
        productId: line.productId,
        kind: CartIssueKind.STOCK_INSUFFICIENT,
        message: `Only ${product.stockQty} × ${product.name} available right now`,
        availableQty: product.stockQty,
      });
    }
    if (line.qty > product.maxPerOrder) {
      issues.push({
        productId: line.productId,
        kind: CartIssueKind.MAX_PER_ORDER_EXCEEDED,
        message: `Maximum ${product.maxPerOrder} × ${product.name} per order`,
        availableQty: product.maxPerOrder,
      });
    }
  }

  const hydrated = buildCart(cart, products);
  const storeConfig = await getStoreConfig();
  const deliveryPaise = deliveryFeePaise(storeConfig, hydrated.itemsPaise);

  return {
    valid: issues.length === 0,
    issues,
    cart: hydrated,
    totals: {
      itemsPaise: hydrated.itemsPaise,
      deliveryPaise,
      totalPaise: hydrated.itemsPaise + deliveryPaise,
      minOrderPaise: storeConfig.minOrderPaise,
      minOrderMet: hydrated.itemsPaise >= storeConfig.minOrderPaise,
    },
  };
}
