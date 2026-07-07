import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CancelOrderBodySchema,
  CancelOrderResponseSchema,
  CreateOrderBodySchema,
  CreateOrderResponseSchema,
  GetOrderResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdParamsSchema,
  ListOrdersResponseSchema,
  OrderInvoiceResponseSchema,
  OrderListQuerySchema,
  Role,
  TrackOrderResponseSchema,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import { withIdempotency } from "../../core/idempotency";
import { requireSyncedAuth } from "../../plugins/auth";
import { getInvoiceUrl } from "../invoices/service";
import {
  cancelOrder,
  createOrder,
  getOrder,
  listOrders,
  trackOrder,
} from "./service";

/**
 * Customer order endpoints (BLUEPRINT §7.2 — Customer; RBAC §8.3: CUSTOMER):
 * - POST   /v1/orders            (Idempotency-Key required → 400 if absent)
 * - GET    /v1/orders            (cursor-paginated own history)
 * - GET    /v1/orders/:id        (own order detail)
 * - GET    /v1/orders/:id/track  (status + driver-location polling fallback)
 * - POST   /v1/orders/:id/cancel (§18.3 customer matrix)
 *
 * §12: orders are never cacheable — every response is `no-store`.
 */

const customerOnly = { roles: [Role.CUSTOMER] };

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.post(
    "/orders",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Create a COD order from the server cart (Idempotency-Key required)",
        body: CreateOrderBodySchema,
        response: { 200: CreateOrderResponseSchema, 201: CreateOrderResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);

      const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (key.length === 0) {
        throw new AppError("VALIDATION_ERROR", "Idempotency-Key header is required", 400);
      }

      const result = await withIdempotency(key, userId, () => createOrder(userId, request.body));
      reply.code(result.replayed ? 200 : 201);
      return { data: result.response };
    },
  );

  typed.get(
    "/orders",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Order history (cursor-paginated, optional status filter)",
        querystring: OrderListQuerySchema,
        response: { 200: ListOrdersResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { orders, nextCursor } = await listOrders(userId, request.query);
      return { data: orders, meta: { nextCursor } };
    },
  );

  typed.get(
    "/orders/:id",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Order detail (owner; OTP visible only to the owner once READY)",
        params: IdParamsSchema,
        response: { 200: GetOrderResponseSchema },
      },
    },
    async (request) => {
      const { userId, role } = requireSyncedAuth(request);
      return { data: await getOrder(userId, role, request.params.id) };
    },
  );

  typed.get(
    "/orders/:id/track",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Live status + driver-location polling fallback",
        params: IdParamsSchema,
        response: { 200: TrackOrderResponseSchema },
      },
    },
    async (request) => {
      const { userId, role } = requireSyncedAuth(request);
      return { data: await trackOrder(userId, role, request.params.id) };
    },
  );

  typed.get(
    "/orders/:id/invoice",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Presigned GST invoice PDF URL (owner; 409 until generated post-DELIVERED)",
        params: IdParamsSchema,
        response: { 200: OrderInvoiceResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await getInvoiceUrl(request.params.id, userId) };
    },
  );

  typed.post(
    "/orders/:id/cancel",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Cancel per the §18.3 customer matrix",
        params: IdParamsSchema,
        body: CancelOrderBodySchema,
        response: { 200: CancelOrderResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await cancelOrder(userId, request.params.id, request.body.reason) };
    },
  );
};
