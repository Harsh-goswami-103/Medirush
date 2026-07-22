import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  IdSchema,
  ListWishlistQuerySchema,
  ListWishlistResponseSchema,
  Role,
  ToggleWishlistBodySchema,
  WishlistStatusResponseSchema,
  WishlistStatusSchema,
  envelope,
} from "@medrush/contracts";
import { z } from "zod";
import { AppError } from "../../core/errors";
import { requireSyncedAuth } from "../../plugins/auth";
import { addToWishlist, listWishlist, removeFromWishlist, wishlistStatus } from "./service";

/**
 * Wishlist / favourites (§17 v1.1 — CUSTOMER only, own rows only):
 * - GET    /v1/wishlist                    cursor-paginated, newest first
 * - GET    /v1/wishlist/status?productIds= batch heart-state for a grid
 * - POST   /v1/wishlist                    idempotent add
 * - DELETE /v1/wishlist/:productId         idempotent remove
 *
 * §12: personal state — never cached.
 */

const customerOnly = { roles: [Role.CUSTOMER] };

/** One request per product grid; the cap keeps the `IN (…)` bounded. */
const MAX_STATUS_IDS = 100;

const WishlistProductParamsSchema = z.object({ productId: IdSchema });
const WishlistStatusQuerySchema = z.object({ productIds: z.string().min(1) });
const ListWishlistStatusResponseSchema = envelope(z.array(WishlistStatusSchema));

/** Parse the CSV id list, dropping blanks and duplicates (order preserved). */
function parseProductIds(raw: string): string[] {
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  if (ids.length > MAX_STATUS_IDS) {
    throw new AppError("VALIDATION_ERROR", `At most ${MAX_STATUS_IDS} productIds per request`, 422, {
      max: MAX_STATUS_IDS,
      received: ids.length,
    });
  }
  return ids;
}

export const wishlistRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/wishlist",
    {
      config: customerOnly,
      schema: {
        tags: ["wishlist"],
        summary: "List the caller's wishlist (cursor-paginated, newest first)",
        querystring: ListWishlistQuerySchema,
        response: { 200: ListWishlistResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { cursor, limit } = request.query;
      const { items, nextCursor } = await listWishlist(userId, { cursor, limit });
      return { data: items, meta: { nextCursor } };
    },
  );

  typed.get(
    "/wishlist/status",
    {
      config: customerOnly,
      schema: {
        tags: ["wishlist"],
        summary: "Batch wishlist state for up to 100 product ids",
        querystring: WishlistStatusQuerySchema,
        response: { 200: ListWishlistStatusResponseSchema, 422: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const productIds = parseProductIds(request.query.productIds);
      return { data: await wishlistStatus(userId, productIds) };
    },
  );

  typed.post(
    "/wishlist",
    {
      config: customerOnly,
      schema: {
        tags: ["wishlist"],
        summary: "Add a product to the wishlist (idempotent)",
        body: ToggleWishlistBodySchema,
        response: { 200: WishlistStatusResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await addToWishlist(userId, request.body.productId) };
    },
  );

  typed.delete(
    "/wishlist/:productId",
    {
      config: customerOnly,
      schema: {
        tags: ["wishlist"],
        summary: "Remove a product from the wishlist (idempotent)",
        params: WishlistProductParamsSchema,
        response: { 200: WishlistStatusResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await removeFromWishlist(userId, request.params.productId) };
    },
  );
};
