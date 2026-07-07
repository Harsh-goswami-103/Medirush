import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RegisterDeviceBodySchema, RegisterDeviceResponseSchema } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { requireSyncedAuth } from "../../plugins/auth";

/**
 * POST /v1/devices — register an FCM token for push (§7.2).
 * Upsert by token: a device that changes hands (logout/login) is re-owned by
 * the new user instead of duplicated. Open to every authenticated role —
 * drivers receive offer pushes, ops receive alerts (§14).
 */
export const deviceRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/devices",
    {
      schema: {
        tags: ["devices"],
        summary: "Register an FCM device token",
        body: RegisterDeviceBodySchema,
        response: { 200: RegisterDeviceResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const { token, platform } = request.body;

      await getPrisma().deviceToken.upsert({
        where: { token },
        create: { token, platform, userId },
        update: { platform, userId },
      });

      void reply.header("cache-control", "no-store");
      return { data: { ok: true as const } };
    },
  );
};
