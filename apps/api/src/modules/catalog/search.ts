import { Prisma } from "@prisma/client";
import type { Product as DbProduct } from "@prisma/client";
import type { GstRate, Product, ProductSummary, ScheduleClass } from "@medrush/contracts";
import { getConfig } from "../../core/config";
import { getPrisma } from "../../core/db";

/**
 * Catalog data access: pg_trgm product search (§7.2 search strategy, §6.3 GIN
 * index) plus the Product-row → contract-shape mapping. The mapping lives here
 * (not in routes) because the cart module reuses it — every customer surface
 * exposes the identical `ProductSummary` shape (raw stockQty hidden behind
 * `inStock`).
 */

/**
 * Search document expression — must stay semantically identical to the §6.3
 * index: `(name || ' ' || coalesce(brand,'') || ' ' || "composition" || ' ' ||
 * "searchKeywords")` so the GIN trgm index is used.
 */
const SEARCH_DOC = Prisma.sql`(name || ' ' || coalesce(brand, '') || ' ' || "composition" || ' ' || "searchKeywords")`;

/** Below this length trigram similarity is noise — fall back to name-prefix ILIKE. */
const TRGM_MIN_QUERY_LENGTH = 3;

/**
 * Subset of Product columns needed to build the customer-safe summary shape.
 * `images` is `string[] | null` because `$queryRaw` deserializes an EMPTY
 * Postgres `text[]` as SQL NULL (a populated array comes back as a JS array) —
 * the typed Prisma client always yields an array, but the raw search path does not.
 */
export interface ProductSummarySource {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  packSize: string;
  mrpPaise: number;
  pricePaise: number;
  images: string[] | null;
  requiresRx: boolean;
  scheduleClass: ScheduleClass;
  isColdChain: boolean;
  stockQty: number;
  maxPerOrder: number;
}

/**
 * Map a stored image reference to a public URL (§13: keys are stored, CDN URLs
 * are served). Absolute URLs pass through untouched; keys are prefixed with
 * `R2_PUBLIC_CDN_URL` when configured, and returned raw in dev without a CDN
 * (see the phase-1 report note about the contract's `z.url()`).
 */
export function toImageUrl(keyOrUrl: string): string {
  if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl;
  const cdn = getConfig().R2_PUBLIC_CDN_URL;
  if (cdn !== undefined) return `${cdn.replace(/\/+$/, "")}/${keyOrUrl.replace(/^\/+/, "")}`;
  return keyOrUrl;
}

/** Customer-safe product card — hides raw stockQty behind `inStock` (§7.2). */
export function toProductSummary(product: ProductSummarySource): ProductSummary {
  const firstImage = product.images?.[0];
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    brand: product.brand,
    packSize: product.packSize,
    mrpPaise: product.mrpPaise,
    pricePaise: product.pricePaise,
    imageUrl: firstImage === undefined ? null : toImageUrl(firstImage),
    requiresRx: product.requiresRx,
    scheduleClass: product.scheduleClass,
    isColdChain: product.isColdChain,
    inStock: product.stockQty > 0,
    maxPerOrder: product.maxPerOrder,
  };
}

/** Full detail shape for GET /v1/products/:slug. */
export function toProductDetail(product: DbProduct): Product {
  return {
    ...toProductSummary(product),
    description: product.description,
    categoryId: product.categoryId,
    images: product.images.map((key) => toImageUrl(key)),
    composition: product.composition,
    // DB stores Int; ops catalog CRUD only accepts the §6.2 slabs {0,5,12,18}.
    gstRatePct: product.gstRatePct as GstRate,
  };
}

export interface ProductSearchResult {
  items: ProductSummary[];
  /**
   * Keyset cursor for plain listings (ORDER BY id ASC, cursor = last id).
   * ALWAYS null for search results — Phase 1 returns only the top rows of a
   * search, no deep paging (documented simplification, see phase-1 report).
   */
  nextCursor: string | null;
}

/**
 * List/search active products (§7.2).
 * - no `q`  → keyset-paginated plain listing (ORDER BY id ASC).
 * - `q` ≥ 3 → pg_trgm `%` match over the §6.3 indexed doc, similarity-ordered.
 * - `q` < 3 → `name ILIKE 'q%'` prefix fallback.
 */
export async function searchProducts(
  q: string | undefined,
  categoryId?: string,
  cursor?: string,
  limit = 20,
): Promise<ProductSearchResult> {
  const prisma = getPrisma();

  if (q === undefined) {
    const rows = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(cursor === undefined ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toProductSummary(row)),
      nextCursor: rows.length > limit && last !== undefined ? last.id : null,
    };
  }

  const categoryFilter =
    categoryId === undefined ? Prisma.empty : Prisma.sql`AND "categoryId" = ${categoryId}`;

  if (q.length >= TRGM_MIN_QUERY_LENGTH) {
    const rows = await prisma.$queryRaw<ProductSummarySource[]>(Prisma.sql`
      SELECT id, name, slug, brand, "packSize", "mrpPaise", "pricePaise", images,
             "requiresRx", "scheduleClass", "isColdChain", "stockQty", "maxPerOrder"
      FROM "Product"
      WHERE "isActive" = true
        ${categoryFilter}
        AND ${SEARCH_DOC} % ${q}
      ORDER BY similarity(${SEARCH_DOC}, ${q}) DESC, id ASC
      LIMIT ${limit}
    `);
    return { items: rows.map((row) => toProductSummary(row)), nextCursor: null };
  }

  // 1–2 chars: name-prefix match. Prisma `startsWith` + insensitive mode
  // compiles to ILIKE 'q%' with LIKE wildcards escaped.
  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      ...(categoryId === undefined ? {} : { categoryId }),
      name: { startsWith: q, mode: "insensitive" },
    },
    orderBy: { name: "asc" },
    take: limit,
  });
  return { items: rows.map((row) => toProductSummary(row)), nextCursor: null };
}
