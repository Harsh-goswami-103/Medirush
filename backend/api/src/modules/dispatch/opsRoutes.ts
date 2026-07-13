import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  IdParamsSchema,
  OpsAssignBodySchema,
  OpsAssignResponseSchema,
  OpsRedispatchResponseSchema,
  OpsUnassignBodySchema,
  OpsUnassignResponseSchema,
  OrderStatus,
  Role,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import { assignDriver, redispatchOrder, unassignDriver, type DispatchOpsActor } from "./service";

/**
 * Ops dispatch-recovery actions (Phase 7 — RBAC §8.3: INVENTORY or ADMIN).
 * Once both offer waves expire, nothing re-offers an order automatically; these
 * endpoints are the manual escape hatches: assign a driver directly, restart
 * the offer waves, or undo a pre-pickup assignment. Registered under the /v1
 * prefix by modules/v1.ts.
 */

const OPS_ROLES: Role[] = [Role.INVENTORY, Role.ADMIN];

function requireActor(request: FastifyRequest): DispatchOpsActor {
  const auth = request.auth;
  if (!auth?.userId || !auth.role) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return { userId: auth.userId, role: auth.role };
}

export const dispatchOpsRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: dispatch state is live data — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.post(
    "/ops/orders/:id/assign",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Manually assign a verified driver to a READY order (READY → ASSIGNED)",
        params: IdParamsSchema,
        body: OpsAssignBodySchema,
        response: { 200: OpsAssignResponseSchema },
      },
    },
    async (request) => {
      const delivery = await assignDriver(
        request.params.id,
        request.body.driverId,
        requireActor(request),
      );
      return {
        data: {
          orderId: delivery.orderId,
          status: OrderStatus.ASSIGNED,
          deliveryId: delivery.id,
          driverId: delivery.driverId,
          acceptedAt: delivery.acceptedAt.toISOString(),
        },
      };
    },
  );

  typed.post(
    "/ops/orders/:id/redispatch",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Restart the offer waves for a READY order (clears stale EXPIRED/REJECTED offers)",
        params: IdParamsSchema,
        response: { 200: OpsRedispatchResponseSchema },
      },
    },
    async (request) => {
      const { clearedOffers, offersCreated } = await redispatchOrder(
        request.params.id,
        requireActor(request),
      );
      return {
        data: {
          orderId: request.params.id,
          status: OrderStatus.READY,
          clearedOffers,
          offersCreated,
        },
      };
    },
  );

  typed.post(
    "/ops/orders/:id/unassign",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Un-assign a pre-pickup order (ASSIGNED → READY); optional immediate re-dispatch",
        params: IdParamsSchema,
        // nullish: a body-less POST surfaces as `null` (not undefined) in Fastify.
        body: OpsUnassignBodySchema.nullish(),
        response: { 200: OpsUnassignResponseSchema },
      },
    },
    async (request) => {
      const redispatch = request.body?.redispatch === true;
      const result = await unassignDriver(request.params.id, requireActor(request), redispatch);
      return {
        data: {
          orderId: request.params.id,
          status: OrderStatus.READY,
          ...result,
        },
      };
    },
  );
};
