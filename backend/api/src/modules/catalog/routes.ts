import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  GetProductResponseSchema,
  ListCategoriesResponseSchema,
  ListHealthConcernsResponseSchema,
  ListSubstitutesResponseSchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  ProductParamsSchema,
  Role,
  StockAlertResponseSchema,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { listSubstitutes, searchProducts, toImageUrl, toProductDetail } from "./search";

/**
 * Catalog endpoints (§7.2 ⭘ rows + Batch 2):
 * - GET /v1/categories
 * - GET /v1/concerns
 * - GET /v1/products?category&concern&search&cursor&limit&sort&filters…
 * - GET /v1/products/:slug
 * - GET /v1/products/:slug/substitutes
 * - POST/GET/DELETE /v1/products/:slug/stock-alert (CUSTOMER)
 *
 * Public reads are CDN/edge cacheable (§12). The header is set only on success
 * responses so error payloads (404s) are never publicly cached. Stock-alert
 * state is per-user — always `no-store`.
 */

/** §12 HTTP cache row for `GET /products*`, `/categories`, `/store`. */
export const PUBLIC_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

const customerOnly = { roles: [Role.CUSTOMER] };

/**
 * The role guard already rejected anonymous callers; this narrows the type and
 * guards the not-yet-synced edge (auth present but no PG user row).
 */
function requireUserId(request: FastifyRequest): string {
  const userId = request.auth?.userId;
  if (!userId) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return userId;
}

/** Resolve an active product by slug — inactive is indistinguishable from absent. */
async function requireActiveProduct(slug: string) {
  const product = await getPrisma().product.findUnique({ where: { slug } });
  if (product === null || !product.isActive) {
    throw new AppError("NOT_FOUND", "Product not found", 404);
  }
  return product;
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/categories",
    {
      config: { public: true },
      schema: {
        tags: ["catalog"],
        summary: "Active categories, sorted by sortOrder",
        response: { 200: ListCategoriesResponseSchema },
      },
    },
    async (_request, reply) => {
      const categories = await getPrisma().category.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return {
        data: categories.map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
          imageUrl: category.imageUrl === null ? null : toImageUrl(category.imageUrl),
          sortOrder: category.sortOrder,
        })),
      };
    },
  );

  typed.get(
    "/concerns",
    {
      config: { public: true },
      schema: {
        tags: ["catalog"],
        summary: "Active health concerns (shop-by-concern browse), sorted by sortOrder",
        response: { 200: ListHealthConcernsResponseSchema },
      },
    },
    async (_request, reply) => {
      const concerns = await getPrisma().healthConcern.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return {
        data: concerns.map((concern) => ({
          id: concern.id,
          name: concern.name,
          slug: concern.slug,
          imageUrl: concern.imageUrl === null ? null : toImageUrl(concern.imageUrl),
          sortOrder: concern.sortOrder,
        })),
      };
    },
  );

  typed.get(
    "/products",
    {
      config: { public: true },
      schema: {
        tags: ["catalog"],
        summary: "List/search products (pg_trgm fuzzy when `search` has 3+ chars)",
        querystring: ProductListQuerySchema,
        response: { 200: ProductListResponseSchema },
      },
    },
    async (request, reply) => {
      const { category, concern, search, cursor, limit } = request.query;
      const { sort, inStock, requiresRx, minPricePaise, maxPricePaise, discounted } = request.query;

      const emptyPage = () => {
        reply.header("cache-control", PUBLIC_CACHE_CONTROL);
        return { data: [], meta: { nextCursor: null } };
      };

      let categoryId: string | undefined;
      if (category !== undefined) {
        const categoryRow = await getPrisma().category.findUnique({
          where: { slug: category },
        });
        // Unknown category slug → empty page (filter semantics, not a 404).
        if (categoryRow === null) return emptyPage();
        categoryId = categoryRow.id;
      }

      let concernId: string | undefined;
      if (concern !== undefined) {
        const concernRow = await getPrisma().healthConcern.findFirst({
          where: { slug: concern, isActive: true },
          select: { id: true },
        });
        // Same filter semantics as category; an inactive concern reads as unknown.
        if (concernRow === null) return emptyPage();
        concernId = concernRow.id;
      }

      const { items, nextCursor } = await searchProducts(search, categoryId, cursor, limit, {
        sort,
        inStock,
        requiresRx,
        minPricePaise,
        maxPricePaise,
        discounted,
        concernId,
      });
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return { data: items, meta: { nextCursor } };
    },
  );

  typed.get(
    "/products/:slug",
    {
      config: { public: true },
      schema: {
        tags: ["catalog"],
        summary: "Product detail by slug",
        params: ProductParamsSchema,
        response: { 200: GetProductResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const product = await requireActiveProduct(request.params.slug);
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return { data: toProductDetail(product) };
    },
  );

  typed.get(
    "/products/:slug/substitutes",
    {
      config: { public: true },
      schema: {
        tags: ["catalog"],
        summary: "Same-composition substitutes (Rx-parity; in-stock first, then cheapest)",
        params: ProductParamsSchema,
        response: { 200: ListSubstitutesResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const product = await requireActiveProduct(request.params.slug);
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return { data: await listSubstitutes(product) };
    },
  );

  typed.post(
    "/products/:slug/stock-alert",
    {
      config: customerOnly,
      schema: {
        tags: ["catalog"],
        summary: "Subscribe to a back-in-stock alert (only for out-of-stock products)",
        params: ProductParamsSchema,
        response: { 200: StockAlertResponseSchema, 404: ApiErrorSchema, 422: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request);
      const product = await requireActiveProduct(request.params.slug);
      if (product.stockQty > 0) {
        throw new AppError("VALIDATION_ERROR", "Product is in stock", 422, { slug: product.slug });
      }
      // Idempotent: re-subscribing keeps the single [userId, productId] row.
      await getPrisma().stockAlert.upsert({
        where: { userId_productId: { userId, productId: product.id } },
        create: { userId, productId: product.id },
        update: {},
      });
      reply.header("cache-control", "no-store");
      return { data: { subscribed: true } };
    },
  );

  typed.get(
    "/products/:slug/stock-alert",
    {
      config: customerOnly,
      schema: {
        tags: ["catalog"],
        summary: "Back-in-stock alert status for the caller",
        params: ProductParamsSchema,
        response: { 200: StockAlertResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request);
      const product = await requireActiveProduct(request.params.slug);
      const alert = await getPrisma().stockAlert.findUnique({
        where: { userId_productId: { userId, productId: product.id } },
        select: { id: true },
      });
      reply.header("cache-control", "no-store");
      return { data: { subscribed: alert !== null } };
    },
  );

  typed.delete(
    "/products/:slug/stock-alert",
    {
      config: customerOnly,
      schema: {
        tags: ["catalog"],
        summary: "Unsubscribe from a back-in-stock alert (idempotent)",
        params: ProductParamsSchema,
        response: { 200: StockAlertResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const userId = requireUserId(request);
      const product = await requireActiveProduct(request.params.slug);
      await getPrisma().stockAlert.deleteMany({ where: { userId, productId: product.id } });
      reply.header("cache-control", "no-store");
      return { data: { subscribed: false } };
    },
  );
};
