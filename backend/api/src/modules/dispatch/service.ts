import { Prisma, type Delivery } from "@prisma/client";
import {
  ActorType,
  AlertKind,
  DISPATCH_WAVE1_DRIVER_COUNT,
  OFFER_EXPIRES_SEC,
  OfferStatus,
  OrderStatus,
  Role,
  type AddressSnapshot,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { clearDriverLocation } from "../../core/locationStore";
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
 * Ops/admin actor for the manual dispatch-recovery actions (Phase 7). Kept
 * local (not imported from orders/opsService) to avoid a module cycle —
 * orders/opsService already imports `dispatchOrder` from this file.
 */
export interface DispatchOpsActor {
  userId: string;
  role: Role;
}

const opsActorType = (role: Role): ActorType =>
  role === Role.ADMIN ? ActorType.ADMIN : ActorType.OPS;

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
 * Direct assignment: READY → ASSIGNED without an offer round-trip. Two callers:
 * - Phase 1 integration tests / scripts (no `actor` — acts as SYSTEM).
 * - POST /v1/ops/orders/:id/assign (Phase 7 manual assign — acts as OPS/ADMIN,
 *   writes an AuditLog row and notifies the driver, who did not initiate this).
 *
 * Atomic: the Delivery row's unique orderId is the first-wins gate (§9.5) —
 * a unique violation surfaces as 409 CONFLICT. Any offers still OFFERED for the
 * order are settled exactly like acceptOffer does (the chosen driver's pending
 * offer → ACCEPTED, every other one → EXPIRED + `offer:cancelled`).
 */
export async function assignDriver(
  orderId: string,
  driverId: string,
  actor?: DispatchOpsActor,
): Promise<Delivery> {
  const prisma = getPrisma();
  const actorType = actor ? opsActorType(actor.role) : ActorType.SYSTEM;

  const outcome = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, distanceM: true, orderNo: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    // Must be READY → ASSIGNED (SYSTEM for dispatch/tests, OPS/ADMIN for manual).
    assertTransition(order.status, OrderStatus.ASSIGNED, actorType);

    const driver = await tx.driverProfile.findUnique({
      where: { id: driverId },
      select: { userId: true, isVerified: true, user: { select: { isBlocked: true } } },
    });
    if (!driver) throw new AppError("NOT_FOUND", "Driver not found", 404);
    if (!driver.isVerified) throw new AppError("FORBIDDEN", "Driver is not verified", 403);
    if (driver.user.isBlocked) throw new AppError("FORBIDDEN", "Driver is blocked", 403);
    // Mirror the offer-path availability invariant (rankCandidates): a driver
    // has at most ONE active delivery — a second one breaks /driver/active.
    // (isOnline is deliberately NOT required: like the accept path, a driver ops
    // reached by phone may be assigned even if the app shows them offline.)
    // The count below is check-then-act under READ COMMITTED: two concurrent
    // assigns of the SAME driver to different orders would both read 0 and both
    // insert. Serialise them on the DriverProfile row (mirrors the User row
    // lock in orders/service.ts assertFraudGatesInTx) — the loser waits for the
    // winner's commit, then sees its Delivery and 409s.
    await tx.$queryRaw`SELECT 1 FROM "DriverProfile" WHERE "id" = ${driverId} FOR UPDATE`;
    const activeDeliveries = await tx.delivery.count({
      where: {
        driverId,
        order: { status: { in: [OrderStatus.ASSIGNED, OrderStatus.PICKED_UP] } },
      },
    });
    if (activeDeliveries > 0) {
      throw new AppError("CONFLICT", "Driver already has an active delivery", 409);
    }

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
        actorType,
        ...(actor ? { actorId: actor.userId } : {}),
        note: `driver:${driverId}`,
      },
    });

    // Settle any live offers exactly like acceptOffer: the chosen driver's own
    // pending offer becomes ACCEPTED, all other pending offers EXPIRE.
    const now = new Date();
    await tx.deliveryOffer.updateMany({
      where: { orderId, driverId, status: OfferStatus.OFFERED },
      data: { status: OfferStatus.ACCEPTED, respondedAt: now },
    });
    const siblings = await tx.deliveryOffer.findMany({
      where: { orderId, status: OfferStatus.OFFERED },
      select: { id: true, driverId: true },
    });
    if (siblings.length > 0) {
      await tx.deliveryOffer.updateMany({
        where: { id: { in: siblings.map((s) => s.id) } },
        data: { status: OfferStatus.EXPIRED, respondedAt: now },
      });
    }

    if (actor) {
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "ORDER_MANUAL_ASSIGN",
          entity: "Order",
          entityId: orderId,
          meta: { driverId, deliveryId: created.id },
        },
      });
    }

    return { created, siblings, orderNo: order.orderNo, driverUserId: driver.userId };
  });

  emitOrderStatus({ id: orderId, status: OrderStatus.ASSIGNED, orderNo: outcome.orderNo });
  await notifyAssigned(orderId, driverId);
  for (const sibling of outcome.siblings) {
    emitOfferCancelled(sibling.driverId, { offerId: sibling.id, orderId });
  }
  if (actor) {
    // The accept path needs no driver notice (the driver initiated it); a manual
    // assignment must reach the driver app — durable notification + FCM push.
    await notifyUser({
      userId: outcome.driverUserId,
      type: "DELIVERY_ASSIGNED",
      title: "New delivery assigned",
      body: `Order ${outcome.orderNo} was assigned to you by the store — open the app to start the pickup.`,
      data: { orderId },
    });
  }
  return outcome.created;
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
      // Deliberately `none: { orderId }` (ANY offer row, not just OFFERED ones):
      // DeliveryOffer is unique on [orderId, driverId], so "one offer row per
      // driver" IS the dispatch round — within a round a driver who already saw
      // the order (pending, rejected or expired) must never be re-offered, and
      // relaxing this to status OFFERED would only make runDispatchWave trip the
      // unique index on the re-insert anyway. A NEW round is started explicitly
      // by ops re-dispatch (redispatchOrder below), which DELETES the stale
      // EXPIRED/REJECTED rows — making the same fleet rankable again without
      // weakening the intra-round exclusion here.
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

/**
 * Offer a still-READY order to a wave of drivers (1 = 3 nearest, 2 = all rest).
 * Returns the number of offers actually created (0 on any early-out).
 */
async function runDispatchWave(orderId: string, wave: number): Promise<number> {
  const prisma = getPrisma();
  const store = await getStoreConfig();
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, distanceM: true, orderNo: true, addressSnapshot: true },
  });
  if (!order || order.status !== OrderStatus.READY) return 0;

  const ranked = await rankCandidates(orderId, store.lat, store.lng);
  const selected = wave <= 1 ? ranked.slice(0, DISPATCH_WAVE1_DRIVER_COUNT) : ranked;
  if (selected.length === 0) {
    if (wave >= 2) {
      await emitUnassignedAlertOnce(`No drivers available for ${order.orderNo}`, orderId);
    }
    return 0;
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
  return created.length;
}

/** Entry point from markReady — offer a freshly-READY order (wave 1). */
export async function dispatchOrder(orderId: string): Promise<void> {
  await runDispatchWave(orderId, 1);
}

/**
 * UNASSIGNED_ORDER, deduped: a dead order sees repeated expiry passes (one job
 * per wave) and every emit is now a durable OpsAlert row + a Sentry error —
 * ops must not be re-paged while an UNACKNOWLEDGED alert for the same order is
 * already sitting in the inbox (the socket toast is suppressed too; the open
 * row is visible there). Acking re-arms: a later pass over a still-dead order
 * pages again. Best-effort like emitOpsAlert itself — the check reads
 * committed rows, so passes racing within the fire-and-forget write window may
 * still double-emit (harmless).
 */
async function emitUnassignedAlertOnce(msg: string, orderId: string): Promise<void> {
  const open = await getPrisma().opsAlert.findFirst({
    where: { kind: AlertKind.UNASSIGNED_ORDER, refId: orderId, acknowledgedAt: null },
    select: { id: true },
  });
  if (open) return;
  emitOpsAlert(AlertKind.UNASSIGNED_ORDER, msg, orderId);
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
    await emitUnassignedAlertOnce(`Order ${order.orderNo} is still unassigned`, orderId);
  }
}

/**
 * Offer-expiry worker: expire the order's timed-out offers, then escalate.
 * Only offers OLDER than the OFFER_EXPIRES_SEC window are expired: every wave
 * now enqueues its own expiry job (jobs/offerExpiry.ts), so a pass belonging
 * to an earlier wave must not kill a younger re-dispatch wave's fresh offers —
 * those get expired by their OWN pass once they age out. Young survivors also
 * keep maybeEscalate waiting (liveOffers > 0), so escalation still fires
 * exactly once the offers genuinely time out.
 */
export async function expireAndEscalate(orderId: string): Promise<void> {
  const cutoff = new Date(Date.now() - OFFER_EXPIRY_MS);
  await getPrisma().deliveryOffer.updateMany({
    where: { orderId, status: OfferStatus.OFFERED, offeredAt: { lte: cutoff } },
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

/* --------------------------------- Phase 7: ops dead-end recovery (§9.5/§24) */

/**
 * Delete the stale (EXPIRED/REJECTED) offer rows of an order so the same fleet
 * can be re-offered — this is what starts a NEW dispatch round (see the
 * rankCandidates note). Still-OFFERED rows are kept: the unique
 * [orderId, driverId] index + the rankCandidates exclusion guarantee a driver
 * with a live pending offer never receives a duplicate. Deleting the stale rows
 * also resets the escalation "wave counter" — maybeEscalate derives it from
 * MAX(wave) over the rows that remain.
 */
async function clearStaleOffers(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const deleted = await tx.deliveryOffer.deleteMany({
    where: { orderId, status: { in: [OfferStatus.EXPIRED, OfferStatus.REJECTED] } },
  });
  return deleted.count;
}

/**
 * Ops re-dispatch (POST /v1/ops/orders/:id/redispatch): after both offer waves
 * expired nothing re-offers automatically — clear the stale offer rows and
 * restart the waves from wave 1. The order must still be READY with no delivery.
 */
export async function redispatchOrder(
  orderId: string,
  actor: DispatchOpsActor,
): Promise<{ clearedOffers: number; offersCreated: number }> {
  const prisma = getPrisma();

  const clearedOffers = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    if (order.status !== OrderStatus.READY) {
      throw new AppError("CONFLICT", "Only a READY order can be re-dispatched", 409, {
        status: order.status,
      });
    }
    // Defensive: a READY order must not carry a Delivery (unassign deletes it).
    const delivery = await tx.delivery.findUnique({
      where: { orderId },
      select: { id: true },
    });
    if (delivery) {
      throw new AppError("CONFLICT", "Order already has an active delivery", 409);
    }

    const cleared = await clearStaleOffers(tx, orderId);

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "ORDER_REDISPATCH",
        entity: "Order",
        entityId: orderId,
        meta: { clearedOffers: cleared },
      },
    });
    return cleared;
  });

  // Fresh wave 1 AFTER the clearing commits (emits/enqueues never in a TX, §9.1).
  // runDispatchWave re-checks READY, so a racing accept simply yields 0 offers.
  const offersCreated = await runDispatchWave(orderId, 1);
  return { clearedOffers, offersCreated };
}

/**
 * Ops un-assign (POST /v1/ops/orders/:id/unassign): ASSIGNED → READY, ONLY
 * while the driver has not picked up (§9.1 un-assign edge). Undoes exactly what
 * assignment created: the Delivery row is deleted (it IS the active-delivery
 * marker — /driver/active and rankCandidates both derive from it) and the
 * winning offer, if any, is voided. Optionally re-dispatches in the same call.
 */
export async function unassignDriver(
  orderId: string,
  actor: DispatchOpsActor,
  redispatch: boolean,
): Promise<{
  driverId: string;
  redispatched: boolean;
  clearedOffers: number;
  offersCreated: number;
}> {
  const prisma = getPrisma();
  const actorType = opsActorType(actor.role);

  const outcome = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, orderNo: true },
    });
    if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
    // ASSIGNED → READY; any other status (incl. PICKED_UP) → 409 INVALID_TRANSITION.
    assertTransition(order.status, OrderStatus.READY, actorType);

    const delivery = await tx.delivery.findUnique({
      where: { orderId },
      select: { id: true, driverId: true, pickedUpAt: true, driver: { select: { userId: true } } },
    });
    if (!delivery) {
      throw new AppError("CONFLICT", "Order has no delivery to unassign", 409);
    }
    if (delivery.pickedUpAt) {
      throw new AppError("CONFLICT", "Order was already picked up — cannot unassign", 409);
    }

    // Conditional flip: the order row lock arbitrates a race with picked-up
    // (which flips ASSIGNED → PICKED_UP under the same kind of guard).
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.ASSIGNED },
      data: { status: OrderStatus.READY },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
    }

    // Delete the Delivery, re-guarded on pickedUpAt: a pickup that raced past
    // the read above can never be orphaned by this unassign.
    const deleted = await tx.delivery.deleteMany({
      where: { id: delivery.id, pickedUpAt: null },
    });
    if (deleted.count !== 1) {
      throw new AppError("CONFLICT", "Pickup was recorded concurrently — cannot unassign", 409);
    }

    // Void the winning offer (present when the assignment came via acceptOffer)
    // so it neither blocks a later re-offer round nor reads as a live win.
    const wonOffer = await tx.deliveryOffer.findFirst({
      where: { orderId, driverId: delivery.driverId, status: OfferStatus.ACCEPTED },
      select: { id: true },
    });
    if (wonOffer) {
      await tx.deliveryOffer.update({
        where: { id: wonOffer.id },
        data: { status: OfferStatus.EXPIRED, respondedAt: new Date() },
      });
    }

    await tx.orderEvent.create({
      data: {
        orderId,
        from: OrderStatus.ASSIGNED,
        to: OrderStatus.READY,
        actorType,
        actorId: actor.userId,
        note: `driver:${delivery.driverId} unassigned`,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "ORDER_UNASSIGN",
        entity: "Order",
        entityId: orderId,
        meta: { driverId: delivery.driverId, deliveryId: delivery.id, redispatch },
      },
    });

    const clearedOffers = redispatch ? await clearStaleOffers(tx, orderId) : 0;

    return {
      orderNo: order.orderNo,
      driverId: delivery.driverId,
      driverUserId: delivery.driver.userId,
      wonOfferId: wonOffer?.id ?? null,
      clearedOffers,
    };
  });

  emitOrderStatus({ id: orderId, status: OrderStatus.READY, orderNo: outcome.orderNo });
  // Drop any lingering live-position point for the order (assignment is undone).
  clearDriverLocation(orderId);
  // Tell the driver app: `offer:cancelled` on the driver's socket room dismisses
  // any lingering offer/assignment UI (when an offer row existed), and the
  // durable notification + FCM push always lands.
  if (outcome.wonOfferId) {
    emitOfferCancelled(outcome.driverId, { offerId: outcome.wonOfferId, orderId });
  }
  await notifyUser({
    userId: outcome.driverUserId,
    type: "DELIVERY_UNASSIGNED",
    title: "Delivery reassigned",
    body: `Order ${outcome.orderNo} was unassigned from you by the store. No action is needed.`,
    data: { orderId },
  });

  const offersCreated = redispatch ? await runDispatchWave(orderId, 1) : 0;
  return {
    driverId: outcome.driverId,
    redispatched: redispatch,
    clearedOffers: outcome.clearedOffers,
    offersCreated,
  };
}
