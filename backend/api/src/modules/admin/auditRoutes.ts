import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AdminListAuditLogResponseSchema,
  AuditLogListQuerySchema,
  Role,
} from "@medrush/contracts";
import { listAuditLog } from "./auditService";

/**
 * Admin audit-log read API (Phase 7 hardening — role ADMIN only). The write
 * side is every sensitive mutation's in-transaction `auditLog.create`; this is
 * the inspection surface (who blocked/anonymized/paid what, when). Registered
 * under the /v1 prefix by modules/v1.ts.
 */

const ADMIN_ROLES: Role[] = [Role.ADMIN];

export const adminAuditRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: the audit trail names actors and entities — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/admin/audit-log",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Audit trail (cursor-paginated newest-first; entity/entityId/actorId/action filters)",
        querystring: AuditLogListQuerySchema,
        response: { 200: AdminListAuditLogResponseSchema },
      },
    },
    async (request) => {
      const { entries, nextCursor } = await listAuditLog(request.query);
      return { data: entries, meta: { nextCursor } };
    },
  );
};
