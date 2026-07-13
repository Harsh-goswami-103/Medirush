import {
  AlertKind,
  OrderStatus,
  PAYMENT_TIMEOUT_MIN,
  PaymentMethod,
  PaymentStatus,
} from "@medrush/contracts";
import { getPrisma } from "../core/db";
import { logger } from "../core/logger";
import { emitOpsAlert } from "../core/realtime";
import { expireUnpaidOrder, initiateRefund } from "../modules/payments/service";

/**
 * Business watchdog (BLUEPRINT §15): every 5 minutes flag orders stuck past
 * their SLA threshold and raise an ops alert + warn log per stuck order.
 *
 *   PENDING_PAYMENT > timeout+10 min → run the payment-timeout expiry path
 *   PLACED     unpacked   > 10 min
 *   RX_REVIEW  unreviewed > 45 min
 *   PACKING               > 20 min
 *   READY      unassigned >  7 min   (no Delivery row)
 *   ASSIGNED   no pickup  > 15 min
 *   PICKED_UP             > 40 min
 *   REFUND_INITIATED, refundId null > 5 min → re-drive the claim-first initiateRefund
 *
 * PENDING_PAYMENT is special: instead of an alert it invokes the SAME idempotent
 * `expireUnpaidOrder` the payment-timeout job uses — a lost/undelivered timeout
 * job must never reserve stock forever. The 10-min slack keeps the watchdog off
 * the normal job's heels (it only acts when the job clearly didn't).
 *
 * REFUND_INITIATED with no refundId is the refund twin: the initiator claimed
 * PAID → REFUND_INITIATED and died before Razorpay answered, and NO caller ever
 * re-invokes `initiateRefund` (all its call sites are one-shot transitions; the
 * webhook eventId is consumed). The sweep re-drives the SAME claim-first
 * `initiateRefund` — its stale-claim arm admits exactly one winner (never a
 * double refund), and its failure path reverts to PAID and pages
 * MANUAL_REFUND_REQUIRED on its own.
 *
 * Pure-ish: `now` is injectable so the scan is deterministic under test.
 */

const PLACED_STUCK_MIN = 10;
const READY_STUCK_MIN = 7;
const PICKED_UP_STUCK_MIN = 40;
/** PENDING_PAYMENT past the §9.3 timeout plus this slack → force the expiry path. */
const PENDING_PAYMENT_SLACK_MIN = 10;
const PENDING_PAYMENT_STUCK_MIN = PAYMENT_TIMEOUT_MIN + PENDING_PAYMENT_SLACK_MIN;
const PACKING_STUCK_MIN = 20;
const RX_REVIEW_STUCK_MIN = 45;
const ASSIGNED_STUCK_MIN = 15;
/**
 * REFUND_INITIATED with refundId still null this long after its last touch →
 * the initiator died between the claim and the Razorpay call. Must exceed the
 * payments service's STALE_REFUND_CLAIM_MS (2 min) so `initiateRefund`'s
 * reclaim arm accepts every order the sweep hands it.
 */
const REFUND_SWEEP_STALE_MIN = 5;

const minsAgo = (now: Date, mins: number): Date => new Date(now.getTime() - mins * 60_000);

/**
 * STUCK_ORDER, deduped: the watchdog re-scans every 5 minutes and every emit is
 * now a durable OpsAlert row + a Sentry error — an order that stays stuck must
 * not re-page ops while its UNACKNOWLEDGED alert is already sitting in the
 * inbox (the socket toast is suppressed too; the open row is visible there).
 * Acking re-arms: if the order is STILL stuck on the next pass, ops is paged
 * again. Best-effort like emitOpsAlert itself — the check reads committed rows,
 * so scans racing within the fire-and-forget write window may double-emit
 * (harmless; passes are 5 minutes apart).
 */
async function emitStuckOrderAlertOnce(msg: string, orderId: string): Promise<void> {
  const open = await getPrisma().opsAlert.findFirst({
    where: { kind: AlertKind.STUCK_ORDER, refId: orderId, acknowledgedAt: null },
    select: { id: true },
  });
  if (open) return;
  emitOpsAlert(AlertKind.STUCK_ORDER, msg, orderId);
}

/** Runs one watchdog pass. Returns the number of stuck orders acted on (for logs/tests). */
export async function runStuckOrderScan(now: Date = new Date()): Promise<number> {
  const prisma = getPrisma();

  const [pendingPayment, placed, rxReview, packing, ready, assigned, pickedUp, staleRefunds] = await Promise.all([
    // PENDING_PAYMENT the payment-timeout job should have expired but didn't.
    prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        createdAt: { lt: minsAgo(now, PENDING_PAYMENT_STUCK_MIN) },
      },
      select: { id: true, orderNo: true },
    }),
    // PLACED unpacked > 10 min.
    prisma.order.findMany({
      where: { status: OrderStatus.PLACED, placedAt: { lt: minsAgo(now, PLACED_STUCK_MIN) } },
      select: { id: true, orderNo: true, placedAt: true },
    }),
    // RX_REVIEW unreviewed > 45 min (measured from placement — RX_REVIEW is entered at placement).
    prisma.order.findMany({
      where: { status: OrderStatus.RX_REVIEW, placedAt: { lt: minsAgo(now, RX_REVIEW_STUCK_MIN) } },
      select: { id: true, orderNo: true },
    }),
    // PACKING > 20 min (packedAt is set on entering PACKING).
    prisma.order.findMany({
      where: { status: OrderStatus.PACKING, packedAt: { lt: minsAgo(now, PACKING_STUCK_MIN) } },
      select: { id: true, orderNo: true },
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
    // ASSIGNED with no pickup > 15 min (measured from acceptance).
    prisma.order.findMany({
      where: {
        status: OrderStatus.ASSIGNED,
        delivery: {
          is: { acceptedAt: { lt: minsAgo(now, ASSIGNED_STUCK_MIN) }, pickedUpAt: null },
        },
      },
      select: { id: true, orderNo: true },
    }),
    // PICKED_UP > 40 min (measured from pickup).
    prisma.order.findMany({
      where: {
        status: OrderStatus.PICKED_UP,
        delivery: { is: { pickedUpAt: { lt: minsAgo(now, PICKED_UP_STUCK_MIN) } } },
      },
      select: { id: true, orderNo: true },
    }),
    // Refund claim taken but Razorpay never reached: REFUND_INITIATED with no
    // recorded refundId, untouched > 5 min.
    prisma.order.findMany({
      where: {
        paymentMethod: PaymentMethod.PREPAID,
        paymentStatus: PaymentStatus.REFUND_INITIATED,
        updatedAt: { lt: minsAgo(now, REFUND_SWEEP_STALE_MIN) },
        payment: { is: { refundId: null } },
      },
      select: { id: true, orderNo: true },
    }),
  ]);

  let count = 0;

  for (const order of pendingPayment) {
    const msg = `Order ${order.orderNo} sat PENDING_PAYMENT past the timeout — running the expiry path`;
    logger.warn(
      { orderId: order.id, orderNo: order.orderNo, status: OrderStatus.PENDING_PAYMENT },
      msg,
    );
    // Same idempotent path as the payment-timeout job — a no-op if a webhook
    // (or the job itself) got there first; releases the reserved stock otherwise.
    await expireUnpaidOrder(order.id);
    count += 1;
  }
  for (const order of placed) {
    const msg = `Order ${order.orderNo} has been PLACED for over ${PLACED_STUCK_MIN} min without packing`;
    await emitStuckOrderAlertOnce(msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.PLACED }, msg);
    count += 1;
  }
  for (const order of rxReview) {
    const msg = `Order ${order.orderNo} has been in RX_REVIEW for over ${RX_REVIEW_STUCK_MIN} min without a decision`;
    await emitStuckOrderAlertOnce(msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.RX_REVIEW }, msg);
    count += 1;
  }
  for (const order of packing) {
    const msg = `Order ${order.orderNo} has been PACKING for over ${PACKING_STUCK_MIN} min without going READY`;
    await emitStuckOrderAlertOnce(msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.PACKING }, msg);
    count += 1;
  }
  for (const order of ready) {
    const msg = `Order ${order.orderNo} has been READY for over ${READY_STUCK_MIN} min with no driver assigned`;
    await emitStuckOrderAlertOnce(msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.READY }, msg);
    count += 1;
  }
  for (const order of assigned) {
    const msg = `Order ${order.orderNo} has been ASSIGNED for over ${ASSIGNED_STUCK_MIN} min without pickup`;
    await emitStuckOrderAlertOnce(msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.ASSIGNED }, msg);
    count += 1;
  }
  for (const order of pickedUp) {
    const msg = `Order ${order.orderNo} has been PICKED_UP for over ${PICKED_UP_STUCK_MIN} min without delivery`;
    await emitStuckOrderAlertOnce(msg, order.id);
    logger.warn({ orderId: order.id, orderNo: order.orderNo, status: OrderStatus.PICKED_UP }, msg);
    count += 1;
  }
  for (const order of staleRefunds) {
    const msg = `Order ${order.orderNo} sat REFUND_INITIATED with no refund id — re-driving initiateRefund`;
    logger.warn(
      { orderId: order.id, orderNo: order.orderNo, paymentStatus: PaymentStatus.REFUND_INITIATED },
      msg,
    );
    try {
      // Same claim-first `initiateRefund` the one-shot callers used: its
      // stale-claim reclaim arm admits exactly one winner (never a double
      // refund; a claim completed since the query above is a no-op), and its
      // failure path already reverts to PAID + pages MANUAL_REFUND_REQUIRED.
      await initiateRefund(order.id);
    } catch (error) {
      // initiateRefund alerted + reverted on its own — one Razorpay failure
      // must not stop the rest of the sweep.
      logger.warn(
        { err: error, orderId: order.id, orderNo: order.orderNo },
        "stuck-order scan: stale refund re-initiation failed",
      );
    }
    count += 1;
  }
  if (staleRefunds.length > 0) {
    logger.info(
      { count: staleRefunds.length },
      "stuck-order scan: re-drove stale REFUND_INITIATED claims",
    );
  }

  return count;
}
