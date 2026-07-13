import { randomInt } from "node:crypto";
import {
  ActorType,
  FEFO_MIN_SHELF_LIFE_DAYS,
  OrderStatus,
  PaymentMethod,
  Role,
  RxStatus,
  type AddressSnapshot,
  type FefoSuggestion,
  type GstRate,
  type OpsOrderDetail,
  type OpsOrderItem,
  type OpsOrderListQuery,
  type OpsOrderSummary,
  type ReadyAllocation,
  type RxReviewBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { clearDriverLocation } from "../../core/locationStore";
import { logger } from "../../core/logger";
import { emitOrderStatus } from "../../core/realtime";
import { presignPrivateGet } from "../../core/storage";
import { dispatchOrder } from "../dispatch/service";
import { proposeFefo } from "../inventory/fefo";
import { commitAllocations } from "../inventory/service";
import { notifyUser } from "../notifications/service";
import { initiateRefund } from "../payments/service";
import { restockOrder } from "./service";
import { assertTransition } from "./stateMachine";

/**
 * Ops-side order actions (BLUEPRINT §7.2 ops rows, §9.4 FEFO, §18.3 cancel).
 * Ownership/role gating happens in opsRoutes; state legality is asserted via
 * agent C's state machine INSIDE the transaction; socket emits AFTER commit.
 */

export interface OpsActor {
  userId: string;
  role: Role;
}

/** Note written by the customer-cancel flow on PACKING/READY orders (§18.3). */
const CANCEL_REQUESTED_NOTE = "cancel-requested";

/** TTL for the ops prescription-viewer presigned GET (~10 min, §13). */
const OPS_RX_URL_TTL_SEC = 600;

/** Ops detail plus a derived cancel-requested marker (see contract mismatch note). */
export type OpsOrderDetailWithMarker = OpsOrderDetail & { cancelRequested: boolean };

const actorTypeFor = (role: Role): ActorType =>
  role === Role.ADMIN ? ActorType.ADMIN : ActorType.OPS;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

/* ---------------------------------------------------------------- queries */

export async function listOps(
  query: OpsOrderListQuery,
): Promise<{ orders: OpsOrderSummary[]; nextCursor: string | null }> {
  const prisma = getPrisma();
  const rows = await prisma.order.findMany({
    where: query.status ? { status: query.status } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      user: { select: { name: true } },
      _count: { select: { items: true } },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    orders: page.map((order) => ({
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
      placedAt: isoOrNull(order.placedAt),
      readyAt: isoOrNull(order.readyAt),
    })),
    nextCursor: hasMore && last ? last.id : null,
  };
}

export async function getOpsDetail(id: string): Promise<OpsOrderDetailWithMarker> {
  const prisma = getPrisma();
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      items: { include: { allocations: true } },
      prescriptions: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      delivery: {
        include: { driver: { include: { user: { select: { name: true, phone: true } } } } },
      },
    },
  });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);

  // Product lookups (bin location + live batches for the FEFO pre-fill).
  // OrderItem intentionally has no Product relation — snapshots are the truth.
  const productIds = [...new Set(order.items.map((item) => item.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      binLocation: true,
      batches: {
        where: { qtyAvailable: { gt: 0 } },
        select: { id: true, batchNo: true, expiryDate: true, qtyAvailable: true },
      },
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const today = new Date();
  const items: OpsOrderItem[] = order.items.map((item) => {
    const product = productById.get(item.productId);

    // FEFO proposal only while the order sits on the packing screen and the
    // item has not been allocated yet (§9.4; contract: "empty once allocated").
    const fefoSuggestions: FefoSuggestion[] = [];
    if (order.status === OrderStatus.PACKING && item.allocations.length === 0 && product) {
      const { allocations } = proposeFefo(item.qty, product.batches, today);
      const batchById = new Map(product.batches.map((b) => [b.id, b]));
      for (const alloc of allocations) {
        const batch = batchById.get(alloc.batchId);
        if (!batch) continue;
        fefoSuggestions.push({
          batchId: batch.id,
          batchNo: batch.batchNo,
          expiryDate: isoDate(batch.expiryDate),
          qtyAvailable: batch.qtyAvailable,
          qty: alloc.qty,
        });
      }
    }

    return {
      id: item.id,
      productId: item.productId,
      nameSnap: item.nameSnap,
      packSizeSnap: item.packSizeSnap,
      pricePaise: item.pricePaise,
      mrpPaise: item.mrpPaise,
      gstRatePct: item.gstRatePct as GstRate,
      hsnSnap: item.hsnSnap,
      requiresRx: item.requiresRx,
      qty: item.qty,
      binLocation: product?.binLocation ?? "",
      allocations: item.allocations.map((alloc) => ({
        batchId: alloc.batchId,
        batchNoSnap: alloc.batchNoSnap,
        expirySnap: isoDate(alloc.expirySnap),
        qty: alloc.qty,
      })),
      fefoSuggestions,
    };
  });

  const snap = order.addressSnapshot as unknown as AddressSnapshot;
  const cancelRequested =
    order.status !== OrderStatus.CANCELLED &&
    order.status !== OrderStatus.DELIVERED &&
    order.events.some((event) => event.note === CANCEL_REQUESTED_NOTE);

  // Short-TTL presigned GETs for the zoomable prescription viewer (§13). Real
  // R2 URLs in prod, syntactically-valid stub URLs in dev/test — never the key.
  const prescriptions = await Promise.all(
    order.prescriptions.map(async (rx) => ({
      id: rx.id,
      status: rx.status,
      mimeType: rx.mimeType,
      fileUrl: await presignPrivateGet(rx.fileKey, OPS_RX_URL_TTL_SEC),
      patientName: rx.patientName,
      doctorName: rx.doctorName,
      reviewNote: rx.reviewNote,
      createdAt: rx.createdAt.toISOString(),
      reviewedAt: isoOrNull(rx.reviewedAt),
    })),
  );

  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    addressSnapshot: snap,
    distanceM: order.distanceM,
    itemsPaise: order.itemsPaise,
    deliveryPaise: order.deliveryPaise,
    discountPaise: order.discountPaise,
    totalPaise: order.totalPaise,
    couponCode: order.couponCode,
    requiresRx: order.requiresRx,
    rxStatus: order.rxStatus,
    cancelReason: order.cancelReason,
    invoiceNo: order.invoiceNo,
    placedAt: isoOrNull(order.placedAt),
    packedAt: isoOrNull(order.packedAt),
    readyAt: isoOrNull(order.readyAt),
    deliveredAt: isoOrNull(order.deliveredAt),
    cancelledAt: isoOrNull(order.cancelledAt),
    createdAt: order.createdAt.toISOString(),
    customer: { id: order.user.id, name: order.user.name, phone: order.user.phone },
    items,
    prescriptions,
    events: order.events.map((event) => ({
      from: event.from,
      to: event.to,
      actorType: event.actorType,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
    delivery: order.delivery
      ? {
          driverId: order.delivery.driverId,
          driverName: order.delivery.driver.user.name,
          driverPhone: order.delivery.driver.user.phone,
          acceptedAt: order.delivery.acceptedAt.toISOString(),
          pickedUpAt: isoOrNull(order.delivery.pickedUpAt),
          deliveredAt: isoOrNull(order.delivery.deliveredAt),
          codCollectedPaise: order.delivery.codCollectedPaise,
        }
      : null,
    cancelRequested,
  };
}

/* ---------------------------------------------------------------- actions */

/**
 * Rx review (§7.2, §9.1; phase-2 brief §6) — INVENTORY/ADMIN adjudicate the
 * latest prescription on an RX_REVIEW order.
 *
 * - APPROVED: mark the latest Prescription + order rxStatus APPROVED (the order
 *   STAYS RX_REVIEW so ops can now start-packing — the P1 gate already checks
 *   rxStatus APPROVED); patientName/doctorName are captured for the Schedule H1
 *   register.
 * - REJECTED: order → CANCELLED + restock + rxStatus/Prescription REJECTED +
 *   reviewNote; a paid PREPAID payment is refunded post-commit (external, §14).
 *   A note is contract-required for a rejection.
 *
 * AuditLog is written for both outcomes (sensitive action).
 */
export async function rxReview(
  id: string,
  body: RxReviewBody,
  actor: OpsActor,
): Promise<OpsOrderDetailWithMarker> {
  const prisma = getPrisma();
  const actorType = actorTypeFor(actor.role);

  const order = await prisma.order.findUnique({
    where: { id },
    select: { status: true, requiresRx: true, rxStatus: true, userId: true, orderNo: true },
  });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
  if (!order.requiresRx || order.status !== OrderStatus.RX_REVIEW) {
    throw new AppError("CONFLICT", "This order is not awaiting prescription review", 409, {
      status: order.status,
    });
  }
  // Idempotent APPROVE: an APPROVE'd order stays in RX_REVIEW (only rxStatus flips),
  // so without this guard a retry/double-click would re-fire the notification, the
  // socket emit and a duplicate audit row. A re-REJECT is already blocked above
  // (reject moves the order to CANCELLED, so status !== RX_REVIEW).
  if (body.status === RxStatus.APPROVED && order.rxStatus === RxStatus.APPROVED) {
    return getOpsDetail(id);
  }

  // The prescription under review is the latest upload.
  const latestRx = await prisma.prescription.findFirst({
    where: { orderId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (body.status === RxStatus.APPROVED) {
    if (!latestRx) {
      throw new AppError("VALIDATION_ERROR", "No prescription has been uploaded to approve", 422);
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.prescription.update({
        where: { id: latestRx.id },
        data: {
          status: RxStatus.APPROVED,
          reviewerId: actor.userId,
          reviewedAt: now,
          patientName: body.patientName ?? undefined,
          doctorName: body.doctorName ?? undefined,
          reviewNote: body.note ?? undefined,
        },
      });
      // Order stays RX_REVIEW; only rxStatus flips (unblocks start-packing).
      const updated = await tx.order.updateMany({
        where: { id, status: OrderStatus.RX_REVIEW },
        data: { rxStatus: RxStatus.APPROVED },
      });
      if (updated.count !== 1) {
        throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "RX_APPROVED",
          entity: "Order",
          entityId: id,
          meta: {
            prescriptionId: latestRx.id,
            patientName: body.patientName ?? null,
            doctorName: body.doctorName ?? null,
          },
        },
      });
    });

    emitOrderStatus({ id, status: OrderStatus.RX_REVIEW, rxStatus: RxStatus.APPROVED });
    await notifyUser({
      userId: order.userId,
      type: "ORDER_RX_APPROVED",
      title: "Prescription approved",
      body: `Your prescription for order ${order.orderNo} was approved — we're preparing it now.`,
      data: { orderId: id },
    });
    return getOpsDetail(id);
  }

  // REJECTED — the contract enforces a note (RxReviewBodySchema); guard anyway.
  const note = body.note;
  if (!note) {
    throw new AppError("VALIDATION_ERROR", "A note is required to reject a prescription", 422);
  }

  await prisma.$transaction(async (tx) => {
    assertTransition(OrderStatus.RX_REVIEW, OrderStatus.CANCELLED, actorType);
    const updated = await tx.order.updateMany({
      where: { id, status: OrderStatus.RX_REVIEW },
      data: {
        status: OrderStatus.CANCELLED,
        rxStatus: RxStatus.REJECTED,
        cancelReason: note,
        cancelledAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
    }
    await restockOrder(tx, id);
    if (latestRx) {
      await tx.prescription.update({
        where: { id: latestRx.id },
        data: {
          status: RxStatus.REJECTED,
          reviewerId: actor.userId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });
    }
    await tx.orderEvent.create({
      data: {
        orderId: id,
        from: OrderStatus.RX_REVIEW,
        to: OrderStatus.CANCELLED,
        actorType,
        actorId: actor.userId,
        note,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "RX_REJECTED",
        entity: "Order",
        entityId: id,
        meta: { prescriptionId: latestRx?.id ?? null, note },
      },
    });
  });

  // External refund OUTSIDE the tx (§14) — no-op for COD / unpaid prepaid.
  await initiateRefund(id);
  emitOrderStatus({ id, status: OrderStatus.CANCELLED });
  clearDriverLocation(id);
  // Rx rejection is a cancellation, but the customer gets the specific rejection
  // notice (not a generic ORDER_CANCELLED) — do not double-notify.
  await notifyUser({
    userId: order.userId,
    type: "ORDER_RX_REJECTED",
    title: "Prescription not approved",
    body: `Your prescription for order ${order.orderNo} couldn't be approved: ${note}. The order was cancelled and any payment refunded.`,
    data: { orderId: id },
  });
  return getOpsDetail(id);
}

/** PLACED/RX_REVIEW(approved) → PACKING (§7.2). RX_REVIEW without approval → 422 RX_REQUIRED. */
export async function startPacking(id: string, actor: OpsActor): Promise<OpsOrderDetailWithMarker> {
  const prisma = getPrisma();
  const actorType = actorTypeFor(actor.role);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id },
      select: { status: true, rxStatus: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);

    if (order.status === OrderStatus.RX_REVIEW && order.rxStatus !== RxStatus.APPROVED) {
      throw new AppError(
        "RX_REQUIRED",
        "Prescription must be approved before packing can start",
        422,
        { rxStatus: order.rxStatus },
      );
    }
    assertTransition(order.status, OrderStatus.PACKING, actorType);

    const updated = await tx.order.updateMany({
      where: { id, status: order.status },
      data: { status: OrderStatus.PACKING, packedAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
    }

    await tx.orderEvent.create({
      data: {
        orderId: id,
        from: order.status,
        to: OrderStatus.PACKING,
        actorType,
        actorId: actor.userId,
      },
    });
  });

  emitOrderStatus({ id, status: OrderStatus.PACKING });
  return getOpsDetail(id);
}

/**
 * PACKING → READY (§9.4/§9.7). Validates every order item is FULLY allocated
 * (Σ qty per item === item qty, unknown items rejected, batches must belong to
 * the item's product), commits allocations with conditional batch decrements,
 * generates the 4-digit delivery OTP and stamps readyAt.
 */
export async function markReady(
  id: string,
  allocations: ReadyAllocation[],
  actor: OpsActor,
): Promise<OpsOrderDetailWithMarker> {
  const prisma = getPrisma();
  const actorType = actorTypeFor(actor.role);

  let customerUserId = "";
  let customerOrderNo = "";
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id },
      include: { items: { select: { id: true, qty: true, productId: true } } },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    assertTransition(order.status, OrderStatus.READY, actorType);
    customerUserId = order.userId;
    customerOrderNo = order.orderNo;

    // Every allocation must reference a known order item…
    const itemById = new Map(order.items.map((item) => [item.id, item]));
    const allocatedByItem = new Map<string, number>();
    for (const alloc of allocations) {
      if (!itemById.has(alloc.orderItemId)) {
        throw new AppError("VALIDATION_ERROR", "Allocation references an unknown order item", 422, {
          orderItemId: alloc.orderItemId,
        });
      }
      allocatedByItem.set(
        alloc.orderItemId,
        (allocatedByItem.get(alloc.orderItemId) ?? 0) + alloc.qty,
      );
    }

    // …and every item must be exactly covered.
    const mismatches = order.items
      .filter((item) => (allocatedByItem.get(item.id) ?? 0) !== item.qty)
      .map((item) => ({
        orderItemId: item.id,
        requiredQty: item.qty,
        allocatedQty: allocatedByItem.get(item.id) ?? 0,
      }));
    if (mismatches.length > 0) {
      throw new AppError("VALIDATION_ERROR", "Every order item must be fully allocated", 422, {
        mismatches,
      });
    }

    // Batches must exist and belong to the item's product (traceability).
    const batchIds = [...new Set(allocations.map((alloc) => alloc.batchId))];
    const batches = await tx.batch.findMany({
      where: { id: { in: batchIds } },
      select: { id: true, productId: true, expiryDate: true },
    });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    // Re-enforce the FEFO shelf-life cutoff at commit (§9.4): proposeFefo only
    // pre-fills the UI suggestion, but the allocations in the PATCH body are
    // client-controlled — an expired / near-expiry batch must never be dispensed
    // (nor snapshotted onto the Schedule-H1 register).
    const shelfCutoffMs = Date.now() + FEFO_MIN_SHELF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    for (const alloc of allocations) {
      const batch = batchById.get(alloc.batchId);
      const item = itemById.get(alloc.orderItemId);
      if (!batch || !item || batch.productId !== item.productId) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Allocation batch does not belong to the order item's product",
          422,
          { batchId: alloc.batchId, orderItemId: alloc.orderItemId },
        );
      }
      if (batch.expiryDate.getTime() <= shelfCutoffMs) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Allocation batch is expired or within the minimum shelf life",
          422,
          { batchId: alloc.batchId, expiryDate: batch.expiryDate.toISOString() },
        );
      }
    }

    // Flip status first: the conditional update takes the order row lock, so a
    // concurrent double-ready aborts before any batch is decremented.
    const otp = String(randomInt(0, 10_000)).padStart(4, "0");
    const updated = await tx.order.updateMany({
      where: { id, status: order.status },
      data: { status: OrderStatus.READY, readyAt: new Date(), deliveryOtp: otp },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
    }

    for (const item of order.items) {
      const itemAllocs = allocations
        .filter((alloc) => alloc.orderItemId === item.id)
        .map((alloc) => ({ batchId: alloc.batchId, qty: alloc.qty }));
      await commitAllocations(tx, item.id, itemAllocs);
    }

    await tx.orderEvent.create({
      data: {
        orderId: id,
        from: order.status,
        to: OrderStatus.READY,
        actorType,
        actorId: actor.userId,
      },
    });
  });

  emitOrderStatus({ id, status: OrderStatus.READY });
  await notifyUser({
    userId: customerUserId,
    type: "ORDER_READY",
    title: "Order packed",
    body: `Your order ${customerOrderNo} is packed and will be on its way soon.`,
    data: { orderId: id },
  });
  // Offer the ready order to nearby drivers (§9.5) — best-effort AFTER commit.
  await dispatchOrder(id).catch((err) =>
    logger.warn({ err, orderId: id }, "dispatch failed (best-effort)"),
  );
  return getOpsDetail(id);
}

/** Statuses in which a COD order is out for delivery — the only window in
 * which a doorstep COD refusal (§10.3 fraud signal) can genuinely happen. */
const OUT_FOR_DELIVERY_STATUSES: readonly OrderStatus[] = [
  OrderStatus.ASSIGNED,
  OrderStatus.PICKED_UP,
];

/**
 * Ops/admin cancel — any pre-DELIVERED status → CANCELLED (§18.3; legality is
 * asserted by the state machine). Restocks product stock + batch allocations
 * via agent C's restockOrder, records reason + cancelledAt, one event.
 *
 * `codRefused: true` is the EXPLICIT doorstep-refusal marker (§10.3): only ops
 * asserts it (never inferred from a plain COD cancel), only on a COD order that
 * was out for delivery (ASSIGNED/PICKED_UP), and it increments the customer's
 * `codRefusalCount` inside the cancel transaction + writes an AuditLog row —
 * feeding the COD auto-disable threshold checked at checkout.
 */
export async function opsCancel(
  id: string,
  reason: string,
  actor: OpsActor,
  options: { codRefused?: boolean } = {},
): Promise<OpsOrderDetailWithMarker> {
  const prisma = getPrisma();
  const actorType = actorTypeFor(actor.role);

  let customerUserId = "";
  let customerOrderNo = "";
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id },
      select: { status: true, userId: true, orderNo: true, paymentMethod: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    assertTransition(order.status, OrderStatus.CANCELLED, actorType);
    customerUserId = order.userId;
    customerOrderNo = order.orderNo;

    if (options.codRefused) {
      if (
        order.paymentMethod !== PaymentMethod.COD ||
        !OUT_FOR_DELIVERY_STATUSES.includes(order.status)
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          "codRefused applies only to COD orders that are out for delivery",
          422,
          { status: order.status, paymentMethod: order.paymentMethod },
        );
      }
    }

    const updated = await tx.order.updateMany({
      where: { id, status: order.status },
      data: { status: OrderStatus.CANCELLED, cancelReason: reason, cancelledAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
    }

    if (options.codRefused) {
      // Fraud signal (§10.3): counted only on the explicit marker, in the same
      // TX as the cancel so a conflict/rollback never leaves a stray increment.
      const refuser = await tx.user.update({
        where: { id: order.userId },
        data: { codRefusalCount: { increment: 1 } },
        select: { codRefusalCount: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "COD_REFUSED",
          entity: "Order",
          entityId: id,
          meta: { userId: order.userId, codRefusalCount: refuser.codRefusalCount },
        },
      });
    }

    await restockOrder(tx, id);

    await tx.orderEvent.create({
      data: {
        orderId: id,
        from: order.status,
        to: OrderStatus.CANCELLED,
        actorType,
        actorId: actor.userId,
        note: reason,
      },
    });
  });

  emitOrderStatus({ id, status: OrderStatus.CANCELLED });
  clearDriverLocation(id);
  // Refund a paid PREPAID order (external, post-commit, §18.3) — a prepaid order
  // is only visible to ops AFTER capture, so an ops cancel is normally cancelling
  // a PAID order. initiateRefund self-guards: no-op for COD / unpaid orders.
  await initiateRefund(id);
  await notifyUser({
    userId: customerUserId,
    type: "ORDER_CANCELLED",
    title: "Order cancelled",
    body: `Your order ${customerOrderNo} was cancelled: ${reason}`,
    data: { orderId: id },
  });
  return getOpsDetail(id);
}

/* --------------------------------------------------------------- reset OTP */

/** Statuses in which the delivery OTP is live and a reset makes sense (§9.7):
 * READY (OTP minted, waiting for a driver) through PICKED_UP (at the door). */
const OTP_RESETTABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.READY,
  OrderStatus.ASSIGNED,
  OrderStatus.PICKED_UP,
];

/**
 * POST /v1/ops/orders/:id/reset-otp — §9.7 lockout recovery: after
 * DELIVERY_OTP_MAX_ATTEMPTS wrong doorstep OTP entries the order is OTP_LOCKED;
 * ops verifies the customer out-of-band and zeroes `Order.otpAttempts` so the
 * driver can retry. Only for an active delivery-stage order (READY/ASSIGNED/
 * PICKED_UP → 409 otherwise), idempotent (resetting an already-zero counter is
 * a success), audited (sensitive mutation). Minimal ack response.
 */
export async function resetOtp(id: string, actor: OpsActor): Promise<{ ok: true }> {
  const prisma = getPrisma();

  const order = await prisma.order.findUnique({
    where: { id },
    select: { status: true, otpAttempts: true },
  });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
  if (!OTP_RESETTABLE_STATUSES.includes(order.status)) {
    throw new AppError(
      "CONFLICT",
      "OTP attempts can only be reset while the order is in the delivery stage",
      409,
      { status: order.status },
    );
  }

  await prisma.$transaction(async (tx) => {
    // Conditional on status so a concurrent DELIVERED/CANCELLED flip wins — a
    // reset landing on a terminal order would only be audit noise, not harm.
    const updated = await tx.order.updateMany({
      where: { id, status: { in: [...OTP_RESETTABLE_STATUSES] } },
      data: { otpAttempts: 0 },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
    }
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "OTP_RESET",
        entity: "Order",
        entityId: id,
        meta: { previousAttempts: order.otpAttempts },
      },
    });
  });

  return { ok: true };
}
