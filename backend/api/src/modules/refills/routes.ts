import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckResponseSchema,
  ApiErrorSchema,
  IdParamsSchema,
  ListRefillsResponseSchema,
  RefillReminderResponseSchema,
  Role,
  UpsertRefillBodySchema,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import { deleteRefill, listRefills, upsertRefill } from "./service";

/**
 * Customer refill reminders (Batch 3, §17 v1.1):
 * - GET    /v1/refills
 * - POST   /v1/refills      (upsert by product)
 * - DELETE /v1/refills/:id
 */

const customerOnly = { roles: [Role.CUSTOMER] };

export const refillRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Personal data — never cache (§12).
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.getHeader("cache-control")) void reply.header("cache-control", "no-store");
  });

  app.get(
    "/refills",
    {
      config: customerOnly,
      schema: {
        tags: ["refills"],
        summary: "List own refill reminders, soonest-due first",
        response: { 200: ListRefillsResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await listRefills(userId) };
    },
  );

  app.post(
    "/refills",
    {
      config: customerOnly,
      schema: {
        tags: ["refills"],
        summary: "Create or update the reminder for a product",
        body: UpsertRefillBodySchema,
        response: { 200: RefillReminderResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await upsertRefill(userId, request.body) };
    },
  );

  app.delete(
    "/refills/:id",
    {
      config: customerOnly,
      schema: {
        tags: ["refills"],
        summary: "Delete an own refill reminder",
        params: IdParamsSchema,
        response: { 200: AckResponseSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      await deleteRefill(userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );
};
