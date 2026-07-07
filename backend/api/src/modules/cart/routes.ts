import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  GetCartResponseSchema,
  RemoveCartItemParamsSchema,
  RemoveCartItemResponseSchema,
  Role,
  UpsertCartItemBodySchema,
  UpsertCartItemResponseSchema,
  ValidateCartResponseSchema,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import { getOrCreateCart, hydrate, removeItem, setItem, validateCart } from "./service";

/**
 * Customer cart endpoints (§7.2, RBAC §8.3 — CUSTOMER only):
 * - GET    /v1/cart
 * - PUT    /v1/cart/items
 * - DELETE /v1/cart/items/:productId
 * - POST   /v1/cart/validate
 *
 * §12: cart state is per-user and mutation-hot — never cacheable.
 */

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

export const cartRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Encapsulated hook: applies to this plugin's routes only (§12 "never cached").
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/cart",
    {
      config: customerOnly,
      schema: {
        tags: ["cart"],
        summary: "Get (lazily creating) the caller's server-priced cart",
        response: { 200: GetCartResponseSchema },
      },
    },
    async (request) => {
      const cart = await getOrCreateCart(requireUserId(request));
      return { data: await hydrate(cart) };
    },
  );

  typed.put(
    "/cart/items",
    {
      config: customerOnly,
      schema: {
        tags: ["cart"],
        summary: "Upsert a cart line to exactly `qty` (not additive)",
        body: UpsertCartItemBodySchema,
        response: { 200: UpsertCartItemResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const { productId, qty } = request.body;
      return { data: await setItem(requireUserId(request), productId, qty) };
    },
  );

  typed.delete(
    "/cart/items/:productId",
    {
      config: customerOnly,
      schema: {
        tags: ["cart"],
        summary: "Remove a cart line (idempotent)",
        params: RemoveCartItemParamsSchema,
        response: { 200: RemoveCartItemResponseSchema },
      },
    },
    async (request) => {
      return { data: await removeItem(requireUserId(request), request.params.productId) };
    },
  );

  typed.post(
    "/cart/validate",
    {
      config: customerOnly,
      schema: {
        tags: ["cart"],
        summary: "Re-check stock/price/Rx flags before checkout",
        response: { 200: ValidateCartResponseSchema },
      },
    },
    async (request) => {
      // Service result carries a `totals` preview beyond the contract shape;
      // the response serializer strips it (contract mismatch — see report).
      return { data: await validateCart(requireUserId(request)) };
    },
  );
};
