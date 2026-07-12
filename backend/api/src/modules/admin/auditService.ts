import type { Prisma } from "@prisma/client";
import type { AuditLogEntry, AuditLogListQuery } from "@medrush/contracts";
import { getPrisma } from "../../core/db";

/**
 * Admin audit-log read side (Phase 7 hardening). Every sensitive mutation
 * already writes an AuditLog row; this service makes the trail inspectable —
 * cursor-paginated newest-first with entity/actor/action filters. Read-only:
 * AuditLog rows are append-only and never mutated or deleted.
 */

function toContract(row: {
  id: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  meta: unknown;
  createdAt: Date;
}): AuditLogEntry {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /v1/admin/audit-log — newest first; all provided filters AND-combine. */
export async function listAuditLog(
  query: AuditLogListQuery,
): Promise<{ entries: AuditLogEntry[]; nextCursor: string | null }> {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.entity ? { entity: query.entity } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.action ? { action: query.action } : {}),
  };

  const rows = await getPrisma().auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    entries: page.map(toContract),
    nextCursor: hasMore && last ? last.id : null,
  };
}
