import {
  ActorType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { clearDriverLocation } from "../../core/locationStore";
import { logger } from "../../core/logger";
import { emitOrderStatus } from "../../core/realtime";
import { createRazorpayRefund } from "../../core/razorpay";
import { notifyUser } from "../notifications/service";
import { restockOrder } from "../orders/service";
import { assertTransition } from "../orders/stateMachine";

/**
 * Payments service (BLUEPRINT §9.3, §14) — refunds and the payment-timeout
 * expiry handler. The Razorpay-order create + webhook live in their own files
 * (orders/service PREPAID branch, payments/webhook); this module owns the
 * money-out (refund) path and the auto-cancel of unpaid orders.
 *
 * Isolation rules (§14, carried from the phase briefs):
 * - the external Razorpay refund call happens OUTSIDE any DB transaction;
 * - status flips use the conditional `updateMany` guard so concurrent callers
 *   (capture vs timeout, double cancel) can never both win;
 * - refund initiation is idempotent — a re-entry on a REFUND_INITIATED/REFUNDED
 *   order is a no-op, so cancel + Rx-reject can both call it safely.
 */

const TIMEOUT_CANCEL_REASON = "Payment not completed in time";

/**
 * Initiate a refund for a PREPAID order that has been PAID (pinned cross-agent
 * signature — consumed by Rx-reject and the customer/ops cancel of a paid
 * prepaid order). COD orders and orders not in PAID are a no-op.
 *
 * The captured payment is refunded via Razorpay (external, no DB tx), then the
 * order flips to REFUND_INITIATED and the refund id is recorded. The later
 * `refund.processed` webhook flips REFUND_INITIATED → REFUNDED.
 */
export async function initiateRefund(orderId: string): Promise<void> {
  const prisma = getPrisma();

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, paymentMethod: true, paymentStatus: true, payment: true },
  });
  if (!order) {
    logger.warn({ orderId }, "initiateRefund: order not found");
    return;
  }

  // COD carries no captured payment; nothing to refund (§9.3).
  if (order.paymentMethod !== PaymentMethod.PREPAID) return;

  // Idempotent: only a PAID order can be refunded. REFUND_INITIATED / REFUNDED
  // (already refunding) and PENDING / FAILED (never captured) are all no-ops.
  if (order.paymentStatus !== PaymentStatus.PAID) return;

  const payment = order.payment;
  if (!payment?.rzpPaymentId) {
    // PAID implies a captured payment id was recorded on the webhook — its
    // absence is a data inconsistency, not a normal path. Never silently
    // mark REFUND_INITIATED without an actual refund call.
    logger.error({ orderId }, "initiateRefund: PAID order has no rzpPaymentId — manual refund needed");
    return;
  }

  // External refund call OUTSIDE any DB transaction (§14).
  const refund = await createRazorpayRefund(payment.rzpPaymentId, payment.amountPaise);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: orderId, paymentStatus: PaymentStatus.PAID },
      data: { paymentStatus: PaymentStatus.REFUND_INITIATED },
    });
    if (updated.count !== 1) {
      // A concurrent refund initiation won the race — our external call was
      // redundant (refunds are rare and callers flip order status first, so
      // this is effectively unreachable). Do not overwrite the refund id.
      logger.warn({ orderId }, "initiateRefund: order left PAID concurrently");
      return;
    }
    await tx.payment.updateMany({
      where: { orderId, refundId: null },
      data: { refundId: refund.id },
    });
    await tx.auditLog.create({
      data: {
        actorId: ActorType.SYSTEM,
        action: "REFUND_INITIATED",
        entity: "Order",
        entityId: orderId,
        meta: { refundId: refund.id, amountPaise: payment.amountPaise, rzpPaymentId: payment.rzpPaymentId },
      },
    });
  });

  logger.info({ orderId, refundId: refund.id, amountPaise: payment.amountPaise }, "refund initiated");
}

/**
 * Payment-timeout expiry (phase-2 brief §3): auto-cancel an order that is still
 * PENDING_PAYMENT and release its reserved stock (actor SYSTEM). No-op once the
 * order has been captured (→ PLACED/RX_REVIEW) or otherwise moved on.
 */
export async function expireUnpaidOrder(orderId: string): Promise<void> {
  const prisma = getPrisma();

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, userId: true, orderNo: true },
  });
  if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return;

  let cancelled = false;
  await prisma.$transaction(async (tx) => {
    assertTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, ActorType.SYSTEM);

    // Conditional flip takes the order row lock — if a `payment.captured` webhook
    // wins the race the count is 0 and we leave the (now PLACED) order untouched.
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: {
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.FAILED,
        cancelReason: TIMEOUT_CANCEL_REASON,
        cancelledAt: new Date(),
      },
    });
    if (updated.count !== 1) return;

    await restockOrder(tx, orderId);
    await tx.orderEvent.create({
      data: {
        orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.CANCELLED,
        actorType: ActorType.SYSTEM,
        note: "payment-timeout",
      },
    });
    cancelled = true;
  });

  if (cancelled) {
    emitOrderStatus({ id: orderId, status: OrderStatus.CANCELLED });
    clearDriverLocation(orderId);
    await notifyUser({
      userId: order.userId,
      type: "ORDER_CANCELLED",
      title: "Order cancelled",
      body: `Your order ${order.orderNo} was cancelled because payment wasn't completed in time.`,
      data: { orderId },
    });
    logger.info({ orderId }, "PENDING_PAYMENT order auto-cancelled on payment timeout");
  }
}
