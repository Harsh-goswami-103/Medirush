import { AlertKind, OrderStatus } from "@medrush/contracts";
import { getPrisma } from "../core/db";
import { logger } from "../core/logger";
import { emitOpsAlert } from "../core/realtime";

/**
 * Business watchdog (BLUEPRINT §15): every 5 minutes flag orders stuck past
 * their SLA threshold and raise an ops alert + warn log per stuck order.
 *
 *   PLACED     unpacked   > 10 min
 *   READY      unassigned >  7 min   (no Delivery row)
 *   PICKED_UP             > 40 min
 *
 * Pure-ish: `now` is injectable so the scan is deterministic under test.
 */

const PLACED_STUCK_MIN = 10;
const READY_STUCK_MIN = 7;
const PICKED_UP_STUCK_MIN = 40;

const minsAgo = (now: Date, mins: number): Date => new Date(now.getTime() - mins * 60_000);

/** Runs one watchdog pass. Returns the number of stuck orders alerted (for logs/tests). */
export async function runStuckOrderScan(now: Date = new Date()): Promise<number> {
  const prisma = getPrisma();

  const [placed, ready, pickedUp] = await Promise.all([
    // PLACED unpacked > 10 min.
    prisma.order.findMany({
      where: { status: OrderStatus.PLACED, placedAt: { lt: minsAgo(now, PLACED_STUCK_MIN) } },
      select: { id: true, orderNo: true, placedAt: true },
    }),
    // READY with no Delivery > 7 min.
    prisma.order.findMany({
      where: {
        status: OrderStatus.READY,
        readyAt: { lt: minsAgo(now, READY_STUCK_MIN) },
        delivery: { is: null },
      },
      select: { id: true, orderNo: true, readyAt: true },
    }),
    // PICKED_UP > 40 min (measured from pickup).
    prisma.order.findMany({
      where: {
        status: OrderStatus.PICKED_UP,
        delivery: { is: { pickedUpAt: { lt: minsAgo(now, PICKED_UP_STUCK_MIN) } } },
      },
      select: { id: true, orderNo: true },
    }),
  ]);

  let count = 0;

  for (const order of placed) {
    const msg = `Order ${order.orderNo} has been PLACED for over ${PLACED_STUCK_MIN} min without packing`;
    emitOpsAlert(AlertKind.STUCK_ORDER, msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.PLACED }, msg);
    count += 1;
  }
  for (const order of ready) {
    const msg = `Order ${order.orderNo} has been READY for over ${READY_STUCK_MIN} min with no driver assigned`;
    emitOpsAlert(AlertKind.STUCK_ORDER, msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.READY }, msg);
    count += 1;
  }
  for (const order of pickedUp) {
    const msg = `Order ${order.orderNo} has been PICKED_UP for over ${PICKED_UP_STUCK_MIN} min without delivery`;
    emitOpsAlert(AlertKind.STUCK_ORDER, msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.PICKED_UP }, msg);
    count += 1;
  }

  return count;
}
