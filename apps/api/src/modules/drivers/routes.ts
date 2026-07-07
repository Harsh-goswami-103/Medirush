import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Prisma, StoreConfig } from "@prisma/client";
import {
  ActorType,
  DELIVERY_OTP_MAX_ATTEMPTS,
  DeliverBodySchema,
  DeliverResponseSchema,
  GetActiveDeliveryResponseSchema,
  IdParamsSchema,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PickedUpResponseSchema,
  Role,
  type ActiveDelivery,
  type AddressSnapshot,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { logger } from "../../core/logger";
import { emitOrderStatus } from "../../core/realtime";
import { getStoreConfig } from "../../core/storeInfo";
import { enqueueInvoicePdf } from "../../jobs/invoicePdf";
import { assertTransition } from "../orders/stateMachine";
import { creditWallet } from "../wallet/ledger";

/**
 * Driver delivery endpoints (BLUEPRINT §7.2 driver rows, §9.6/§9.7).
 * Role DRIVER; DriverProfile.isVerified is enforced by the auth plugin (§8.2).
 * Offers/status/location are Phase 5 — Phase 1 ships active/picked-up/deliver.
 */

const DRIVER_ROLES: Role[] = [Role.DRIVER];

/**
 * Wrong-OTP attempt counter, orderId → count (§9.7: 5 max, then locked).
 * Deliberately in-memory per the Phase 1 brief (scope decision #4): there is
 * no schema column and the ops unlock flow ships Phase 2+ — a process restart
 * clears all counters.
 */
const otpAttempts = new Map<string, number>();

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
        select: { id: true, driverId: true, order: { select: { id: true, status: true } } },
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

      // OTP gate (§9.7): 5 wrong attempts lock the order (ops unlock = Phase 2+).
      const priorAttempts = otpAttempts.get(order.id) ?? 0;
      if (priorAttempts >= DELIVERY_OTP_MAX_ATTEMPTS) {
        throw new AppError("OTP_LOCKED", "Too many wrong OTP attempts — contact ops", 422);
      }
      if (order.deliveryOtp === null || request.body.otp !== order.deliveryOtp) {
        const attempts = priorAttempts + 1;
        otpAttempts.set(order.id, attempts);
        if (attempts >= DELIVERY_OTP_MAX_ATTEMPTS) {
          throw new AppError("OTP_LOCKED", "Too many wrong OTP attempts — contact ops", 422);
        }
        throw new AppError("OTP_INVALID", "Incorrect delivery OTP", 422, {
          attemptsLeft: DELIVERY_OTP_MAX_ATTEMPTS - attempts,
        });
      }
      otpAttempts.delete(order.id);

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

      // Post-delivery GST invoice (§9.7) — best-effort enqueue AFTER commit; the
      // job is idempotent so a retry is safe and a miss never fails the delivery.
      await enqueueInvoicePdf(order.id).catch((err) =>
        logger.warn({ err, orderId: order.id }, "invoice enqueue failed (best-effort)"),
      );

      return {
        data: { deliveredAt: now.toISOString(), commissionPaise, walletBalancePaise },
      };
    },
  );
};
