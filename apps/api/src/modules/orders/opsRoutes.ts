import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  GetOpsOrderResponseSchema,
  IdParamsSchema,
  OpsCancelOrderBodySchema,
  OpsCancelOrderResponseSchema,
  OpsListOrdersResponseSchema,
  OpsOrderListQuerySchema,
  ReadyBodySchema,
  ReadyResponseSchema,
  Role,
  RxReviewBodySchema,
  RxReviewResponseSchema,
  StartPackingResponseSchema,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import {
  getOpsDetail,
  listOps,
  markReady,
  opsCancel,
  rxReview,
  startPacking,
  type OpsActor,
} from "./opsService";

/**
 * Ops order queue + actions (BLUEPRINT §7.2 ops rows; RBAC §8.3: INVENTORY or
 * ADMIN). Registered under the /v1 prefix by modules/v1.ts.
 */

const OPS_ROLES: Role[] = [Role.INVENTORY, Role.ADMIN];

function requireActor(request: FastifyRequest): OpsActor {
  const auth = request.auth;
  if (!auth?.userId || !auth.role) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return { userId: auth.userId, role: auth.role };
}

export const opsOrderRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: ops order board / working detail is live data — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/ops/orders",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Live order queue (cursor-paginated, optional status filter)",
        querystring: OpsOrderListQuerySchema,
        response: { 200: OpsListOrdersResponseSchema },
      },
    },
    async (request) => {
      const { orders, nextCursor } = await listOps(request.query);
      return { data: orders, meta: { nextCursor } };
    },
  );

  typed.get(
    "/ops/orders/:id",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Full order detail incl. FEFO pre-fill for PACKING orders",
        params: IdParamsSchema,
        response: { 200: GetOpsOrderResponseSchema },
      },
    },
    async (request) => ({ data: await getOpsDetail(request.params.id) }),
  );

  typed.post(
    "/ops/orders/:id/rx-review",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Approve/reject the prescription on an RX_REVIEW order (reject → cancel+refund)",
        params: IdParamsSchema,
        body: RxReviewBodySchema,
        response: { 200: RxReviewResponseSchema },
      },
    },
    async (request) => ({
      data: await rxReview(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.post(
    "/ops/orders/:id/start-packing",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "PLACED/RX_REVIEW(approved) → PACKING",
        params: IdParamsSchema,
        response: { 200: StartPackingResponseSchema },
      },
    },
    async (request) => ({
      data: await startPacking(request.params.id, requireActor(request)),
    }),
  );

  typed.post(
    "/ops/orders/:id/ready",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "PACKING → READY with confirmed batch allocations (FEFO-prefilled)",
        params: IdParamsSchema,
        body: ReadyBodySchema,
        response: { 200: ReadyResponseSchema },
      },
    },
    async (request) => ({
      data: await markReady(request.params.id, request.body.allocations, requireActor(request)),
    }),
  );

  typed.post(
    "/ops/orders/:id/cancel",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Cancel any pre-DELIVERED order (restock per §18.3)",
        params: IdParamsSchema,
        body: OpsCancelOrderBodySchema,
        response: { 200: OpsCancelOrderResponseSchema },
      },
    },
    async (request) => ({
      data: await opsCancel(request.params.id, request.body.reason, requireActor(request)),
    }),
  );
};
