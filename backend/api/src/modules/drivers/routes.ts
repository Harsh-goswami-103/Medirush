import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Prisma, StoreConfig } from "@prisma/client";
import {
  AcceptOfferResponseSchema,
  ActorType,
  DELIVERY_OTP_MAX_ATTEMPTS,
  DeliverBodySchema,
  DeliverResponseSchema,
  DriverHistoryQuerySchema,
  DriverHistoryResponseSchema,
  DriverLocationBatchBodySchema,
  DriverLocationBatchResponseSchema,
  GetActiveDeliveryResponseSchema,
  IdParamsSchema,
  ListOffersResponseSchema,
  OFFER_EXPIRES_SEC,
  OfferStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PickedUpResponseSchema,
  RejectOfferResponseSchema,
  Role,
  UpdateDriverStatusBodySchema,
  UpdateDriverStatusResponseSchema,
  type ActiveDelivery,
  type AddressSnapshot,
  type DriverHistoryEntry,
  type Offer,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { logger } from "../../core/logger";
import { clearDriverLocation, setDriverLocation } from "../../core/locationStore";
import { emitDriverLocation, emitDriverStatus, emitOrderStatus } from "../../core/realtime";
import { getStoreConfig } from "../../core/storeInfo";
import { enqueueInvoicePdf } from "../../jobs/invoicePdf";
import { acceptOffer, rejectOffer } from "../dispatch/service";
import { notifyUser } from "../notifications/service";
import { maybeRewardReferral } from "../referrals/service";
import { assertTransition } from "../orders/stateMachine";
import { creditWallet } from "../wallet/ledger";

/**
 * Driver delivery endpoints (BLUEPRINT §7.2 driver rows, §9.6/§9.7).
 * Role DRIVER; DriverProfile.isVerified is enforced by the auth plugin (§8.2).
 * Offers/status/location are Phase 5 — Phase 1 ships active/picked-up/deliver.
 */

const DRIVER_ROLES: Role[] = [Role.DRIVER];

function requireAuth(request: FastifyRequest): { userId: string } {
  const auth = request.auth;
  if (!auth?.userId) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  return { userId: auth.userId };
}

async function requireDriverProfile(userId: string): Promise<{ id: string }> {
  const profile = await getPrisma().driverProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!profile) throw new AppError("FORBIDDEN", "No driver profile for this user", 403);
  return profile;
}

/** §9.6: commission = base + perKm × ceil(distanceM / 1000), from StoreConfig. */
function commissionPaiseFor(
  store: Pick<StoreConfig, "commissionBasePaise" | "commissionPerKmPaise">,
  distanceM: number,
): number {
  return store.commissionBasePaise + store.commissionPerKmPaise * Math.ceil(distanceM / 1000);
}

function formatDropAddress(snap: AddressSnapshot): string {
  return [snap.line1, snap.line2, snap.landmark, snap.pincode]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");
}

/** Load one delivery and shape it per the ActiveDelivery contract; null when absent. */
async function findActiveDelivery(where: Prisma.DeliveryWhereInput): Promise<ActiveDelivery | null> {
  const prisma = getPrisma();
  const delivery = await prisma.delivery.findFirst({
    where,
    orderBy: { acceptedAt: "desc" },
    include: {
      order: {
        include: {
          user: { select: { name: true, phone: true } },
          items: { select: { id: true } },
        },
      },
    },
  });
  if (!delivery) return null;

  const order = delivery.order;
  const store = await getStoreConfig();
  const snap = order.addressSnapshot as unknown as AddressSnapshot;

  return {
    deliveryId: delivery.id,
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status as ActiveDelivery["status"],
    paymentMethod: order.paymentMethod,
    codDuePaise: order.paymentMethod === PaymentMethod.COD ? order.totalPaise : null,
    deliveryNote: order.deliveryNote,
    contactless: order.contactless,
    customer: { name: order.user.name, phone: order.user.phone },
    pickup: { lat: store.lat, lng: store.lng, address: store.address },
    drop: { lat: snap.lat, lng: snap.lng, address: formatDropAddress(snap) },
    distanceM: delivery.distanceM,
    // Final commission is written at DELIVERED; before that show the §9.6 estimate.
    commissionPaise: delivery.commissionPaise ?? commissionPaiseFor(store, delivery.distanceM),
    itemCount: order.items.length,
    acceptedAt: delivery.acceptedAt.toISOString(),
    pickedUpAt: delivery.pickedUpAt ? delivery.pickedUpAt.toISOString() : null,
  };
}

export const driverRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: driver delivery/PII responses are never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/driver/active",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Current assignment (ASSIGNED/PICKED_UP) or null",
        response: { 200: GetActiveDeliveryResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      const active = await findActiveDelivery({
        driverId: profile.id,
        order: { status: { in: [OrderStatus.ASSIGNED, OrderStatus.PICKED_UP] } },
      });
      return { data: active };
    },
  );

  typed.post(
    "/driver/deliveries/:id/picked-up",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Store handover: ASSIGNED → PICKED_UP",
        params: IdParamsSchema,
        response: { 200: PickedUpResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      const prisma = getPrisma();

      const delivery = await prisma.delivery.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          driverId: true,
          order: { select: { id: true, status: true, userId: true, orderNo: true } },
        },
      });
      if (!delivery) throw new AppError("NOT_FOUND", "Delivery not found", 404);
      if (delivery.driverId !== profile.id) {
        throw new AppError("FORBIDDEN", "This delivery belongs to another driver", 403);
      }
      assertTransition(delivery.order.status, OrderStatus.PICKED_UP, ActorType.DRIVER);

      await prisma.$transaction(async (tx) => {
        const updated = await tx.order.updateMany({
          where: { id: delivery.order.id, status: delivery.order.status },
          data: { status: OrderStatus.PICKED_UP },
        });
        if (updated.count !== 1) {
          throw new AppError("CONFLICT", "Order changed concurrently — retry", 409);
        }
        await tx.delivery.update({
          where: { id: delivery.id },
          data: { pickedUpAt: new Date() },
        });
        await tx.orderEvent.create({
          data: {
            orderId: delivery.order.id,
            from: delivery.order.status,
            to: OrderStatus.PICKED_UP,
            actorType: ActorType.DRIVER,
            actorId: userId,
          },
        });
      });

      emitOrderStatus({ id: delivery.order.id, status: OrderStatus.PICKED_UP });
      await notifyUser({
        userId: delivery.order.userId,
        type: "ORDER_PICKED_UP",
        title: "On the way",
        body: `Your order ${delivery.order.orderNo} is on the way to you.`,
        data: { orderId: delivery.order.id },
      });

      const active = await findActiveDelivery({ id: delivery.id });
      if (!active) throw new AppError("INTERNAL", "Delivery disappeared after update", 500);
      return { data: active };
    },
  );

  typed.post(
    "/driver/deliveries/:id/deliver",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Doorstep completion: OTP + COD collection → DELIVERED, wallet credited (§9.6)",
        params: IdParamsSchema,
        body: DeliverBodySchema,
        response: { 200: DeliverResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      const prisma = getPrisma();

      const delivery = await prisma.delivery.findUnique({
        where: { id: request.params.id },
        include: { order: true },
      });
      if (!delivery) throw new AppError("NOT_FOUND", "Delivery not found", 404);
      if (delivery.driverId !== profile.id) {
        throw new AppError("FORBIDDEN", "This delivery belongs to another driver", 403);
      }
      const order = delivery.order;

      // State gate first — OTP attempts are only counted on deliverable orders.
      assertTransition(order.status, OrderStatus.DELIVERED, ActorType.DRIVER);

      // OTP gate (§9.7): 5 wrong attempts lock the order. The counter is the
      // DURABLE `Order.otpAttempts` column — a restart must never refill the
      // brute-force budget of a 4-digit OTP. Ops unlock = the reset-otp
      // endpoint writing the column back to 0.
      if (order.otpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS) {
        throw new AppError("OTP_LOCKED", "Too many wrong OTP attempts — contact ops", 422);
      }
      if (order.deliveryOtp === null || request.body.otp !== order.deliveryOtp) {
        // Atomic increment: concurrent wrong attempts each consume budget; the
        // NEW value decides the lock, so attempt #5 locks even under a race.
        const bumped = await prisma.order.update({
          where: { id: order.id },
          data: { otpAttempts: { increment: 1 } },
          select: { otpAttempts: true },
        });
        if (bumped.otpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS) {
          throw new AppError("OTP_LOCKED", "Too many wrong OTP attempts — contact ops", 422);
        }
        throw new AppError("OTP_INVALID", "Incorrect delivery OTP", 422, {
          attemptsLeft: DELIVERY_OTP_MAX_ATTEMPTS - bumped.otpAttempts,
        });
      }

      // COD: the exact order total must be collected (§9.6, §18.2).
      const isCod = order.paymentMethod === PaymentMethod.COD;
      if (isCod && request.body.codCollectedPaise !== order.totalPaise) {
        throw new AppError(
          "VALIDATION_ERROR",
          `codCollectedPaise must equal the order total (${order.totalPaise})`,
          422,
          { expectedPaise: order.totalPaise, receivedPaise: request.body.codCollectedPaise ?? null },
        );
      }

      const store = await getStoreConfig();
      const commissionPaise = commissionPaiseFor(store, delivery.distanceM);
      const now = new Date();
      let walletBalancePaise = 0;

      await prisma.$transaction(async (tx) => {
        // Conditional flip first: takes the order row lock, so a concurrent
        // double-deliver fails with 409 BEFORE any money moves.
        const updated = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: {
            status: OrderStatus.DELIVERED,
            deliveredAt: now,
            // Correct OTP clears the wrong-attempt budget (same semantics as
            // the pre-durable in-memory counter).
            otpAttempts: 0,
            ...(isCod ? { paymentStatus: PaymentStatus.COD_COLLECTED } : {}),
          },
        });
        if (updated.count !== 1) {
          throw new AppError("CONFLICT", "Order changed concurrently — retry", 409);
        }

        await creditWallet(
          tx,
          delivery.driverId,
          commissionPaise,
          { type: "ORDER", id: order.id },
          `Delivery commission for ${order.orderNo}`,
        );

        await tx.delivery.update({
          where: { id: delivery.id },
          data: {
            deliveredAt: now,
            otpVerifiedAt: now,
            commissionPaise,
            ...(isCod ? { codCollectedPaise: order.totalPaise } : {}),
          },
        });

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            from: order.status,
            to: OrderStatus.DELIVERED,
            actorType: ActorType.DRIVER,
            actorId: userId,
            ...(isCod ? { note: "cod-collected" } : {}),
          },
        });

        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { driverId: delivery.driverId },
          select: { balancePaise: true },
        });
        walletBalancePaise = wallet.balancePaise;
      });

      emitOrderStatus({ id: order.id, status: OrderStatus.DELIVERED });
      clearDriverLocation(order.id);
      await notifyUser({
        userId: order.userId,
        type: "ORDER_DELIVERED",
        title: "Delivered",
        body: `Your order ${order.orderNo} was delivered. Thank you for choosing MedRush!`,
        data: { orderId: order.id },
      });

      // Post-delivery GST invoice (§9.7) — best-effort enqueue AFTER commit; the
      // job is idempotent so a retry is safe and a miss never fails the delivery.
      await enqueueInvoicePdf(order.id).catch((err) =>
        logger.warn({ err, orderId: order.id }, "invoice enqueue failed (best-effort)"),
      );

      // A referred customer's FIRST delivered order earns the referrer their
      // reward coupon. Idempotent and never-throwing, like every post-commit
      // hook here — a delivery must never fail because a perk didn't mint.
      await maybeRewardReferral(order.userId);

      return {
        data: { deliveredAt: now.toISOString(), commissionPaise, walletBalancePaise },
      };
    },
  );

  /* --------------------------------------------------- Phase 5: dispatch */

  typed.patch(
    "/driver/status",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Go online/offline (only a verified driver may go online)",
        body: UpdateDriverStatusBodySchema,
        response: { 200: UpdateDriverStatusResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const prisma = getPrisma();
      const profile = await prisma.driverProfile.findUnique({
        where: { userId },
        select: { id: true, isVerified: true },
      });
      if (!profile) throw new AppError("FORBIDDEN", "No driver profile for this user", 403);

      const { isOnline } = request.body;
      // Defensive: the auth hook already blocks unverified drivers from /driver/*.
      if (isOnline && !profile.isVerified) {
        throw new AppError("FORBIDDEN", "Your driver account is not verified yet", 403, {
          isVerified: false,
        });
      }
      await prisma.driverProfile.update({
        where: { id: profile.id },
        data: { isOnline, lastSeenAt: new Date() },
      });
      // Post-commit, so the ops fleet view sees presence change immediately
      // rather than at its next poll (§7.3).
      emitDriverStatus(profile.id, isOnline);
      return { data: { isOnline, isVerified: profile.isVerified } };
    },
  );

  typed.get(
    "/driver/offers",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Currently open offers for this driver (socket is primary; this refreshes)",
        response: { 200: ListOffersResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      const prisma = getPrisma();

      const now = Date.now();
      const cutoff = new Date(now - OFFER_EXPIRES_SEC * 1000);
      const offerRows = await prisma.deliveryOffer.findMany({
        where: { driverId: profile.id, status: OfferStatus.OFFERED, offeredAt: { gt: cutoff } },
        orderBy: { offeredAt: "desc" },
      });
      if (offerRows.length === 0) return { data: [] };

      // DeliveryOffer has no order relation — fetch the orders in one query.
      const orderIds = [...new Set(offerRows.map((o) => o.orderId))];
      const orders = await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderNo: true, distanceM: true, status: true, addressSnapshot: true },
      });
      const orderById = new Map(orders.map((o) => [o.id, o]));
      const store = await getStoreConfig();

      const data: Offer[] = offerRows.flatMap((offer) => {
        const order = orderById.get(offer.orderId);
        // Skip offers whose order is no longer READY (already taken / cancelled).
        if (!order || order.status !== OrderStatus.READY) return [];
        const snap = order.addressSnapshot as unknown as AddressSnapshot;
        const expiresAt = new Date(offer.offeredAt.getTime() + OFFER_EXPIRES_SEC * 1000);
        return [
          {
            offerId: offer.id,
            orderId: offer.orderId,
            orderNo: order.orderNo,
            pickup: { lat: store.lat, lng: store.lng, address: store.address },
            drop: { lat: snap.lat, lng: snap.lng, address: formatDropAddress(snap) },
            distanceM: order.distanceM,
            commissionPaise: commissionPaiseFor(store, order.distanceM),
            wave: offer.wave,
            expiresInSec: Math.max(0, Math.round((expiresAt.getTime() - now) / 1000)),
            expiresAt: expiresAt.toISOString(),
          },
        ];
      });
      return { data };
    },
  );

  typed.post(
    "/driver/offers/:id/accept",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Accept an offer — atomic first-wins; 409 OFFER_TAKEN when lost",
        params: IdParamsSchema,
        response: { 200: AcceptOfferResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      const { deliveryId } = await acceptOffer(request.params.id, profile.id);
      const active = await findActiveDelivery({ id: deliveryId });
      if (!active) throw new AppError("INTERNAL", "Delivery disappeared after accept", 500);
      return { data: active };
    },
  );

  typed.post(
    "/driver/offers/:id/reject",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Reject an offer (escalates to the next wave when none remain)",
        params: IdParamsSchema,
        response: { 200: RejectOfferResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      await rejectOffer(request.params.id, profile.id);
      return { data: { ok: true as const } };
    },
  );

  typed.post(
    "/driver/location",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "Location ping batch (HTTP fallback; held in memory, broadcast to the order room)",
        body: DriverLocationBatchBodySchema,
        response: { 200: DriverLocationBatchResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);
      const prisma = getPrisma();

      const active = await prisma.delivery.findFirst({
        where: {
          driverId: profile.id,
          order: { status: { in: [OrderStatus.ASSIGNED, OrderStatus.PICKED_UP] } },
        },
        orderBy: { acceptedAt: "desc" },
        select: { orderId: true },
      });
      if (!active) throw new AppError("CONFLICT", "No active delivery to report location for", 409);

      const points = request.body.points;
      const last = points[points.length - 1];
      if (!last) throw new AppError("VALIDATION_ERROR", "No location points provided", 422);

      setDriverLocation(active.orderId, { lat: last.lat, lng: last.lng, ts: last.ts });
      await prisma.driverProfile.update({
        where: { id: profile.id },
        data: { lastLat: last.lat, lastLng: last.lng, lastSeenAt: new Date() },
      });
      emitDriverLocation({ orderId: active.orderId, lat: last.lat, lng: last.lng, ts: last.ts });
      return { data: { ok: true as const } };
    },
  );

  typed.get(
    "/driver/history",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["driver"],
        summary: "A day's completed deliveries + earnings (IST; defaults to today)",
        querystring: DriverHistoryQuerySchema,
        response: { 200: DriverHistoryResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireAuth(request);
      const profile = await requireDriverProfile(userId);

      const dateStr =
        request.query.date ??
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const start = new Date(`${dateStr}T00:00:00.000+05:30`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      const rows = await getPrisma().delivery.findMany({
        where: { driverId: profile.id, deliveredAt: { gte: start, lt: end } },
        orderBy: { deliveredAt: "desc" },
        include: { order: { select: { orderNo: true } } },
      });

      const deliveries: DriverHistoryEntry[] = rows.map((d) => ({
        deliveryId: d.id,
        orderId: d.orderId,
        orderNo: d.order.orderNo,
        deliveredAt: (d.deliveredAt as Date).toISOString(),
        distanceM: d.distanceM,
        commissionPaise: d.commissionPaise ?? 0,
        codCollectedPaise: d.codCollectedPaise,
      }));
      const totals = {
        count: deliveries.length,
        commissionPaise: deliveries.reduce((sum, d) => sum + d.commissionPaise, 0),
        codCollectedPaise: deliveries.reduce((sum, d) => sum + (d.codCollectedPaise ?? 0), 0),
      };
      return { data: { date: dateStr, deliveries, totals } };
    },
  );
};
