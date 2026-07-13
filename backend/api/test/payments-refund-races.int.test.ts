import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { AlertKind, IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Refund race hardening (audit P1/P2). Real Postgres; Razorpay in STUB mode
 * with `createRazorpayRefund` wrapped in a spy so tests can count external
 * refund attempts and inject Razorpay failures.
 *
 * P1: a late `payment.captured` on an already-CANCELLED order auto-initiates a
 * refund (previously the money had NO code path back to the customer). The
 * step is replay-safe and pages MANUAL_REFUND_REQUIRED when the refund call
 * fails — the webhook still answers 200.
 *
 * P2: `initiateRefund` claims PAID → REFUND_INITIATED atomically BEFORE the
 * external call, so concurrent initiations fire exactly one Razorpay refund;
 * a DEFINITIVE Razorpay failure reverts to PAID + pages ops, while a TIMEOUT
 * (ambiguous — the abandoned SDK call may still succeed) KEEPS the claim; a
 * stale crashed claim (REFUND_INITIATED, refundId null) is recoverable.
 *
 * Ground truth: the `refund.processed` webhook completes PAID as well as
 * REFUND_INITIATED to REFUNDED — money that left the gateway is recorded even
 * when a definitive failure had reverted the claim and ops refunded by hand.
 */

// Env before app import → config parses eagerly. No keys ⇒ deterministic stubs.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET; // → "dev-webhook-secret"
delete process.env.R2_ACCOUNT_ID;

// Spy-wrap the refund call (stub behaviour preserved: resolves { id: "rfnd_…" })
// so tests can assert exactly-one external call and mock one-shot failures.
vi.mock("../src/core/razorpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/razorpay")>();
  return { ...actual, createRazorpayRefund: vi.fn(actual.createRazorpayRefund) };
});

const { createRazorpayRefund, RazorpayTimeoutError, signWebhookBody } = await import(
  "../src/core/razorpay"
);
const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { flushOpsAlertWrites } = await import("../src/core/realtime");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { expireUnpaidOrder, initiateRefund } = await import("../src/modules/payments/service");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
const refundSpy = vi.mocked(createRazorpayRefund);
let app: App;

/* ---------------------------------------------------------------- fixtures */

async function setCartItem(userId: string, productId: string, qty: number): Promise<void> {
  const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    create: { cartId: cart.id, productId, qty },
    update: { qty },
  });
}

/** Seed a customer with an in-radius address + a cart holding 2 of a product. */
async function seedPrepaidCart() {
  const customer = await user("CUSTOMER");
  const addr = await address(customer.id);
  const p = await product({ stock: 50, pricePaise: 20000 });
  await setCartItem(customer.id, p.id, 2);
  return { customer, headers: authHeaders(customer), addressId: addr.id };
}

function postPrepaid(headers: Record<string, string>, addressId: string) {
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
    payload: { addressId, paymentMethod: "PREPAID" },
  });
}

function injectWebhook(bodyObj: unknown, opts: { eventId?: string } = {}) {
  const raw = JSON.stringify(bodyObj);
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/razorpay",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signWebhookBody(raw),
      ...(opts.eventId ? { "x-razorpay-event-id": opts.eventId } : {}),
    },
    payload: raw,
  });
}

const capturedEvent = (rzpOrderId: string, rzpPaymentId: string, amount: number) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: rzpPaymentId, order_id: rzpOrderId, amount, status: "captured" } } },
});

/** Place a PREPAID order over HTTP, then cancel it via the payment timeout. */
async function cancelledPrepaidOrder() {
  const { headers, addressId } = await seedPrepaidCart();
  const { order, razorpay } = (await postPrepaid(headers, addressId)).json().data as {
    order: { id: string; orderNo: string; totalPaise: number };
    razorpay: { rzpOrderId: string };
  };
  await expireUnpaidOrder(order.id); // → CANCELLED + paymentStatus FAILED + restocked
  return { order, rzpOrderId: razorpay.rzpOrderId };
}

/** Seed a captured (PAID) PREPAID order directly, as after a normal capture. */
async function paidPrepaidOrder() {
  const customer = await user("CUSTOMER");
  const p = await product({ stock: 10, pricePaise: 20000 });
  const n = randomUUID().slice(0, 8);
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-RACE-${n}`,
      userId: customer.id,
      status: "CANCELLED",
      paymentMethod: "PREPAID",
      paymentStatus: "PAID",
      cancelReason: "out of stock",
      cancelledAt: new Date(),
      addressSnapshot: {
        name: "Cust",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: 12.97,
        lng: 77.59,
      } as Prisma.InputJsonValue,
      distanceM: 100,
      itemsPaise: 20000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 22000,
      requiresRx: false,
      rxStatus: "NA",
      placedAt: new Date(),
      items: {
        create: [
          {
            productId: p.id,
            nameSnap: p.name,
            packSizeSnap: p.packSize,
            pricePaise: p.pricePaise,
            mrpPaise: p.mrpPaise,
            gstRatePct: p.gstRatePct,
            hsnSnap: p.hsnCode,
            requiresRx: false,
            qty: 1,
          },
        ],
      },
    },
  });
  await prisma.payment.create({
    data: {
      orderId: order.id,
      rzpOrderId: `order_race_${n}`,
      rzpPaymentId: `pay_race_${n}`,
      amountPaise: 22000,
    },
  });
  return order;
}

const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const paymentRow = (orderId: string) => prisma.payment.findUniqueOrThrow({ where: { orderId } });
const refundAudits = (orderId: string) =>
  prisma.auditLog.count({ where: { action: "REFUND_INITIATED", entity: "Order", entityId: orderId } });

/* ------------------------------------------------------------------- setup */

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  clearAuthCaches();
  bustStoreConfigCache();
  bustFlagCache();
  await storeConfig();
  await appSettings();
  refundSpy.mockClear();
});

/* ---------------------------------------------- P1: capture after cancel */

describe("payment.captured on an already-CANCELLED order", () => {
  it("auto-initiates a refund and is replay-safe (same and new eventId)", async () => {
    const { order, rzpOrderId } = await cancelledPrepaidOrder();
    const event = capturedEvent(rzpOrderId, "pay_LATECXL", order.totalPaise);

    const res = await injectWebhook(event, { eventId: "evt_late_cxl" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ received: true, duplicate: false });

    // Order stays CANCELLED, money flips to REFUND_INITIATED with a real refund id.
    const updated = await orderRow(order.id);
    expect(updated.status).toBe("CANCELLED");
    expect(updated.paymentStatus).toBe("REFUND_INITIATED");
    const payment = await paymentRow(order.id);
    expect(payment.rzpPaymentId).toBe("pay_LATECXL");
    expect(payment.refundId).toMatch(/^rfnd_/);

    // Exactly one external refund call, for the captured id + full amount.
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith("pay_LATECXL", order.totalPaise);
    expect(await refundAudits(order.id)).toBe(1);

    // Replay with the SAME eventId → duplicate no-op (idempotency gate).
    const replay = await injectWebhook(event, { eventId: "evt_late_cxl" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });

    // Redelivery under a NEW eventId → the refund claim blocks a second refund.
    const redelivered = await injectWebhook(event, { eventId: "evt_late_cxl_2" });
    expect(redelivered.statusCode).toBe(200);

    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect((await paymentRow(order.id)).refundId).toBe(payment.refundId);
    expect(await refundAudits(order.id)).toBe(1);

    // Success path pages nobody.
    await flushOpsAlertWrites();
    expect(
      await prisma.opsAlert.count({ where: { kind: AlertKind.MANUAL_REFUND_REQUIRED } }),
    ).toBe(0);
  });

  it("pages MANUAL_REFUND_REQUIRED when the refund call fails — webhook still 200, state completable", async () => {
    const { order, rzpOrderId } = await cancelledPrepaidOrder();
    refundSpy.mockRejectedValueOnce(new Error("razorpay 502"));

    const res = await injectWebhook(capturedEvent(rzpOrderId, "pay_LATEFAIL", order.totalPaise), {
      eventId: "evt_late_fail",
    });
    // 200 despite the failure: the eventId is consumed, a Razorpay retry would
    // be a duplicate no-op — the durable alert is the recovery channel.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ received: true, duplicate: false });

    await flushOpsAlertWrites();
    const alert = await prisma.opsAlert.findFirstOrThrow({
      where: { kind: AlertKind.MANUAL_REFUND_REQUIRED, refId: order.id },
    });
    expect(alert.meta).toMatchObject({
      orderNo: order.orderNo,
      amountPaise: order.totalPaise,
      rzpPaymentId: "pay_LATEFAIL",
    });

    // Claim kept (REFUND_INITIATED, refundId null): sane, and deliberately so —
    // the ops-performed manual refund's refund.processed completes the state.
    const updated = await orderRow(order.id);
    expect(updated.status).toBe("CANCELLED");
    expect(updated.paymentStatus).toBe("REFUND_INITIATED");
    expect((await paymentRow(order.id)).refundId).toBeNull();
    expect(await refundAudits(order.id)).toBe(0);

    // Ops refunds by hand in the dashboard → refund.processed → REFUNDED.
    const processed = await injectWebhook(
      {
        event: "refund.processed",
        payload: { refund: { entity: { id: "rfnd_MANUAL", payment_id: "pay_LATEFAIL" } } },
      },
      { eventId: "evt_manual_rfnd" },
    );
    expect(processed.statusCode).toBe(200);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUNDED");
    expect((await paymentRow(order.id)).refundId).toBe("rfnd_MANUAL");
  });
});

/* ------------------------------------------- P2: claim-before-external-call */

describe("initiateRefund claims before calling Razorpay", () => {
  it("concurrent double initiation fires exactly ONE external refund", async () => {
    const order = await paidPrepaidOrder();

    await Promise.all([initiateRefund(order.id), initiateRefund(order.id)]);

    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUND_INITIATED");
    expect((await paymentRow(order.id)).refundId).toMatch(/^rfnd_/);
    expect(await refundAudits(order.id)).toBe(1);

    // A later re-entry (e.g. rx-reject after cancel) stays a no-op.
    await initiateRefund(order.id);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(await refundAudits(order.id)).toBe(1);
  });

  it("reverts to PAID + pages ops on a DEFINITIVE Razorpay error; a retry then succeeds", async () => {
    const order = await paidPrepaidOrder();
    refundSpy.mockRejectedValueOnce(new Error("razorpay refused"));

    // The error surfaces to the caller exactly as before the reorder.
    await expect(initiateRefund(order.id)).rejects.toThrow("razorpay refused");

    // Money-truth restored: the order is PAID again, nothing recorded.
    expect((await orderRow(order.id)).paymentStatus).toBe("PAID");
    expect((await paymentRow(order.id)).refundId).toBeNull();
    expect(await refundAudits(order.id)).toBe(0);

    await flushOpsAlertWrites();
    const alert = await prisma.opsAlert.findFirstOrThrow({
      where: { kind: AlertKind.MANUAL_REFUND_REQUIRED, refId: order.id },
    });
    expect(alert.meta).toMatchObject({ amountPaise: 22000 });

    // Transient failure → a straight retry works.
    await initiateRefund(order.id);
    expect(refundSpy).toHaveBeenCalledTimes(2);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUND_INITIATED");
    expect((await paymentRow(order.id)).refundId).toMatch(/^rfnd_/);
    expect(await refundAudits(order.id)).toBe(1);
  });

  it("KEEPS the claim on a Razorpay TIMEOUT (ambiguous — the call may still succeed)", async () => {
    const order = await paidPrepaidOrder();
    refundSpy.mockRejectedValueOnce(new RazorpayTimeoutError("refund"));

    // The timeout still surfaces to the caller.
    await expect(initiateRefund(order.id)).rejects.toBeInstanceOf(RazorpayTimeoutError);

    // NO revert: the claim is kept so an eventual refund.processed (the
    // abandoned SDK call succeeded late) completes it, and the stuck-orders
    // sweep retries it otherwise (refundId is still null → reclaimable once stale).
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUND_INITIATED");
    expect((await paymentRow(order.id)).refundId).toBeNull();
    expect(await refundAudits(order.id)).toBe(0);

    // Ops is paged durably, flagged as ambiguous (check the dashboard first).
    await flushOpsAlertWrites();
    const alert = await prisma.opsAlert.findFirstOrThrow({
      where: { kind: AlertKind.MANUAL_REFUND_REQUIRED, refId: order.id },
    });
    expect(alert.meta).toMatchObject({ amountPaise: 22000, reason: "timeout-ambiguous" });

    // If the abandoned call DID succeed, its refund.processed completes the claim.
    const payment = await paymentRow(order.id);
    const processed = await injectWebhook(
      {
        event: "refund.processed",
        payload: { refund: { entity: { id: "rfnd_LATE_OK", payment_id: payment.rzpPaymentId } } },
      },
      { eventId: "evt_timeout_late_ok" },
    );
    expect(processed.statusCode).toBe(200);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUNDED");
    expect((await paymentRow(order.id)).refundId).toBe("rfnd_LATE_OK");
  });

  it("recovers a STALE crashed claim (REFUND_INITIATED, refundId null)", async () => {
    const order = await paidPrepaidOrder();
    // Simulate a process that claimed the refund and died before reaching
    // Razorpay: REFUND_INITIATED, no refundId, last touched 5 minutes ago.
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: "REFUND_INITIATED", updatedAt: new Date(Date.now() - 5 * 60_000) },
    });

    await initiateRefund(order.id);

    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUND_INITIATED");
    expect((await paymentRow(order.id)).refundId).toMatch(/^rfnd_/);
    expect(await refundAudits(order.id)).toBe(1);
  });

  it("does NOT steal a FRESH in-flight claim from a live concurrent initiator", async () => {
    const order = await paidPrepaidOrder();
    // A live initiator claimed moments ago (updatedAt = now) and has not yet
    // written the refund id — a second call must not fire a second refund.
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: "REFUND_INITIATED" },
    });

    await initiateRefund(order.id);

    expect(refundSpy).not.toHaveBeenCalled();
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUND_INITIATED");
    expect((await paymentRow(order.id)).refundId).toBeNull();
  });
});

/* -------------------------------------- refund.processed is gateway ground truth */

describe("refund.processed treats the gateway as ground truth", () => {
  it("completes a PAID order to REFUNDED and backfills the refundId", async () => {
    // A definitive failure reverted the claim to PAID (or a webhook raced the
    // claim) — the gateway says the money left, so PAID must still advance.
    const order = await paidPrepaidOrder();
    const payment = await paymentRow(order.id);

    const processed = await injectWebhook(
      {
        event: "refund.processed",
        payload: { refund: { entity: { id: "rfnd_TRUTH", payment_id: payment.rzpPaymentId } } },
      },
      { eventId: "evt_ground_truth" },
    );
    expect(processed.statusCode).toBe(200);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUNDED");
    expect((await paymentRow(order.id)).refundId).toBe("rfnd_TRUTH");

    // Idempotent: a redelivery under a new eventId is a no-op on REFUNDED.
    const redelivered = await injectWebhook(
      {
        event: "refund.processed",
        payload: { refund: { entity: { id: "rfnd_TRUTH", payment_id: payment.rzpPaymentId } } },
      },
      { eventId: "evt_ground_truth_2" },
    );
    expect(redelivered.statusCode).toBe(200);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUNDED");
    expect((await paymentRow(order.id)).refundId).toBe("rfnd_TRUTH");
  });

  it("a definitive failure reverts to PAID, and the later MANUAL refund still completes to REFUNDED", async () => {
    const order = await paidPrepaidOrder();
    refundSpy.mockRejectedValueOnce(new Error("razorpay refused"));
    await expect(initiateRefund(order.id)).rejects.toThrow("razorpay refused");

    // Definitive error → claim released, money-truth restored. (Alert content
    // is pinned by the revert test above; flush so the write can't leak.)
    expect((await orderRow(order.id)).paymentStatus).toBe("PAID");
    expect((await paymentRow(order.id)).refundId).toBeNull();
    await flushOpsAlertWrites();

    // Ops refunds by hand in the dashboard → refund.processed lands on the
    // PAID order (the REFUND_INITIATED claim is long gone) and must complete it.
    const payment = await paymentRow(order.id);
    const processed = await injectWebhook(
      {
        event: "refund.processed",
        payload: { refund: { entity: { id: "rfnd_OPS_HAND", payment_id: payment.rzpPaymentId } } },
      },
      { eventId: "evt_ops_hand" },
    );
    expect(processed.statusCode).toBe(200);
    expect((await orderRow(order.id)).paymentStatus).toBe("REFUNDED");
    expect((await paymentRow(order.id)).refundId).toBe("rfnd_OPS_HAND");
  });
});
