import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckResponseSchema,
  ApiErrorSchema,
  DeleteAccountBodySchema,
  NotificationPrefsResponseSchema,
  Role,
  UpdateNotificationPrefsBodySchema,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import { deleteOwnAccount, getNotificationPrefs, updateNotificationPrefs } from "./service";

/**
 * Notification consent + account erasure (Batch 3):
 * - GET    /v1/me/notification-prefs   own row (created with defaults on first read)
 * - PATCH  /v1/me/notification-prefs   partial update
 * - DELETE /v1/me                      DPDP-2023 erasure (CUSTOMER; anonymises)
 *
 * The preference endpoints are open to every authenticated role (drivers get
 * pushes too) and only ever touch the caller's own row. Erasure is CUSTOMER-only:
 * driver offboarding and admin removal are separate, obligation-settling flows.
 */
export const preferenceRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: per-user consent and erasure responses are never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/me/notification-prefs",
    {
      schema: {
        tags: ["preferences"],
        summary: "Own notification preferences (all-true defaults on first read)",
        response: { 200: NotificationPrefsResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await getNotificationPrefs(userId) };
    },
  );

  typed.patch(
    "/me/notification-prefs",
    {
      schema: {
        tags: ["preferences"],
        summary: "Update own notification preferences (partial)",
        body: UpdateNotificationPrefsBodySchema,
        response: { 200: NotificationPrefsResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await updateNotificationPrefs(userId, request.body) };
    },
  );

  typed.delete(
    "/me",
    {
      config: { roles: [Role.CUSTOMER] },
      schema: {
        tags: ["preferences"],
        summary: "Delete own account (DPDP erasure — anonymises, keeps statutory records)",
        body: DeleteAccountBodySchema,
        response: { 200: AckResponseSchema, 409: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      await deleteOwnAccount(userId, request.body);
      return { data: { ok: true as const } };
    },
  );
};
