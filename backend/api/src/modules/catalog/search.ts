import { Prisma } from "@prisma/client";
import type { Product as DbProduct } from "@prisma/client";
import type { GstRate, Product, ProductSort, ProductSummary, ScheduleClass } from "@medrush/contracts";
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
    // Structured medical info — empty string means "not documented".
    uses: product.uses,
    directions: product.directions,
    sideEffects: product.sideEffects,
    storageInfo: product.storageInfo,
    warnings: product.warnings,
    manufacturer: product.manufacturer,
  };
}

export interface ProductSearchResult {
  items: ProductSummary[];
  /**
   * Keyset cursor for plain listings (ORDER BY id ASC, cursor = last id).
   * ALWAYS null for search results and explicit sorts — those return only the
   * top rows, no deep paging (documented simplification, see phase-1 report).
   */
  nextCursor: string | null;
}

/** Optional list filters (tri-state booleans: undefined = no filter). */
export interface ProductListFilters {
  sort?: ProductSort;
  inStock?: boolean;
  requiresRx?: boolean;
  minPricePaise?: number;
  maxPricePaise?: number;
  discounted?: boolean;
  /** Health-concern id (resolved from the `concern` slug by the route). */
  concernId?: string;
}

/** Filters as AND-composed Prisma where parts for the typed-client paths. */
function filterWhere(f: ProductListFilters): Prisma.ProductWhereInput[] {
  const fields = getPrisma().product.fields;
  const parts: Prisma.ProductWhereInput[] = [];
  // `some` on the M:N join, not a join+distinct — one product never duplicates.
  if (f.concernId !== undefined) parts.push({ concerns: { some: { concernId: f.concernId } } });
  if (f.inStock !== undefined) parts.push({ stockQty: f.inStock ? { gt: 0 } : { equals: 0 } });
  if (f.requiresRx !== undefined) parts.push({ requiresRx: f.requiresRx });
  if (f.minPricePaise !== undefined) parts.push({ pricePaise: { gte: f.minPricePaise } });
  if (f.maxPricePaise !== undefined) parts.push({ pricePaise: { lte: f.maxPricePaise } });
  if (f.discounted !== undefined) {
    parts.push({ pricePaise: f.discounted ? { lt: fields.mrpPaise } : { gte: fields.mrpPaise } });
  }
  return parts;
}

/** The same filters as raw AND-clauses for the SQL paths. */
function filterSql(f: ProductListFilters): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [];
  if (f.concernId !== undefined) {
    clauses.push(Prisma.sql`AND EXISTS (
      SELECT 1 FROM "ProductHealthConcern" phc
      WHERE phc."productId" = "Product"."id" AND phc."concernId" = ${f.concernId}
    )`);
  }
  if (f.inStock !== undefined) {
    clauses.push(f.inStock ? Prisma.sql`AND "stockQty" > 0` : Prisma.sql`AND "stockQty" = 0`);
  }
  if (f.requiresRx !== undefined) clauses.push(Prisma.sql`AND "requiresRx" = ${f.requiresRx}`);
  if (f.minPricePaise !== undefined) clauses.push(Prisma.sql`AND "pricePaise" >= ${f.minPricePaise}`);
  if (f.maxPricePaise !== undefined) clauses.push(Prisma.sql`AND "pricePaise" <= ${f.maxPricePaise}`);
  if (f.discounted !== undefined) {
    clauses.push(
      f.discounted
        ? Prisma.sql`AND "pricePaise" < "mrpPaise"`
        : Prisma.sql`AND "pricePaise" >= "mrpPaise"`,
    );
  }
  return clauses;
}

/**
 * ORDER BY per sort key. `discount` ranks by percentage off, not absolute
 * paise — otherwise a tiny cut on an expensive item outranks a deep cut on a
 * cheap one.
 */
const SORT_ORDER_SQL: Record<ProductSort, Prisma.Sql> = {
  price_asc: Prisma.sql`"pricePaise" ASC, id ASC`,
  price_desc: Prisma.sql`"pricePaise" DESC, id ASC`,
  discount: Prisma.sql`("mrpPaise" - "pricePaise")::float / NULLIF("mrpPaise", 0) DESC NULLS LAST, id ASC`,
  name: Prisma.sql`name ASC, id ASC`,
};

/** ILIKE prefix pattern with LIKE wildcards escaped (default `\` escape char). */
function likePrefix(q: string): string {
  return `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * List/search active products (§7.2).
 * - no `q`, no `sort` → keyset-paginated plain listing (ORDER BY id ASC).
 * - `q` ≥ 3 → pg_trgm word-similarity match over the §6.3 indexed doc.
 * - `q` < 3 → `name ILIKE 'q%'` prefix fallback.
 * Filters (including `concernId`, joined through `ProductHealthConcern`) compose
 * with category and search on every path. An explicit `sort`
 * switches to a top-N read (nextCursor null, cursor ignored) and overrides the
 * similarity ordering on the search path.
 */
export async function searchProducts(
  q: string | undefined,
  categoryId?: string,
  cursor?: string,
  limit = 20,
  filters: ProductListFilters = {},
): Promise<ProductSearchResult> {
  const prisma = getPrisma();
  const { sort } = filters;

  if (q === undefined && sort === undefined) {
    const rows = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(categoryId === undefined ? {} : { categoryId }),
        ...(cursor === undefined ? {} : { id: { gt: cursor } }),
        AND: filterWhere(filters),
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

  if (q !== undefined && q.length < TRGM_MIN_QUERY_LENGTH && sort === undefined) {
    // 1–2 chars: name-prefix match. Prisma `startsWith` + insensitive mode
    // compiles to ILIKE 'q%' with LIKE wildcards escaped.
    const rows = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(categoryId === undefined ? {} : { categoryId }),
        name: { startsWith: q, mode: "insensitive" },
        AND: filterWhere(filters),
      },
      orderBy: { name: "asc" },
      take: limit,
    });
    return { items: rows.map((row) => toProductSummary(row)), nextCursor: null };
  }

  // Raw top-N path: trgm search and/or an explicit sort.
  const clauses: Prisma.Sql[] = [];
  if (categoryId !== undefined) clauses.push(Prisma.sql`AND "categoryId" = ${categoryId}`);
  clauses.push(...filterSql(filters));
  if (q !== undefined) {
    // WORD similarity (`q <% doc`), not whole-string `%`: the doc is long
    // (name+brand+composition+keywords), so whole-string similarity of a short
    // query never clears the 0.3 threshold — "dolo" scored 0.068 against its
    // own product and EVERY realistic search returned zero rows. Word
    // similarity compares the query against the best-matching word span
    // (exact word → 1.0, close typo ≈ 0.7) and the same §6.3 GIN trgm index
    // serves the `<%` operator, indexed column on the right.
    clauses.push(
      q.length >= TRGM_MIN_QUERY_LENGTH
        ? Prisma.sql`AND ${q} <% ${SEARCH_DOC}`
        : Prisma.sql`AND name ILIKE ${likePrefix(q)}`,
    );
  }

  // `sort === undefined` here implies a ≥3-char `q` (the no-sort plain and
  // prefix paths returned above) — the `?? ""` only satisfies the type checker.
  const orderBy =
    sort !== undefined
      ? SORT_ORDER_SQL[sort]
      : Prisma.sql`word_similarity(${q ?? ""}, ${SEARCH_DOC}) DESC, id ASC`;

  const rows = await prisma.$queryRaw<ProductSummarySource[]>(Prisma.sql`
    SELECT id, name, slug, brand, "packSize", "mrpPaise", "pricePaise", images,
           "requiresRx", "scheduleClass", "isColdChain", "stockQty", "maxPerOrder"
    FROM "Product"
    WHERE "isActive" = true
      ${clauses.length === 0 ? Prisma.empty : Prisma.join(clauses, " ")}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `);
  return { items: rows.map((row) => toProductSummary(row)), nextCursor: null };
}

/**
 * Same-composition alternatives (§17 v1.1 substitutes): active rows whose
 * `lower(btrim(composition))` matches, same `requiresRx` (an Rx item must
 * never suggest an OTC swap or vice versa), self excluded. In-stock rows
 * first, then cheapest. An empty composition never matches anything.
 */
export async function listSubstitutes(product: DbProduct, limit = 10): Promise<ProductSummary[]> {
  const composition = product.composition.trim().toLowerCase();
  if (composition === "") return [];
  const rows = await getPrisma().$queryRaw<ProductSummarySource[]>(Prisma.sql`
    SELECT id, name, slug, brand, "packSize", "mrpPaise", "pricePaise", images,
           "requiresRx", "scheduleClass", "isColdChain", "stockQty", "maxPerOrder"
    FROM "Product"
    WHERE "isActive" = true
      AND id <> ${product.id}
      AND "requiresRx" = ${product.requiresRx}
      AND lower(btrim("composition")) = ${composition}
    ORDER BY ("stockQty" > 0) DESC, "pricePaise" ASC, id ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => toProductSummary(row));
}
