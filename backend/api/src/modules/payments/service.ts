import {
  ActorType,
  AlertKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { clearDriverLocation } from "../../core/locationStore";
import { logger } from "../../core/logger";
import { emitOpsAlert, emitOrderStatus } from "../../core/realtime";
import { createRazorpayRefund, RazorpayTimeoutError } from "../../core/razorpay";
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
 *   order is a no-op, so cancel + Rx-reject can both call it safely;
 * - the REFUND_INITIATED claim is taken BEFORE the external call (count===1 is
 *   the atomic claim), so two concurrent initiations can never both reach
 *   Razorpay, and a crash after the external call leaves a state the
 *   `refund.processed` webhook self-heals.
 */

const TIMEOUT_CANCEL_REASON = "Payment not completed in time";

/**
 * How long a REFUND_INITIATED claim with no recorded refundId must sit before a
 * later initiation may reclaim it. A live concurrent initiator finishes in
 * milliseconds; only a process that died between the claim and the Razorpay
 * call (or between the call and the refundId write) leaves a claim this stale.
 * The reclaim UPDATE bumps `updatedAt`, so at most one caller wins per window.
 */
const STALE_REFUND_CLAIM_MS = 2 * 60_000;

/** Record the refund id + the REFUND_INITIATED audit row (shared by both refund paths). */
async function recordRefundInitiated(
  orderId: string,
  refundId: string,
  amountPaise: number,
  rzpPaymentId: string,
  extraMeta: Record<string, unknown> = {},
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await tx.payment.updateMany({
      where: { orderId, refundId: null },
      data: { refundId },
    });
    await tx.auditLog.create({
      data: {
        actorId: ActorType.SYSTEM,
        action: "REFUND_INITIATED",
        entity: "Order",
        entityId: orderId,
        meta: { refundId, amountPaise, rzpPaymentId, ...extraMeta },
      },
    });
  });
}

/**
 * Initiate a refund for a PREPAID order that has been PAID (pinned cross-agent
 * signature — consumed by Rx-reject and the customer/ops cancel of a paid
 * prepaid order). COD orders and orders not in PAID are a no-op.
 *
 * Ordering (money-safety, audit P2): the PAID → REFUND_INITIATED flip is a
 * conditional `updateMany` taken BEFORE the external call — `count === 1` is
 * the atomic claim, so of two concurrent initiations exactly one reaches
 * Razorpay and the loser no-ops (the same no-op semantics callers rely on).
 * Only then is Razorpay called (outside any DB tx, §14) and the refund id +
 * audit row recorded. The later `refund.processed` webhook flips the order to
 * REFUNDED (it treats the gateway as ground truth and advances from PAID as
 * well as REFUND_INITIATED, so no failure branch below can strand it).
 *
 * Failure semantics (the two branches deliberately differ):
 * - TIMEOUT (`RazorpayTimeoutError`) is AMBIGUOUS — the abandoned SDK call may
 *   still succeed at Razorpay. The claim is KEPT (no revert): if the refund did
 *   go through, `refund.processed` completes REFUND_INITIATED → REFUNDED; if it
 *   didn't, the claim (refundId null) goes stale and the 5-min stuck-orders
 *   sweep re-drives this same function, whose stale-claim arm reclaims it.
 *   Reverting to PAID here would drop the arriving `refund.processed` of a
 *   call that actually succeeded, recording the order PAID-unrefunded forever.
 * - DEFINITIVE Razorpay errors (anything else) release the claim back to PAID
 *   so money-truth is restored and a retry can re-claim. If ops instead
 *   refunds by hand, the manual refund's `refund.processed` still completes
 *   PAID → REFUNDED (gateway ground truth).
 * Both branches page ops (MANUAL_REFUND_REQUIRED) and propagate the error to
 * the caller exactly as before.
 *
 * Crash windows:
 * - after the claim, before the Razorpay call: the order sits REFUND_INITIATED
 *   with refundId null — a later initiateRefund call reclaims it once it is
 *   older than STALE_REFUND_CLAIM_MS;
 * - after the Razorpay call, before the refundId write: `refund.processed`
 *   matches the payment by rzpPaymentId and completes REFUND_INITIATED →
 *   REFUNDED (writing the refund id). A stale reclaim racing that window would
 *   re-call Razorpay, which rejects a second full refund — the failure path
 *   then pages ops; no double money-out is possible.
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
  // (already refunding) and PENDING / FAILED (never captured) are all no-ops —
  // except a REFUND_INITIATED claim with NO refundId, left by a process that
  // died mid-initiation; the atomic claim below may recover it once stale.
  const recoverable =
    order.paymentStatus === PaymentStatus.REFUND_INITIATED && order.payment?.refundId == null;
  if (order.paymentStatus !== PaymentStatus.PAID && !recoverable) return;

  const payment = order.payment;
  if (!payment?.rzpPaymentId) {
    // PAID implies a captured payment id was recorded on the webhook — its
    // absence is a data inconsistency, not a normal path. Never silently
    // mark REFUND_INITIATED without an actual refund call.
    logger.error({ orderId }, "initiateRefund: PAID order has no rzpPaymentId — manual refund needed");
    emitOpsAlert(
      AlertKind.MANUAL_REFUND_REQUIRED,
      `Order ${orderId} needs a refund but no captured payment id is on file — refund manually`,
      orderId,
      { amountPaise: payment?.amountPaise ?? null },
    );
    return;
  }

  // ATOMIC CLAIM FIRST: conditional PAID → REFUND_INITIATED. A concurrent
  // initiation loses the updateMany (count 0) and no-ops WITHOUT ever reaching
  // Razorpay. The second arm reclaims a stale crashed claim: the UPDATE bumps
  // `updatedAt`, so under READ COMMITTED the loser of two concurrent reclaims
  // re-evaluates the WHERE on the locked row and matches nothing.
  const claimed = await prisma.order.updateMany({
    where: {
      id: orderId,
      OR: [
        { paymentStatus: PaymentStatus.PAID },
        {
          paymentStatus: PaymentStatus.REFUND_INITIATED,
          updatedAt: { lt: new Date(Date.now() - STALE_REFUND_CLAIM_MS) },
          payment: { is: { refundId: null } },
        },
      ],
    },
    data: { paymentStatus: PaymentStatus.REFUND_INITIATED },
  });
  if (claimed.count !== 1) {
    // A concurrent (or already-completed) initiation owns the refund — no-op,
    // and crucially no redundant external call was made.
    logger.info({ orderId }, "initiateRefund: refund already claimed — no-op");
    return;
  }

  // External refund call OUTSIDE any DB transaction (§14), only after the claim.
  let refund: { id: string; status: string };
  try {
    refund = await createRazorpayRefund(payment.rzpPaymentId, payment.amountPaise);
  } catch (error) {
    if (error instanceof RazorpayTimeoutError) {
      // AMBIGUOUS: the abandoned SDK call may still succeed at Razorpay. KEEP
      // the REFUND_INITIATED claim — a revert to PAID would drop the arriving
      // `refund.processed` of a call that actually went through. If it did
      // succeed the webhook completes REFUND_INITIATED → REFUNDED; if it
      // didn't, the claim (refundId null) goes stale past STALE_REFUND_CLAIM_MS
      // and the 5-min stuck-orders sweep re-drives this function, whose
      // stale-claim arm reclaims it. Page ops either way; surface the error.
      logger.error(
        { err: error, orderId, rzpPaymentId: payment.rzpPaymentId },
        "initiateRefund: razorpay refund timed out — claim kept, outcome ambiguous",
      );
      emitOpsAlert(
        AlertKind.MANUAL_REFUND_REQUIRED,
        `Refund call timed out for order ${orderId} — check the Razorpay dashboard and refund ₹${(payment.amountPaise / 100).toFixed(2)} manually if no refund exists`,
        orderId,
        {
          amountPaise: payment.amountPaise,
          rzpPaymentId: payment.rzpPaymentId,
          reason: "timeout-ambiguous",
        },
      );
      throw error;
    }
    // DEFINITIVE failure: release the claim so the money-truth (PAID) is
    // restored and a later initiation can retry; page ops durably; then surface
    // the error to the caller exactly as the pre-reorder code did. Should ops
    // refund by hand instead, `refund.processed` completes PAID → REFUNDED.
    await prisma.order
      .updateMany({
        where: { id: orderId, paymentStatus: PaymentStatus.REFUND_INITIATED },
        data: { paymentStatus: PaymentStatus.PAID },
      })
      .catch((revertError: unknown) => {
        // Claim stuck at REFUND_INITIATED/refundId null — the stale-claim arm
        // above recovers it on the next initiation attempt.
        logger.error(
          { err: revertError, orderId },
          "initiateRefund: failed to revert claim after refund failure",
        );
      });
    logger.error(
      { err: error, orderId, rzpPaymentId: payment.rzpPaymentId },
      "initiateRefund: razorpay refund failed — manual refund required",
    );
    emitOpsAlert(
      AlertKind.MANUAL_REFUND_REQUIRED,
      `Refund failed for order ${orderId} — refund ₹${(payment.amountPaise / 100).toFixed(2)} manually via the Razorpay dashboard`,
      orderId,
      { amountPaise: payment.amountPaise, rzpPaymentId: payment.rzpPaymentId },
    );
    throw error;
  }

  await recordRefundInitiated(orderId, refund.id, payment.amountPaise, payment.rzpPaymentId);

  logger.info({ orderId, refundId: refund.id, amountPaise: payment.amountPaise }, "refund initiated");
}

/**
 * Auto-refund a payment that was CAPTURED after its order had already been
 * CANCELLED (late capture racing the payment-timeout / payment.failed — audit
 * P1). Called by the webhook post-commit: the money is in hand (rzpPaymentId +
 * amount), the order will never be fulfilled, and `initiateRefund` only acts on
 * PAID orders — so this is the ONLY path that can return that customer's money.
 *
 * Ordering mirrors `initiateRefund`: the conditional PENDING/FAILED →
 * REFUND_INITIATED claim comes FIRST (count===1 wins; a webhook redelivery or
 * concurrent attempt sees count 0 and no-ops without an external call), the
 * Razorpay call runs OUTSIDE any DB transaction, then refundId + audit row are
 * recorded. A crash after the Razorpay call self-heals: `refund.processed`
 * finds the payment by rzpPaymentId and advances REFUND_INITIATED → REFUNDED.
 *
 * Throws when the Razorpay call fails — the webhook caller pages ops and
 * swallows (it must still answer 200). The claim is deliberately NOT reverted
 * on failure: ops is paged to refund by hand, and the manual refund's
 * `refund.processed` webhook then completes REFUND_INITIATED → REFUNDED;
 * reverting to FAILED/PENDING would strand that completion (the webhook only
 * advances PAID / REFUND_INITIATED). The kept claim (refundId null) is also
 * what the 5-min stuck-orders sweep watches: it re-drives `initiateRefund`,
 * whose stale-claim arm retries the refund — a definitive failure there
 * reverts to PAID, which the gateway-ground-truth `refund.processed` handler
 * still completes to REFUNDED after the manual refund.
 */
export async function refundLateCapture(opts: {
  orderId: string;
  rzpPaymentId: string;
  amountPaise: number;
}): Promise<void> {
  const { orderId, rzpPaymentId, amountPaise } = opts;
  const prisma = getPrisma();

  // Atomic claim on the pre-states THIS path sees (the order was cancelled by
  // the timeout/failed path → FAILED, or cancelled while PENDING). refundId
  // null keeps the step safe to re-enter: once a refund id is recorded no
  // redelivery can claim again.
  const claimed = await prisma.order.updateMany({
    where: {
      id: orderId,
      paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
      payment: { is: { refundId: null } },
    },
    data: { paymentStatus: PaymentStatus.REFUND_INITIATED },
  });
  if (claimed.count !== 1) {
    logger.info({ orderId }, "refundLateCapture: refund already claimed — no-op");
    return;
  }

  // External refund call OUTSIDE any DB transaction (§14) — may throw; the
  // webhook caller owns the MANUAL_REFUND_REQUIRED alerting.
  const refund = await createRazorpayRefund(rzpPaymentId, amountPaise);

  await recordRefundInitiated(orderId, refund.id, amountPaise, rzpPaymentId, {
    reason: "late-capture-on-cancelled-order",
  });

  logger.info(
    { orderId, refundId: refund.id, amountPaise },
    "late capture on a CANCELLED order — refund initiated",
  );
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
