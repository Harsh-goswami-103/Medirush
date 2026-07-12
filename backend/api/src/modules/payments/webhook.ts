import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  ActorType,
  AlertKind,
  OrderStatus,
  PaymentStatus,
  type PaymentMethod,
  type RxStatus,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { clearDriverLocation } from "../../core/locationStore";
import { logger } from "../../core/logger";
import { emitOpsAlert, emitOrderNew, emitOrderStatus } from "../../core/realtime";
import { verifyWebhookSignature } from "../../core/razorpay";
import { notifyUser } from "../notifications/service";
import { restockOrder } from "../orders/service";
import { assertTransition } from "../orders/stateMachine";
import { cancelPaymentTimeout } from "../../jobs/paymentTimeout";
import { refundLateCapture } from "./service";

/**
 * Razorpay webhook processor (BLUEPRINT §9.3, §10.1; phase-2 brief §2).
 *
 * Money-safety design:
 * - the raw body is HMAC-verified BEFORE anything else (§10.1 tampering);
 * - the `PaymentEvent(eventId PK)` insert IS the idempotency gate AND it shares a
 *   transaction with the state change, so a duplicate delivery (same eventId) is
 *   a 200 no-op, and a mid-handle failure rolls the gate back so Razorpay's retry
 *   re-processes exactly once;
 * - every status flip is a conditional `updateMany` guard, so a `payment.captured`
 *   racing the payment-timeout job can never both win;
 * - unknown event types are recorded and ignored (always 200 — Razorpay retries
 *   on any non-2xx).
 */

/** A capture that landed on an already-CANCELLED order — refund post-commit. */
interface LateCaptureOutcome {
  action: "late_capture_refund";
  orderId: string;
  orderNo: string;
  /** Captured payment id (from the event or already on file); null → cannot auto-refund. */
  rzpPaymentId: string | null;
  amountPaise: number;
}

/** What the transaction did, so the caller can fire post-commit side effects. */
type WebhookOutcome =
  | {
      action: "captured";
      orderId: string;
      userId: string;
      emit: {
        id: string;
        orderNo: string;
        status: OrderStatus;
        paymentMethod: PaymentMethod;
        requiresRx: boolean;
        rxStatus: RxStatus;
        totalPaise: number;
        placedAt: Date;
      };
    }
  | { action: "cancelled"; orderId: string; userId: string; orderNo: string }
  | { action: "refunded"; orderId: string }
  | LateCaptureOutcome
  | null;

interface RazorpayEntity {
  id?: string;
  order_id?: string;
  payment_id?: string;
}
interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayEntity };
    refund?: { entity?: RazorpayEntity };
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Result surfaced to the route (always answered 200 unless an AppError is thrown). */
export interface WebhookResult {
  received: true;
  /** True when this eventId had already been processed (idempotent replay). */
  duplicate: boolean;
  /** The recognised event type, or "ignored" for unknown types. */
  handled: string;
}

/**
 * Verify + process one webhook delivery. Throws `AppError` (401 bad signature /
 * 400 bad JSON); otherwise resolves and the route answers 200.
 */
export async function processWebhook(
  rawBody: string,
  signature: string,
  eventIdHeader: string | undefined,
): Promise<WebhookResult> {
  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    throw new AppError("UNAUTHENTICATED", "Invalid webhook signature", 401);
  }

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhookBody;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Webhook body is not valid JSON", 400);
  }

  const type = body.event ?? "unknown";
  // Razorpay sends a stable per-event id header; fall back to a body hash so the
  // idempotency gate still holds if the header is ever absent.
  const eventId = eventIdHeader ?? `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;

  const prisma = getPrisma();
  let outcome: WebhookOutcome = null;

  try {
    outcome = await prisma.$transaction(async (tx) => {
      // Idempotency gate FIRST — a duplicate eventId aborts the whole tx via P2002.
      await tx.paymentEvent.create({
        data: { eventId, type, payload: body as unknown as Prisma.InputJsonValue },
      });
      return handleEvent(tx, type, body);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      logger.info({ eventId, type }, "razorpay webhook: duplicate event ignored");
      return { received: true, duplicate: true, handled: type };
    }
    throw error;
  }

  // Post-commit side effects (§9.1: emits/enqueues AFTER the tx commits).
  if (outcome?.action === "captured") {
    await cancelPaymentTimeout(outcome.orderId).catch((err) =>
      logger.warn({ err, orderId: outcome!.orderId }, "payment-timeout cancel skipped"),
    );
    emitOrderStatus({ id: outcome.emit.id, status: outcome.emit.status, orderNo: outcome.emit.orderNo, rxStatus: outcome.emit.rxStatus });
    emitOrderNew(outcome.emit);
    await notifyUser({
      userId: outcome.userId,
      type: "ORDER_PLACED",
      title: "Payment received",
      body: `Payment received — your order ${outcome.emit.orderNo} is confirmed.`,
      data: { orderId: outcome.orderId },
    });
  } else if (outcome?.action === "cancelled") {
    emitOrderStatus({ id: outcome.orderId, status: OrderStatus.CANCELLED });
    clearDriverLocation(outcome.orderId);
    await notifyUser({
      userId: outcome.userId,
      type: "ORDER_CANCELLED",
      title: "Order cancelled",
      body: `Your order ${outcome.orderNo} was cancelled because the payment failed. Any amount charged will be refunded.`,
      data: { orderId: outcome.orderId },
    });
  } else if (outcome?.action === "refunded") {
    // Refund does not change order status; nudge the customer/ops views to refetch.
    emitOrderStatus({ id: outcome.orderId, status: OrderStatus.CANCELLED });
  } else if (outcome?.action === "late_capture_refund") {
    await runLateCaptureRefund(outcome);
  }

  return { received: true, duplicate: false, handled: outcome ? type : "ignored" };
}

/**
 * Post-commit auto-refund of a capture that landed on an already-CANCELLED
 * order (audit P1 — before this, the captured money had NO code path back to
 * the customer, since initiateRefund only acts on PAID orders).
 *
 * Failures are swallowed DELIBERATELY and the webhook still answers 200: the
 * PaymentEvent idempotency row for this eventId committed with the capture tx,
 * so a non-2xx would only make Razorpay redeliver an event that is now a
 * guaranteed duplicate no-op — a retry can never reach this code again.
 * Instead of a useless 500, ops is paged durably (MANUAL_REFUND_REQUIRED is a
 * critical alert kind: OpsAlert row + Sentry page) and the loud log is kept.
 *
 * Recovery after a failure is doubly covered: `refundLateCapture` keeps its
 * REFUND_INITIATED claim (refundId null), so the 5-min stuck-orders sweep
 * re-drives `initiateRefund` automatically, and whichever refund eventually
 * lands — the sweep's retry or the ops manual one — its `refund.processed`
 * completes the order to REFUNDED (that handler treats the gateway as ground
 * truth and advances from PAID as well as REFUND_INITIATED, so even a sweep
 * retry that failed definitively and reverted the claim to PAID stays healable).
 */
async function runLateCaptureRefund(outcome: LateCaptureOutcome): Promise<void> {
  const { orderId, orderNo, rzpPaymentId, amountPaise } = outcome;
  const rupees = (amountPaise / 100).toFixed(2);

  if (!rzpPaymentId) {
    logger.error(
      { orderId },
      "payment captured for a CANCELLED order with no payment id on file — manual refund required",
    );
    emitOpsAlert(
      AlertKind.MANUAL_REFUND_REQUIRED,
      `Payment captured for cancelled order ${orderNo} but no payment id is on file — refund ₹${rupees} manually`,
      orderId,
      { orderNo, amountPaise },
    );
    return;
  }

  try {
    await refundLateCapture({ orderId, rzpPaymentId, amountPaise });
    // paymentStatus changed (→ REFUND_INITIATED); nudge customer/ops views to
    // refetch, same as the refund.processed handler.
    emitOrderStatus({ id: orderId, status: OrderStatus.CANCELLED });
  } catch (error) {
    logger.error(
      { err: error, orderId, rzpPaymentId },
      "payment captured for a CANCELLED order — auto-refund FAILED, manual refund required",
    );
    emitOpsAlert(
      AlertKind.MANUAL_REFUND_REQUIRED,
      `Auto-refund failed for cancelled order ${orderNo} — refund ₹${rupees} manually via the Razorpay dashboard`,
      orderId,
      { orderNo, amountPaise, rzpPaymentId },
    );
  }
}

/* ----------------------------------------------------------- event handlers */

async function handleEvent(
  tx: Prisma.TransactionClient,
  type: string,
  body: RazorpayWebhookBody,
): Promise<WebhookOutcome> {
  switch (type) {
    case "payment.captured":
      return handleCaptured(tx, body);
    case "payment.failed":
      return handleFailed(tx, body);
    case "refund.processed":
      return handleRefundProcessed(tx, body);
    default:
      logger.info({ type }, "razorpay webhook: unhandled event type ignored");
      return null;
  }
}

async function handleCaptured(
  tx: Prisma.TransactionClient,
  body: RazorpayWebhookBody,
): Promise<WebhookOutcome> {
  const entity = body.payload?.payment?.entity;
  const rzpOrderId = entity?.order_id;
  const rzpPaymentId = entity?.id;
  if (!rzpOrderId) {
    logger.warn("payment.captured without order_id — ignored");
    return null;
  }

  const payment = await tx.payment.findUnique({
    where: { rzpOrderId },
    include: { order: true },
  });
  if (!payment) {
    logger.warn({ rzpOrderId }, "payment.captured for unknown order — ignored");
    return null;
  }
  const order = payment.order;

  // Always record the captured payment id (even if the order already moved), so a
  // later refund has the id to work with.
  if (rzpPaymentId && !payment.rzpPaymentId) {
    await tx.payment.update({ where: { id: payment.id }, data: { rzpPaymentId } });
  }

  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    // Timeout already cancelled it, or this is a re-delivery after processing.
    if (
      order.status === OrderStatus.CANCELLED &&
      (order.paymentStatus === PaymentStatus.PENDING ||
        order.paymentStatus === PaymentStatus.FAILED)
    ) {
      // Late capture racing the cancel: real money was taken for an order that
      // will never ship, and no other path refunds a non-PAID order. The
      // refund fires post-commit — the external call must never run inside
      // this tx (§14). REFUND_INITIATED/REFUNDED pre-states skip this branch:
      // an earlier delivery (or ops) already owns the refund.
      logger.error(
        { orderId: order.id, rzpPaymentId },
        "payment captured for a CANCELLED order — auto-initiating refund",
      );
      return {
        action: "late_capture_refund",
        orderId: order.id,
        orderNo: order.orderNo,
        rzpPaymentId: rzpPaymentId ?? payment.rzpPaymentId,
        amountPaise: payment.amountPaise,
      };
    }
    return null;
  }

  const newStatus = order.requiresRx ? OrderStatus.RX_REVIEW : OrderStatus.PLACED;
  assertTransition(OrderStatus.PENDING_PAYMENT, newStatus, ActorType.SYSTEM);

  const now = new Date();
  const updated = await tx.order.updateMany({
    where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
    data: { status: newStatus, paymentStatus: PaymentStatus.PAID, placedAt: now },
  });
  if (updated.count !== 1) return null; // lost the race to the timeout job

  await tx.orderEvent.create({
    data: {
      orderId: order.id,
      from: OrderStatus.PENDING_PAYMENT,
      to: newStatus,
      actorType: ActorType.SYSTEM,
      note: "payment-captured",
    },
  });

  return {
    action: "captured",
    orderId: order.id,
    userId: order.userId,
    emit: {
      id: order.id,
      orderNo: order.orderNo,
      status: newStatus,
      paymentMethod: order.paymentMethod,
      requiresRx: order.requiresRx,
      rxStatus: order.rxStatus,
      totalPaise: order.totalPaise,
      placedAt: now,
    },
  };
}

async function handleFailed(
  tx: Prisma.TransactionClient,
  body: RazorpayWebhookBody,
): Promise<WebhookOutcome> {
  const entity = body.payload?.payment?.entity;
  const rzpOrderId = entity?.order_id;
  if (!rzpOrderId) {
    logger.warn("payment.failed without order_id — ignored");
    return null;
  }

  const payment = await tx.payment.findUnique({
    where: { rzpOrderId },
    include: { order: { select: { id: true, status: true, userId: true, orderNo: true } } },
  });
  if (!payment) {
    logger.warn({ rzpOrderId }, "payment.failed for unknown order — ignored");
    return null;
  }
  const order = payment.order;
  if (order.status !== OrderStatus.PENDING_PAYMENT) return null;

  assertTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, ActorType.SYSTEM);
  const updated = await tx.order.updateMany({
    where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
    data: {
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.FAILED,
      cancelReason: "Payment failed",
      cancelledAt: new Date(),
    },
  });
  if (updated.count !== 1) return null;

  await restockOrder(tx, order.id);
  if (entity?.id && !payment.rzpPaymentId) {
    await tx.payment.update({ where: { id: payment.id }, data: { rzpPaymentId: entity.id } });
  }
  await tx.orderEvent.create({
    data: {
      orderId: order.id,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.CANCELLED,
      actorType: ActorType.SYSTEM,
      note: "payment-failed",
    },
  });

  return { action: "cancelled", orderId: order.id, userId: order.userId, orderNo: order.orderNo };
}

async function handleRefundProcessed(
  tx: Prisma.TransactionClient,
  body: RazorpayWebhookBody,
): Promise<WebhookOutcome> {
  const refundEntity = body.payload?.refund?.entity;
  const refundId = refundEntity?.id;
  const rzpPaymentId = refundEntity?.payment_id ?? body.payload?.payment?.entity?.id;

  const payment = rzpPaymentId
    ? await tx.payment.findFirst({ where: { rzpPaymentId }, include: { order: { select: { id: true, paymentStatus: true } } } })
    : refundId
      ? await tx.payment.findFirst({ where: { refundId }, include: { order: { select: { id: true, paymentStatus: true } } } })
      : null;
  if (!payment) {
    logger.warn({ rzpPaymentId, refundId }, "refund.processed for unknown payment — ignored");
    return null;
  }
  const order = payment.order;

  // The gateway is ground truth: a processed refund means the money HAS left,
  // whatever our local state says. Advance from REFUND_INITIATED (the normal
  // claim) AND from PAID — a claim released after a definitive Razorpay error
  // (or a timed-out call that succeeded late) is refunded manually by ops, and
  // this event is the ONLY completion signal (the PaymentEvent row consumed
  // the eventId; Razorpay never redelivers after a 200). Anything else
  // (already REFUNDED, or PENDING/FAILED pre-capture) is an idempotent no-op.
  if (
    order.paymentStatus !== PaymentStatus.PAID &&
    order.paymentStatus !== PaymentStatus.REFUND_INITIATED
  ) {
    return null;
  }

  const updated = await tx.order.updateMany({
    where: {
      id: order.id,
      paymentStatus: { in: [PaymentStatus.PAID, PaymentStatus.REFUND_INITIATED] },
    },
    data: { paymentStatus: PaymentStatus.REFUNDED },
  });
  if (updated.count !== 1) return null;

  if (refundId && !payment.refundId) {
    await tx.payment.update({ where: { id: payment.id }, data: { refundId } });
  }

  return { action: "refunded", orderId: order.id };
}
