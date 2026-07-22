import {
  OrderStatus,
  type CreateRatingBody,
  type CreateReturnBody,
  type CursorQuery,
  type Rating,
  type ReturnReason,
  type ReturnRequest,
  type ReturnStatus,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { emitOpsAlert } from "../../core/realtime";
import { notifyUser } from "../notifications/service";

/**
 * Post-delivery feedback (Batch 3): order/driver ratings and return requests.
 *
 * Both surfaces are owner-scoped in the query `where` and DELIVERED-only, so a
 * foreign or in-flight order is indistinguishable from a missing one (§8.3). A
 * return raises a durable ops alert so the pharmacist has a worklist row.
 */

const RATE_GATE = "You can rate an order once it is delivered";
const RETURN_GATE = "You can report an issue once the order is delivered";

/** Own + DELIVERED order, or 404/422. Never leaks another customer's order. */
async function requireDeliveredOwnOrder(userId: string, orderId: string, gateMessage: string) {
  const order = await getPrisma().order.findFirst({
    where: { id: orderId, userId },
    select: { id: true, orderNo: true, status: true },
  });
  if (!order) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  if (order.status !== OrderStatus.DELIVERED) {
    throw new AppError("VALIDATION_ERROR", gateMessage, 422);
  }
  return order;
}

function toRating(row: {
  id: string;
  orderId: string;
  orderStars: number;
  driverStars: number | null;
  comment: string | null;
  createdAt: Date;
}): Rating {
  return {
    id: row.id,
    orderId: row.orderId,
    orderStars: row.orderStars,
    driverStars: row.driverStars,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

function toReturnRequest(
  row: {
    id: string;
    orderId: string;
    reason: string;
    note: string | null;
    status: string;
    resolutionNote: string | null;
    createdAt: Date;
    resolvedAt: Date | null;
  },
  orderNo: string,
): ReturnRequest {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo,
    reason: row.reason as ReturnReason,
    note: row.note,
    status: row.status as ReturnStatus,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/**
 * POST /v1/orders/:id/rating — upsert keyed on the one-per-order `orderId`, so
 * a double submit updates instead of erroring. The submit is a whole-form
 * replace: an omitted `driverStars`/`comment` clears the stored value.
 */
export async function upsertRating(
  userId: string,
  orderId: string,
  body: CreateRatingBody,
): Promise<{ rating: Rating; created: boolean }> {
  await requireDeliveredOwnOrder(userId, orderId, RATE_GATE);

  if (body.driverStars !== undefined) {
    const delivery = await getPrisma().delivery.findUnique({
      where: { orderId },
      select: { id: true },
    });
    if (!delivery) {
      throw new AppError("VALIDATION_ERROR", "This order had no delivery partner to rate", 422);
    }
  }

  const driverStars = body.driverStars ?? null;
  const comment = body.comment ?? null;
  const existing = await getPrisma().rating.findUnique({
    where: { orderId },
    select: { id: true },
  });
  const row = await getPrisma().rating.upsert({
    where: { orderId },
    create: { orderId, userId, orderStars: body.orderStars, driverStars, comment },
    update: { orderStars: body.orderStars, driverStars, comment },
  });

  return { rating: toRating(row), created: existing === null };
}

/** GET /v1/orders/:id/rating — own order only; null until the customer rates. */
export async function getRating(userId: string, orderId: string): Promise<Rating | null> {
  const order = await getPrisma().order.findFirst({
    where: { id: orderId, userId },
    select: { id: true },
  });
  if (!order) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  const row = await getPrisma().rating.findFirst({ where: { orderId, userId } });
  return row ? toRating(row) : null;
}

/**
 * POST /v1/orders/:id/returns — one open request at a time per order; the
 * pharmacist works it off the RETURN_REQUESTED ops alert.
 */
export async function createReturnRequest(
  userId: string,
  orderId: string,
  body: CreateReturnBody,
): Promise<ReturnRequest> {
  const order = await requireDeliveredOwnOrder(userId, orderId, RETURN_GATE);

  const open = await getPrisma().returnRequest.findFirst({
    where: { orderId, userId, status: "REQUESTED" },
    select: { id: true },
  });
  if (open) {
    throw new AppError("CONFLICT", "A return request for this order is already open", 409);
  }

  const row = await getPrisma().returnRequest.create({
    data: {
      orderId,
      userId,
      reason: body.reason,
      note: body.note ?? null,
      status: "REQUESTED",
    },
  });

  emitOpsAlert(
    "RETURN_REQUESTED",
    `Return requested for order ${order.orderNo}: ${body.reason}`,
    row.id,
    { orderId, orderNo: order.orderNo, reason: body.reason, note: row.note },
  );
  await notifyUser({
    userId,
    type: "RETURN_REQUESTED",
    title: "We got your request",
    body: `We're reviewing the issue you reported on order ${order.orderNo}.`,
    data: { orderId, returnId: row.id },
  });

  return toReturnRequest(row, order.orderNo);
}

/** GET /v1/returns — the caller's own requests, newest first, cursor-paginated. */
export async function listReturnRequests(
  userId: string,
  query: CursorQuery,
): Promise<{ returns: ReturnRequest[]; nextCursor: string | null }> {
  const rows = await getPrisma().returnRequest.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { order: { select: { orderNo: true } } },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    returns: page.map((row) => toReturnRequest(row, row.order.orderNo)),
    nextCursor: hasMore && last ? last.id : null,
  };
}
