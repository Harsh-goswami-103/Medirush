import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  ListPublicCouponsResponseSchema,
  Role,
  ValidateCouponBodySchema,
  ValidateCouponResponseSchema,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import { PUBLIC_CACHE_CONTROL } from "../catalog/routes";
import { listPublicCoupons, quoteCoupon } from "./service";

/**
 * Customer coupon endpoints (feature-gap Batch 2):
 * - GET  /v1/coupons          (public — the offers surface, §12 cacheable)
 * - POST /v1/coupons/validate (CUSTOMER — priced preview against the cart)
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

export const couponRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/coupons",
    {
      config: { public: true },
      schema: {
        tags: ["coupons"],
        summary: "Active public offers, soonest-expiring first",
        response: { 200: ListPublicCouponsResponseSchema },
      },
    },
    async (_request, reply) => {
      const coupons = await listPublicCoupons();
      reply.header("cache-control", PUBLIC_CACHE_CONTROL);
      return { data: coupons };
    },
  );

  typed.post(
    "/coupons/validate",
    {
      config: customerOnly,
      schema: {
        tags: ["coupons"],
        summary: "Validate a code against the caller's cart and quote the discount",
        body: ValidateCouponBodySchema,
        response: { 200: ValidateCouponResponseSchema, 422: ApiErrorSchema },
      },
    },
    async (request) => {
      return { data: await quoteCoupon(requireUserId(request), request.body.code) };
    },
  );
};
