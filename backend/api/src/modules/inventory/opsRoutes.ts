import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateBatchBodySchema,
  CreateBatchResponseSchema,
  CreateCategoryBodySchema,
  CreateCategoryResponseSchema,
  CreateProductBodySchema,
  CreateProductResponseSchema,
  DeleteCategoryResponseSchema,
  DeleteProductResponseSchema,
  GetOpsProductResponseSchema,
  IdParamsSchema,
  LowStockResponseSchema,
  NearExpiryQuerySchema,
  NearExpiryResponseSchema,
  OpsListCategoriesResponseSchema,
  OpsListProductsResponseSchema,
  OpsProductListQuerySchema,
  Role,
  StockAdjustBodySchema,
  StockAdjustResponseSchema,
  UpdateCategoryBodySchema,
  UpdateCategoryResponseSchema,
  UpdateProductBodySchema,
  UpdateProductResponseSchema,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import {
  adjustStock,
  createCategory,
  createProduct,
  deactivateCategory,
  deactivateProduct,
  getProduct,
  listCategories,
  listLowStock,
  listNearExpiry,
  listProducts,
  receiveBatch,
  updateCategory,
  updateProduct,
  type OpsActor,
} from "./opsCatalogService";

/**
 * Ops inventory management (BLUEPRINT §7.2 ops rows; RBAC §8.3: INVENTORY or
 * ADMIN) — products/categories CRUD, GRN batches, stock adjust, low-stock and
 * near-expiry alerts. Registered under the /v1 prefix by modules/v1.ts.
 */

const OPS_ROLES: Role[] = [Role.INVENTORY, Role.ADMIN];

function requireActor(request: FastifyRequest): OpsActor {
  const auth = request.auth;
  if (!auth?.userId || !auth.role) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return { userId: auth.userId, role: auth.role };
}

export const opsInventoryRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: inventory management is live operator data — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  /* -------------------------------------------------------- products */

  typed.get(
    "/ops/products",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "List products (cursor-paginated; search / category slug / isActive filters)",
        querystring: OpsProductListQuerySchema,
        response: { 200: OpsListProductsResponseSchema },
      },
    },
    async (request) => {
      const { products, nextCursor } = await listProducts(request.query);
      return { data: products, meta: { nextCursor } };
    },
  );

  typed.post(
    "/ops/products",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Create a product (slug from name when omitted; price ≤ MRP enforced)",
        body: CreateProductBodySchema,
        response: { 200: CreateProductResponseSchema },
      },
    },
    async (request) => ({ data: await createProduct(request.body, requireActor(request)) }),
  );

  typed.get(
    "/ops/products/:id",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Full ops product view (inactive included)",
        params: IdParamsSchema,
        response: { 200: GetOpsProductResponseSchema },
      },
    },
    async (request) => ({ data: await getProduct(request.params.id) }),
  );

  typed.patch(
    "/ops/products/:id",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Update a product (price ≤ MRP re-checked on merged values)",
        params: IdParamsSchema,
        body: UpdateProductBodySchema,
        response: { 200: UpdateProductResponseSchema },
      },
    },
    async (request) => ({
      data: await updateProduct(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.delete(
    "/ops/products/:id",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Soft-deactivate a product (isActive=false)",
        params: IdParamsSchema,
        response: { 200: DeleteProductResponseSchema },
      },
    },
    async (request) => ({ data: await deactivateProduct(request.params.id, requireActor(request)) }),
  );

  /* ------------------------------------------------------ categories */

  typed.get(
    "/ops/categories",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "All categories (active + inactive), by sortOrder",
        response: { 200: OpsListCategoriesResponseSchema },
      },
    },
    async () => ({ data: await listCategories() }),
  );

  typed.post(
    "/ops/categories",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Create a category (slug from name when omitted)",
        body: CreateCategoryBodySchema,
        response: { 200: CreateCategoryResponseSchema },
      },
    },
    async (request) => ({ data: await createCategory(request.body, requireActor(request)) }),
  );

  typed.patch(
    "/ops/categories/:id",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Update a category",
        params: IdParamsSchema,
        body: UpdateCategoryBodySchema,
        response: { 200: UpdateCategoryResponseSchema },
      },
    },
    async (request) => ({
      data: await updateCategory(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.delete(
    "/ops/categories/:id",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Soft-deactivate a category (isActive=false)",
        params: IdParamsSchema,
        response: { 200: DeleteCategoryResponseSchema },
      },
    },
    async (request) => ({ data: await deactivateCategory(request.params.id, requireActor(request)) }),
  );

  /* -------------------------------------------------- GRN + stock */

  typed.post(
    "/ops/products/:id/batches",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "GRN: receive a batch (bumps stock cache + RECEIVED adjustment; expiry must be future)",
        params: IdParamsSchema,
        body: CreateBatchBodySchema,
        response: { 200: CreateBatchResponseSchema },
      },
    },
    async (request) => ({
      data: await receiveBatch(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.post(
    "/ops/stock/adjust",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Signed manual stock adjustment (never negative → 409; optional batch decrement)",
        body: StockAdjustBodySchema,
        response: { 200: StockAdjustResponseSchema },
      },
    },
    async (request) => ({ data: await adjustStock(request.body, requireActor(request)) }),
  );

  typed.get(
    "/ops/stock/low",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Products at/below their lowStockThreshold",
        response: { 200: LowStockResponseSchema },
      },
    },
    async () => ({ data: await listLowStock() }),
  );

  typed.get(
    "/ops/stock/near-expiry",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Batches with stock expiring within ?days (IST)",
        querystring: NearExpiryQuerySchema,
        response: { 200: NearExpiryResponseSchema },
      },
    },
    async (request) => ({ data: await listNearExpiry(request.query) }),
  );
};
