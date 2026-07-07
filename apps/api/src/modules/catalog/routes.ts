import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  GetProductResponseSchema,
  ListCategoriesResponseSchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  ProductParamsSchema,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { searchProducts, toImageUrl, toProductDetail } from "./search";

/**
 * Public catalog endpoints (§7.2 ⭘ rows):
 * - GET /v1/categories
 * - GET /v1/products?category&search&cursor&limit
 * - GET /v1/products/:slug
 *
 * All three are CDN/edge cacheable (§12). The header is set only on success
 * responses so error payloads (404s) are never publicly cached.
 */

/** §12 HTTP cache row for `GET /products*`, `/categories`, `/store`. */
export const PUBLIC_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

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
      const { category, search, cursor, limit } = request.query;

      let categoryId: string | undefined;
      if (category !== undefined) {
        const categoryRow = await getPrisma().category.findUnique({
          where: { slug: category },
        });
        if (categoryRow === null) {
          // Unknown category slug → empty page (filter semantics, not a 404).
          reply.header("cache-control", PUBLIC_CACHE_CONTROL);
          return { data: [], meta: { nextCursor: null } };
        }
        categoryId = categoryRow.id;
      }

      const { items, nextCursor } = await searchProducts(search, categoryId, cursor, limit);
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
      const product = await getPrisma().product.findUnique({
        where: { slug: request.params.slug },
      });
      // Inactive products are indistinguishable from absent ones to customers.
      if (product === null || !product.isActive) {
        throw new AppError("NOT_FOUND", "Product not found", 404);
      }
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return { data: toProductDetail(product) };
    },
  );
};
