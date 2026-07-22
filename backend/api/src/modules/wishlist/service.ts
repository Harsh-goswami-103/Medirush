import type { WishlistEntry, WishlistStatus } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { toProductSummary } from "../catalog/search";

/**
 * Wishlist / favourites (§17 v1.1). Ownership is enforced in every query
 * `where` — a foreign row is invisible rather than refused, so ids cannot be
 * probed. Product fields are joined live on read (never snapshotted at save
 * time) so price/stock on the wishlist always match the catalog.
 *
 * Both read paths hide entries whose product has been delisted: a customer
 * should not be shown (or told they have "saved") a card that 404s on tap.
 * The row survives, so the entry reappears if the product is reactivated.
 */

export interface ListWishlistQuery {
  cursor?: string;
  limit: number;
}

export async function listWishlist(
  userId: string,
  q: ListWishlistQuery,
): Promise<{ items: WishlistEntry[]; nextCursor: string | null }> {
  const rows = await getPrisma().wishlist.findMany({
    where: { userId, product: { isActive: true } },
    include: { product: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];

  const items: WishlistEntry[] = page.map((row) => ({
    id: row.id,
    product: toProductSummary(row.product),
    createdAt: row.createdAt.toISOString(),
  }));

  return { items, nextCursor: hasMore && last ? last.id : null };
}

/** Idempotent add. An unknown or delisted product is a 404 either way. */
export async function addToWishlist(userId: string, productId: string): Promise<WishlistStatus> {
  const product = await getPrisma().product.findUnique({
    where: { id: productId },
    select: { isActive: true },
  });
  if (product === null || !product.isActive) {
    throw new AppError("NOT_FOUND", "Product not found", 404);
  }

  await getPrisma().wishlist.upsert({
    where: { userId_productId: { userId, productId } },
    create: { userId, productId },
    update: {},
  });
  return { productId, wishlisted: true };
}

/**
 * Idempotent remove — a missing row (or another user's row) is a silent
 * success, and no product lookup happens so a delisted item can still be
 * un-saved.
 */
export async function removeFromWishlist(
  userId: string,
  productId: string,
): Promise<WishlistStatus> {
  await getPrisma().wishlist.deleteMany({ where: { userId, productId } });
  return { productId, wishlisted: false };
}

/** Batch heart-state for a product grid: one entry per requested id, in order. */
export async function wishlistStatus(
  userId: string,
  productIds: string[],
): Promise<WishlistStatus[]> {
  if (productIds.length === 0) return [];
  const rows = await getPrisma().wishlist.findMany({
    where: { userId, productId: { in: productIds }, product: { isActive: true } },
    select: { productId: true },
  });
  const saved = new Set(rows.map((row) => row.productId));
  return productIds.map((productId) => ({ productId, wishlisted: saved.has(productId) }));
}
