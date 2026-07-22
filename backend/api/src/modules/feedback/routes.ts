import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  CreateRatingBodySchema,
  CreateReturnBodySchema,
  GetRatingResponseSchema,
  IdParamsSchema,
  ListReturnsQuerySchema,
  ListReturnsResponseSchema,
  RatingResponseSchema,
  ReturnRequestResponseSchema,
  Role,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import {
  createReturnRequest,
  getRating,
  listReturnRequests,
  upsertRating,
} from "./service";

/**
 * Post-delivery feedback endpoints (Batch 3, CUSTOMER):
 * - POST /v1/orders/:id/rating   upsert the order/driver rating (201 new, 200 update)
 * - GET  /v1/orders/:id/rating   the caller's rating, or null
 * - POST /v1/orders/:id/returns  report an issue with a delivered order
 * - GET  /v1/returns             the caller's requests, newest first
 */

const customerOnly = { roles: [Role.CUSTOMER] };

export const feedbackRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Per-user data — never cached by shared caches.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.post(
    "/orders/:id/rating",
    {
      config: customerOnly,
      schema: {
        tags: ["feedback"],
        summary: "Rate a delivered order (upsert — a re-submit updates)",
        params: IdParamsSchema,
        body: CreateRatingBodySchema,
        response: {
          200: RatingResponseSchema,
          201: RatingResponseSchema,
          404: ApiErrorSchema,
          422: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const { rating, created } = await upsertRating(userId, request.params.id, request.body);
      reply.code(created ? 201 : 200);
      return { data: rating };
    },
  );

  typed.get(
    "/orders/:id/rating",
    {
      config: customerOnly,
      schema: {
        tags: ["feedback"],
        summary: "The caller's rating for an order, or null",
        params: IdParamsSchema,
        response: { 200: GetRatingResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await getRating(userId, request.params.id) };
    },
  );

  typed.post(
    "/orders/:id/returns",
    {
      config: customerOnly,
      schema: {
        tags: ["feedback"],
        summary: "Report an issue with a delivered order (one open request per order)",
        params: IdParamsSchema,
        body: CreateReturnBodySchema,
        response: {
          201: ReturnRequestResponseSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          422: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const created = await createReturnRequest(userId, request.params.id, request.body);
      reply.code(201);
      return { data: created };
    },
  );

  typed.get(
    "/returns",
    {
      config: customerOnly,
      schema: {
        tags: ["feedback"],
        summary: "List the caller's return requests (cursor-paginated, newest first)",
        querystring: ListReturnsQuerySchema,
        response: { 200: ListReturnsResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { returns, nextCursor } = await listReturnRequests(userId, request.query);
      return { data: returns, meta: { nextCursor } };
    },
  );
};
