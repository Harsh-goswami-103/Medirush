import {
  OrderStatus,
  PaymentStatus,
  type DashboardKpis,
  type DashboardQuery,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";

/**
 * Admin dashboard KPIs (BLUEPRINT §7.2, §19) plus the IST calendar helpers the
 * whole analytics module shares (orderService/reportService import them here).
 *
 * Dashboard/report ranges are IST calendar days: we derive the calendar date of
 * an instant with `Intl` (the Asia/Kolkata pattern from core/storeInfo and
 * modules/invoices), and build day boundaries at the fixed +05:30 offset —
 * India has no DST, so the offset is exact and range math never drifts. This is
 * a read-only surface: no mutations, no AuditLog.
 */

/** On-time delivery SLA (§19): deliveredAt − placedAt ≤ 40 min. */
const ON_TIME_SLA_MS = 40 * 60 * 1000;

/* --------------------------------------------------------- IST calendar */

// h23/2-digit parts in Asia/Kolkata; assembled manually so the result is a
// stable `YYYY-MM-DD` regardless of the host locale's default formatting.
const IST_PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** IST calendar date (`YYYY-MM-DD`) for an instant. */
export function istDateString(at: Date): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of IST_PARTS_FORMAT.formatToParts(at)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/** UTC instant at 00:00 IST of a `YYYY-MM-DD` calendar day. */
export function istDayStartUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000+05:30`);
}

/** Shift a `YYYY-MM-DD` string by whole days (calendar arithmetic in UTC). */
export function addDaysStr(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Inclusive IST calendar range `[from, to]` → half-open UTC instants `[gte, lt)`. */
export function istRangeToUtc(from: string, to: string): { gte: Date; lt: Date } {
  return { gte: istDayStartUtc(from), lt: istDayStartUtc(addDaysStr(to, 1)) };
}

/** Dashboard preset → inclusive IST `from`/`to` day strings anchored on `now`. */
export function dashboardRange(
  range: DashboardQuery["range"],
  now: Date,
): { from: string; to: string } {
  const to = istDateString(now);
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  return { from: addDaysStr(to, -(days - 1)), to };
}

/* ------------------------------------------------------------ dashboard */

/**
 * KPIs over the selected IST range. Order metrics are anchored on the event
 * timestamp they describe (placedAt / deliveredAt / cancelledAt); `activeDrivers`
 * and `lowStockCount` are live snapshots, and `codDuePaise` is the standing
 * outstanding balance (COD collected by drivers, not yet reconciled — §9.6).
 */
export async function getDashboard(
  range: DashboardQuery["range"],
  now: Date = new Date(),
): Promise<DashboardKpis> {
  const prisma = getPrisma();
  const { from, to } = dashboardRange(range, now);
  const { gte, lt } = istRangeToUtc(from, to);

  const [ordersPlaced, deliveredRows, ordersCancelled, activeDrivers, lowStock, codDueAgg] =
    await Promise.all([
      prisma.order.count({ where: { placedAt: { gte, lt } } }),
      prisma.order.findMany({
        where: { status: OrderStatus.DELIVERED, deliveredAt: { gte, lt } },
        select: { placedAt: true, deliveredAt: true, totalPaise: true },
      }),
      prisma.order.count({
        where: { status: OrderStatus.CANCELLED, cancelledAt: { gte, lt } },
      }),
      prisma.driverProfile.count({ where: { isOnline: true } }),
      // Column-to-column compare (stockQty ≤ lowStockThreshold) is not expressible
      // in the Prisma query builder — a scalar raw count is the cleanest route.
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM "Product"
        WHERE "isActive" = true AND "stockQty" <= "lowStockThreshold"
      `,
      prisma.order.aggregate({
        _sum: { totalPaise: true },
        where: { paymentStatus: PaymentStatus.COD_DUE },
      }),
    ]);

  const ordersDelivered = deliveredRows.length;
  const revenuePaise = deliveredRows.reduce((sum, row) => sum + row.totalPaise, 0);
  const aovPaise = ordersDelivered > 0 ? Math.round(revenuePaise / ordersDelivered) : 0;

  const onTime = deliveredRows.filter(
    (row) =>
      row.placedAt !== null &&
      row.deliveredAt !== null &&
      row.deliveredAt.getTime() - row.placedAt.getTime() <= ON_TIME_SLA_MS,
  ).length;
  // One decimal is enough (§7.2); guard the empty-range division.
  const onTimePct = ordersDelivered > 0 ? Math.round((onTime / ordersDelivered) * 1000) / 10 : 0;

  return {
    range,
    ordersPlaced,
    ordersDelivered,
    ordersCancelled,
    revenuePaise,
    aovPaise,
    onTimePct,
    activeDrivers,
    lowStockCount: Number(lowStock[0]?.count ?? 0),
    codDuePaise: codDueAgg._sum.totalPaise ?? 0,
  };
}
