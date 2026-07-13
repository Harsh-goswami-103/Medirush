import type { OpsAlert } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";

/**
 * Durable ops-alert service (Phase 7 §24). Rows are written by
 * `core/realtime.ts emitOpsAlert` (every socket alert also persists); this
 * module is the morning-review read side: list what happened overnight,
 * acknowledge what has been handled.
 */

interface ListAlertsQuery {
  cursor?: string;
  limit: number;
  includeAcked?: boolean;
}

function toContract(row: {
  id: string;
  kind: string;
  message: string;
  refId: string | null;
  meta: unknown;
  createdAt: Date;
  acknowledgedAt: Date | null;
}): OpsAlert {
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    refId: row.refId,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
  };
}

/** Cursor-paginated, newest-first alerts — unacknowledged only unless `includeAcked`. */
export async function listAlerts(
  q: ListAlertsQuery,
): Promise<{ items: OpsAlert[]; nextCursor: string | null }> {
  const rows = await getPrisma().opsAlert.findMany({
    where: q.includeAcked ? {} : { acknowledgedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(toContract),
    nextCursor: hasMore && last ? last.id : null,
  };
}

/**
 * Acknowledge an alert. Idempotent: the FIRST ack's timestamp sticks — a
 * repeat ack (double-click, two operators) returns the row unchanged.
 * Unknown id → 404 NOT_FOUND.
 */
export async function ackAlert(id: string): Promise<OpsAlert> {
  const prisma = getPrisma();

  // Conditional update — only a still-unacked row gets stamped, so a racing
  // second ack can never overwrite the first acknowledgedAt.
  await prisma.opsAlert.updateMany({
    where: { id, acknowledgedAt: null },
    data: { acknowledgedAt: new Date() },
  });

  const row = await prisma.opsAlert.findUnique({ where: { id } });
  if (!row) throw new AppError("NOT_FOUND", "Alert not found", 404);
  return toContract(row);
}
