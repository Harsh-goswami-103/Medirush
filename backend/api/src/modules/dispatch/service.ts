import { Prisma, type Delivery } from "@prisma/client";
import {
  ActorType,
  AlertKind,
  DISPATCH_WAVE1_DRIVER_COUNT,
  OFFER_EXPIRES_SEC,
  OfferStatus,
  OrderStatus,
  type AddressSnapshot,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { logger } from "../../core/logger";
import {
  emitOfferCancelled,
  emitOfferNew,
  emitOpsAlert,
  emitOrderStatus,
} from "../../core/realtime";
import { getStoreConfig, haversineM } from "../../core/storeInfo";
import { enqueueOfferExpiry } from "../../jobs/offerExpiry";
import { notifyUser } from "../notifications/service";
import { assertTransition } from "../orders/stateMachine";

/**
 * Post-commit customer notification for an ASSIGNED order (§7.2). Best-effort:
 * the order + driver reads are wrapped so a failure never disrupts the committed
 * assignment (notifyUser itself already swallows its own errors).
 */
async function notifyAssigned(orderId: string, driverProfileId: string): Promise<void> {
  try {
    const order = await getPrisma().order.findUnique({
      where: { id: orderId },
      select: { userId: true, orderNo: true },
    });
    if (!order) return;
    const driver = await getPrisma().driverProfile.findUnique({
      where: { id: driverProfileId },
      select: { user: { select: { name: true } } },
    });
    const driverName = driver?.user.name ?? "A driver";
    await notifyUser({
      userId: order.userId,
      type: "ORDER_ASSIGNED",
      title: "Driver assigned",
      body: `${driverName} is on the way to the store to pick up your order ${order.orderNo}.`,
      data: { orderId },
    });
  } catch (err) {
    logger.warn({ err, orderId }, "notifyAssigned failed (best-effort)");
  }
}

/**
 * Phase 1 dispatch stub (brief scope decision #3): dispatch waves/offers are
 * Phase 5 — this service assigns a driver directly and is called from
 * integration tests. NO HTTP surface.
 *
 * Atomic: the Delivery row's unique orderId is the first-wins gate (§9.5) —
 * a unique violation surfaces as 409 CONFLICT.
 */
export async function assignDriver(orderId: string, driverId: string): Promise<Delivery> {
  const prisma = getPrisma();

  const delivery = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, distanceM: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    // Must be READY → ASSIGNED (dispatch acts as SYSTEM).
    assertTransition(order.status, OrderStatus.ASSIGNED, ActorType.SYSTEM);

    const driver = await tx.driverProfile.findUnique({
      where: { id: driverId },
      select: { isVerified: true, user: { select: { isBlocked: true } } },
    });
    if (!driver) throw new AppError("NOT_FOUND", "Driver not found", 404);
    if (!driver.isVerified) throw new AppError("FORBIDDEN", "Driver is not verified", 403);
    if (driver.user.isBlocked) throw new AppError("FORBIDDEN", "Driver is blocked", 403);

    let created: Delivery;
    try {
      created = await tx.delivery.create({
        data: { orderId, driverId, distanceM: order.distanceM },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError("CONFLICT", "Order already has a delivery assigned", 409);
      }
      throw err;
    }

    const updated = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: OrderStatus.ASSIGNED },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — retry", 409);
    }

    await tx.orderEvent.create({
      data: {
        orderId,
        from: order.status,
        to: OrderStatus.ASSIGNED,
        actorType: ActorType.SYSTEM,
        note: `driver:${driverId}`,
      },
    });

    return created;
  });

  emitOrderStatus({ id: orderId, status: OrderStatus.ASSIGNED });
  await notifyAssigned(orderId, driverId);
  return delivery;
}

/* ------------------------------------------- Phase 5: offers & waves (§9.5) */

const OFFER_EXPIRY_MS = OFFER_EXPIRES_SEC * 1000;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Coarse drop address shown on an offer (pre-accept) — area only, not line 1. */
function offerDropAddress(snap: AddressSnapshot): string {
  const parts = [snap.landmark, snap.pincode].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : snap.pincode;
}

/**
 * Candidate drivers for an order: online + verified + unblocked, with NO active
 * delivery, and not already offered THIS order — ranked nearest-to-store first
 * (drivers without a known position sort last).
 */
async function rankCandidates(
  orderId: string,
  storeLat: number,
  storeLng: number,
): Promise<string[]> {
  const rows = await getPrisma().driverProfile.findMany({
    where: {
      isOnline: true,
      isVerified: true,
      user: { isBlocked: false },
      deliveries: {
        none: { order: { status: { in: [OrderStatus.ASSIGNED, OrderStatus.PICKED_UP] } } },
      },
      offers: { none: { orderId } },
    },
    select: { id: true, lastLat: true, lastLng: true },
  });
  return rows
    .map((d) => ({
      id: d.id,
      dist:
        d.lastLat != null && d.lastLng != null
          ? haversineM({ lat: storeLat, lng: storeLng }, { lat: d.lastLat, lng: d.lastLng })
          : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.dist - b.dist)
    .map((d) => d.id);
}

/** Offer a still-READY order to a wave of drivers (1 = 3 nearest, 2 = all rest). */
async function runDispatchWave(orderId: string, wave: number): Promise<void> {
  const prisma = getPrisma();
  const store = await getStoreConfig();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, distanceM: true, orderNo: true, addressSnapshot: true },
  });
  if (!order || order.status !== OrderStatus.READY) return;

  const ranked = await rankCandidates(orderId, store.lat, store.lng);
  const selected = wave <= 1 ? ranked.slice(0, DISPATCH_WAVE1_DRIVER_COUNT) : ranked;
  if (selected.length === 0) {
    if (wave >= 2) {
      emitOpsAlert(AlertKind.UNASSIGNED_ORDER, `No drivers available for ${order.orderNo}`, orderId);
    }
    return;
  }

  const created = await prisma.$transaction(async (tx) => {
    const rows: { offerId: string; driverId: string }[] = [];
    for (const driverId of selected) {
      try {
        const offer = await tx.deliveryOffer.create({
          data: { orderId, driverId, status: OfferStatus.OFFERED, wave },
          select: { id: true },
        });
        rows.push({ offerId: offer.id, driverId });
      } catch (err) {
        // Raced with another offer for the same [orderId, driverId] — skip.
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    return rows;
  });

  // Emit + enqueue AFTER the offer rows commit (§9.1).
  const snap = order.addressSnapshot as unknown as AddressSnapshot;
  const commissionPaise =
    store.commissionBasePaise + store.commissionPerKmPaise * Math.ceil(order.distanceM / 1000);
  for (const row of created) {
    emitOfferNew(row.driverId, {
      offerId: row.offerId,
      orderId,
      pickup: { lat: store.lat, lng: store.lng, address: store.address },
      drop: { lat: snap.lat, lng: snap.lng, address: offerDropAddress(snap) },
      distanceM: order.distanceM,
      commissionPaise,
      expiresInSec: OFFER_EXPIRES_SEC,
    });
  }
  await enqueueOfferExpiry(orderId).catch((err) =>
    logger.warn({ err, orderId }, "offer-expiry enqueue failed (best-effort)"),
  );
}

/** Entry point from markReady — offer a freshly-READY order (wave 1). */
export async function dispatchOrder(orderId: string): Promise<void> {
  await runDispatchWave(orderId, 1);
}

/** When a READY order has no live offers left, escalate: wave 2, then ops alert. */
async function maybeEscalate(orderId: string): Promise<void> {
  const prisma = getPrisma();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, orderNo: true },
  });
  if (!order || order.status !== OrderStatus.READY) return;

  const liveOffers = await prisma.deliveryOffer.count({
    where: { orderId, status: OfferStatus.OFFERED },
  });
  if (liveOffers > 0) return; // a live offer is still outstanding — wait

  const maxWave =
    (await prisma.deliveryOffer.aggregate({ where: { orderId }, _max: { wave: true } }))._max.wave ??
    0;
  if (maxWave < 2) {
    await runDispatchWave(orderId, 2);
  } else {
    emitOpsAlert(AlertKind.UNASSIGNED_ORDER, `Order ${order.orderNo} is still unassigned`, orderId);
  }
}

/** Offer-expiry worker: expire timed-out offers for the order, then escalate. */
export async function expireAndEscalate(orderId: string): Promise<void> {
  await getPrisma().deliveryOffer.updateMany({
    where: { orderId, status: OfferStatus.OFFERED },
    data: { status: OfferStatus.EXPIRED, respondedAt: new Date() },
  });
  await maybeEscalate(orderId);
}

/**
 * Driver accepts an offer — ATOMIC first-wins (§9.5). The `Delivery.orderId`
 * unique index is the arbiter: under N concurrent accepts exactly one creates
 * the Delivery row; the rest hit P2002 → 409 OFFER_TAKEN. The order moves
 * READY→ASSIGNED under a conditional guard, this offer is ACCEPTED and the
 * siblings EXPIRED. Emits AFTER commit. Returns the delivery + order id.
 */
export async function acceptOffer(
  offerId: string,
  driverProfileId: string,
): Promise<{ deliveryId: string; orderId: string }> {
  const prisma = getPrisma();

  const outcome = await prisma.$transaction(async (tx) => {
    const offer = await tx.deliveryOffer.findUnique({
      where: { id: offerId },
      select: { orderId: true, driverId: true, status: true, offeredAt: true },
    });
    if (!offer || offer.driverId !== driverProfileId) {
      throw new AppError("NOT_FOUND", "Offer not found", 404);
    }
    if (offer.status !== OfferStatus.OFFERED) {
      throw new AppError("OFFER_TAKEN", "This offer is no longer available", 409);
    }
    if (Date.now() - offer.offeredAt.getTime() > OFFER_EXPIRY_MS) {
      throw new AppError("OFFER_TAKEN", "This offer has expired", 409);
    }

    const order = await tx.order.findUnique({
      where: { id: offer.orderId },
      select: { status: true, distanceM: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    // A non-READY order means someone already won (or it was cancelled).
    if (order.status !== OrderStatus.READY) {
      throw new AppError("OFFER_TAKEN", "This order is no longer available", 409);
    }

    // FIRST-WINS: the Delivery.orderId unique index arbitrates concurrent accepts.
    let deliveryId: string;
    try {
      const delivery = await tx.delivery.create({
        data: { orderId: offer.orderId, driverId: driverProfileId, distanceM: order.distanceM },
        select: { id: true },
      });
      deliveryId = delivery.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError("OFFER_TAKEN", "Another driver already took this order", 409);
      }
      throw err;
    }

    const updated = await tx.order.updateMany({
      where: { id: offer.orderId, status: OrderStatus.READY },
      data: { status: OrderStatus.ASSIGNED },
    });
    if (updated.count !== 1) {
      throw new AppError("OFFER_TAKEN", "Order changed concurrently", 409);
    }

    await tx.orderEvent.create({
      data: {
        orderId: offer.orderId,
        from: OrderStatus.READY,
        to: OrderStatus.ASSIGNED,
        actorType: ActorType.SYSTEM,
        note: `driver:${driverProfileId}`,
      },
    });

    await tx.deliveryOffer.update({
      where: { id: offerId },
      data: { status: OfferStatus.ACCEPTED, respondedAt: new Date() },
    });

    const siblings = await tx.deliveryOffer.findMany({
      where: { orderId: offer.orderId, status: OfferStatus.OFFERED, id: { not: offerId } },
      select: { id: true, driverId: true },
    });
    if (siblings.length > 0) {
      await tx.deliveryOffer.updateMany({
        where: { orderId: offer.orderId, status: OfferStatus.OFFERED, id: { not: offerId } },
        data: { status: OfferStatus.EXPIRED, respondedAt: new Date() },
      });
    }

    return { deliveryId, orderId: offer.orderId, siblings };
  });

  emitOrderStatus({ id: outcome.orderId, status: OrderStatus.ASSIGNED });
  await notifyAssigned(outcome.orderId, driverProfileId);
  for (const sibling of outcome.siblings) {
    emitOfferCancelled(sibling.driverId, { offerId: sibling.id, orderId: outcome.orderId });
  }
  return { deliveryId: outcome.deliveryId, orderId: outcome.orderId };
}

/** Driver rejects an offer; escalate to the next wave once no live offers remain. */
export async function rejectOffer(offerId: string, driverProfileId: string): Promise<void> {
  const prisma = getPrisma();
  const offer = await prisma.deliveryOffer.findUnique({
    where: { id: offerId },
    select: { orderId: true, driverId: true, status: true },
  });
  if (!offer || offer.driverId !== driverProfileId) {
    throw new AppError("NOT_FOUND", "Offer not found", 404);
  }
  if (offer.status !== OfferStatus.OFFERED) return; // idempotent

  const updated = await prisma.deliveryOffer.updateMany({
    where: { id: offerId, status: OfferStatus.OFFERED },
    data: { status: OfferStatus.REJECTED, respondedAt: new Date() },
  });
  if (updated.count === 1) await maybeEscalate(offer.orderId);
}
