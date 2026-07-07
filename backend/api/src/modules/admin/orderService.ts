import type { Prisma } from "@prisma/client";
import type { AdminOrder, AdminOrderListQuery } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { addDaysStr, istDayStartUtc } from "./dashboardService";
import { toCsv } from "./reportService";

/**
 * Admin order search (BLUEPRINT §7.2 — role ADMIN). Cursor-paginated,
 * newest-first, with status / paymentMethod / rxStatus / IST-date / free-text
 * (orderNo|phone) filters. `format=csv` streams the same filtered set as a
 * flat export instead of a paginated JSON page. Read-only — no mutations.
 */

const CSV_COLUMNS = [
  "orderNo",
  "status",
  "paymentMethod",
  "paymentStatus",
  "totalPaise",
  "customerPhone",
  "createdAt",
] as const;

/** Translate the query filters into a Prisma `where` (shared by JSON + CSV). */
function buildWhere(query: AdminOrderListQuery): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
  if (query.rxStatus) where.rxStatus = query.rxStatus;

  // Inclusive IST calendar range on createdAt (half-open UTC instants).
  if (query.from || query.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = istDayStartUtc(query.from);
    if (query.to) createdAt.lt = istDayStartUtc(addDaysStr(query.to, 1));
    where.createdAt = createdAt;
  }

  // Free-text over orderNo (case-insensitive) OR the customer's phone.
  if (query.search) {
    where.OR = [
      { orderNo: { contains: query.search, mode: "insensitive" } },
      { user: { phone: { contains: query.search } } },
    ];
  }
  return where;
}

const listInclude = {
  user: { select: { name: true, phone: true } },
  _count: { select: { items: true } },
} satisfies Prisma.OrderInclude;

type AdminOrderRow = Prisma.OrderGetPayload<{ include: typeof listInclude }>;

function toAdminOrder(order: AdminOrderRow): AdminOrder {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    requiresRx: order.requiresRx,
    rxStatus: order.rxStatus,
    totalPaise: order.totalPaise,
    itemCount: order._count.items,
    customerName: order.user.name,
    createdAt: order.createdAt.toISOString(),
    placedAt: order.placedAt ? order.placedAt.toISOString() : null,
    readyAt: order.readyAt ? order.readyAt.toISOString() : null,
    userId: order.userId,
    customerPhone: order.user.phone,
  };
}

/** Cursor page (newest-first) of admin order rows for the JSON list. */
export async function listAdminOrders(
  query: AdminOrderListQuery,
): Promise<{ orders: AdminOrder[]; nextCursor: string | null }> {
  const rows = await getPrisma().order.findMany({
    where: buildWhere(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: listInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    orders: page.map(toAdminOrder),
    nextCursor: hasMore && last ? last.id : null,
  };
}

/**
 * CSV export of the full filtered set (pagination intentionally ignored — an
 * export is the whole result, newest-first). Columns per the ops brief §7.
 */
export async function adminOrdersCsv(query: AdminOrderListQuery): Promise<string> {
  const rows = await getPrisma().order.findMany({
    where: buildWhere(query),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { user: { select: { phone: true } } },
  });

  const data: Array<Array<string | number | null>> = rows.map((order) => [
    order.orderNo,
    order.status,
    order.paymentMethod,
    order.paymentStatus,
    order.totalPaise,
    order.user.phone,
    order.createdAt.toISOString(),
  ]);
  return toCsv(CSV_COLUMNS, data);
}
