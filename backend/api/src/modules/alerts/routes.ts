import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckOpsAlertResponseSchema,
  IdParamsSchema,
  ListOpsAlertsResponseSchema,
  OpsAlertListQuerySchema,
  Role,
} from "@medrush/contracts";
import { ackAlert, listAlerts } from "./service";

/**
 * Durable ops alerts (Phase 7 §24 — role INVENTORY or ADMIN). The write side is
 * `emitOpsAlert` (core/realtime.ts); these endpoints are the morning review:
 * - GET  /v1/ops/alerts          cursor-paginated, newest first, unacked by default
 * - POST /v1/ops/alerts/:id/ack  idempotent acknowledge
 * Registered under the /v1 prefix by modules/v1.ts.
 */

const OPS_ROLES: Role[] = [Role.INVENTORY, Role.ADMIN];

export const opsAlertRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: alert state is live data — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/ops/alerts",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Durable ops alerts (cursor-paginated, newest first, unacked by default)",
        querystring: OpsAlertListQuerySchema,
        response: { 200: ListOpsAlertsResponseSchema },
      },
    },
    async (request) => {
      const { items, nextCursor } = await listAlerts(request.query);
      return { data: items, meta: { nextCursor } };
    },
  );

  typed.post(
    "/ops/alerts/:id/ack",
    {
      config: { roles: OPS_ROLES },
      schema: {
        tags: ["ops"],
        summary: "Acknowledge an alert (idempotent — the first ack's timestamp sticks)",
        params: IdParamsSchema,
        response: { 200: AckOpsAlertResponseSchema },
      },
    },
    async (request) => ({ data: await ackAlert(request.params.id) }),
  );
};
