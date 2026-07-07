import { Prisma, type Delivery } from "@prisma/client";
import { ActorType, OrderStatus } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { emitOrderStatus } from "../../core/realtime";
import { assertTransition } from "../orders/stateMachine";

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
  return delivery;
}
