import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckResponseSchema,
  IdParamsSchema,
  ListNotificationsResponseSchema,
  NotificationListQuerySchema,
  UnreadCountResponseSchema,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from "./service";

/**
 * Notification-center endpoints (BLUEPRINT §7.2, Phase 6). Open to every
 * authenticated role — each caller only ever sees/mutates their OWN rows
 * (scoped by `req.auth` userId in the service, never a client-supplied id).
 * - GET  /v1/notifications              cursor-paginated list (newest first)
 * - GET  /v1/notifications/unread-count  badge count
 * - POST /v1/notifications/:id/read      mark one read (idempotent)
 * - POST /v1/notifications/read-all      mark all read
 */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Per-user data — never cached by shared caches.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/notifications",
    {
      schema: {
        tags: ["notifications"],
        summary: "List the caller's notifications (cursor-paginated, newest first)",
        querystring: NotificationListQuerySchema,
        response: { 200: ListNotificationsResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { cursor, limit, unreadOnly } = request.query;
      const { items, nextCursor } = await listNotifications(userId, { cursor, limit, unreadOnly });
      return { data: items, meta: { nextCursor } };
    },
  );

  typed.get(
    "/notifications/unread-count",
    {
      schema: {
        tags: ["notifications"],
        summary: "Count of the caller's unread notifications",
        response: { 200: UnreadCountResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const count = await unreadCount(userId);
      return { data: { count } };
    },
  );

  typed.post(
    "/notifications/:id/read",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark a single notification read (idempotent)",
        params: IdParamsSchema,
        response: { 200: AckResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      await markRead(userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  typed.post(
    "/notifications/read-all",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark all of the caller's notifications read",
        response: { 200: AckResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      await markAllRead(userId);
      return { data: { ok: true as const } };
    },
  );
};
