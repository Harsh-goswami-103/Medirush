import { randomInt } from "node:crypto";
import {
  ActorType,
  OrderStatus,
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
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { emitOrderStatus } from "../../core/realtime";
import { proposeFefo } from "../inventory/fefo";
import { commitAllocations } from "../inventory/service";
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
    prescriptions: order.prescriptions.map((rx) => ({
      id: rx.id,
      status: rx.status,
      mimeType: rx.mimeType,
      // Phase 1 has no R2 presigner; a syntactically valid placeholder keeps
      // the contract shape until the Phase 2 storage pass presigns for real.
      fileUrl: `https://files.invalid/rx/${rx.fileKey}`,
      patientName: rx.patientName,
      doctorName: rx.doctorName,
      reviewNote: rx.reviewNote,
      createdAt: rx.createdAt.toISOString(),
      reviewedAt: isoOrNull(rx.reviewedAt),
    })),
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

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id },
      include: { items: { select: { id: true, qty: true, productId: true } } },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    assertTransition(order.status, OrderStatus.READY, actorType);

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
      select: { id: true, productId: true },
    });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
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
  return getOpsDetail(id);
}

/**
 * Ops/admin cancel — any pre-DELIVERED status → CANCELLED (§18.3; legality is
 * asserted by the state machine). Restocks product stock + batch allocations
 * via agent C's restockOrder, records reason + cancelledAt, one event.
 */
export async function opsCancel(
  id: string,
  reason: string,
  actor: OpsActor,
): Promise<OpsOrderDetailWithMarker> {
  const prisma = getPrisma();
  const actorType = actorTypeFor(actor.role);

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id }, select: { status: true } });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    assertTransition(order.status, OrderStatus.CANCELLED, actorType);

    const updated = await tx.order.updateMany({
      where: { id, status: order.status },
      data: { status: OrderStatus.CANCELLED, cancelReason: reason, cancelledAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
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
  return getOpsDetail(id);
}
