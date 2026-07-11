import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * PREPAID payments (BLUEPRINT §9.3, §10.1; phase-2 brief §1-§3). Real Postgres,
 * Razorpay + R2 in STUB mode (no keys). Covers: prepaid create → PENDING_PAYMENT
 * + razorpay handoff + Payment row + reserved stock; a locally-signed webhook
 * capture/failed; webhook replay idempotency; bad-signature rejection; and the
 * payment-timeout auto-cancel handler.
 */

// Env before app import → config parses eagerly. No keys ⇒ deterministic stubs.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET; // → "dev-webhook-secret"
delete process.env.R2_ACCOUNT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { signWebhookBody } = await import("../src/core/razorpay");
const { expireUnpaidOrder } = await import("../src/modules/payments/service");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

async function setCartItem(userId: string, productId: string, qty: number): Promise<void> {
  const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    create: { cartId: cart.id, productId, qty },
    update: { qty },
  });
}

/** Seed a customer with an in-radius address + a cart holding `qty` of `p`. */
async function seedPrepaidCart(opts: { requiresRx?: boolean; stock?: number; price?: number; qty?: number } = {}) {
  const customer = await user("CUSTOMER");
  const addr = await address(customer.id);
  const p = await product({
    stock: opts.stock ?? 50,
    pricePaise: opts.price ?? 20000,
    requiresRx: opts.requiresRx ?? false,
  });
  const qty = opts.qty ?? 2;
  await setCartItem(customer.id, p.id, qty);
  return { customer, headers: authHeaders(customer), addressId: addr.id, product: p, qty };
}

function postPrepaid(headers: Record<string, string>, addressId: string) {
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
    payload: { addressId, paymentMethod: "PREPAID" },
  });
}

function injectWebhook(
  bodyObj: unknown,
  opts: { signature?: string; eventId?: string } = {},
) {
  const raw = JSON.stringify(bodyObj);
  const signature = opts.signature ?? signWebhookBody(raw);
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/razorpay",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      ...(opts.eventId ? { "x-razorpay-event-id": opts.eventId } : {}),
    },
    payload: raw,
  });
}

const capturedEvent = (rzpOrderId: string, rzpPaymentId: string, amount: number) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: rzpPaymentId, order_id: rzpOrderId, amount, status: "captured" } } },
});

const failedEvent = (rzpOrderId: string, rzpPaymentId: string) => ({
  event: "payment.failed",
  payload: { payment: { entity: { id: rzpPaymentId, order_id: rzpOrderId, status: "failed" } } },
});

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
});

describe("POST /v1/orders (PREPAID create)", () => {
  it("creates a PENDING_PAYMENT order with the razorpay handoff, a Payment row, and reserved stock", async () => {
    const { headers, addressId, product: p, qty } = await seedPrepaidCart({ stock: 50, price: 20000, qty: 2 });

    const res = await postPrepaid(headers, addressId);
    expect(res.statusCode, res.body).toBe(201);

    const { order, razorpay } = res.json().data;
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(order.paymentMethod).toBe("PREPAID");
    expect(order.paymentStatus).toBe("PENDING");
    expect(order.placedAt).toBeNull();
    expect(order.totalPaise).toBe(20000 * 2 + 2000); // items + delivery

    // Razorpay checkout handoff present (stub ids in dev/test).
    expect(razorpay).toBeTruthy();
    expect(razorpay.rzpOrderId).toMatch(/^order_/);
    expect(razorpay.rzpKeyId).toBe("rzp_test_stub");
    expect(razorpay.amountPaise).toBe(order.totalPaise);
    expect(razorpay.currency).toBe("INR");

    // Payment row links the razorpay order back to this order.
    const payment = await prisma.payment.findUnique({ where: { orderId: order.id } });
    expect(payment).toBeTruthy();
    expect(payment?.rzpOrderId).toBe(razorpay.rzpOrderId);
    expect(payment?.amountPaise).toBe(order.totalPaise);
    expect(payment?.rzpPaymentId).toBeNull();

    // Stock reserved at create for PREPAID too (§9.4).
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh?.stockQty).toBe(50 - qty);

    // The ops board must NOT yet see the order (invisible until captured).
    expect(order.paymentStatus).not.toBe("PAID");
  });
});

describe("POST /v1/webhooks/razorpay", () => {
  it("payment.captured promotes a non-Rx order to PLACED + PAID and records the payment id", async () => {
    const { headers, addressId } = await seedPrepaidCart({ requiresRx: false });
    const { order, razorpay } = (await postPrepaid(headers, addressId)).json().data;

    const res = await injectWebhook(capturedEvent(razorpay.rzpOrderId, "pay_TEST123", order.totalPaise), {
      eventId: "evt_capture_1",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ received: true, duplicate: false, handled: "payment.captured" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("PLACED");
    expect(updated?.paymentStatus).toBe("PAID");
    expect(updated?.placedAt).not.toBeNull();

    const payment = await prisma.payment.findUnique({ where: { orderId: order.id } });
    expect(payment?.rzpPaymentId).toBe("pay_TEST123");

    // Exactly one capture transition event.
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id, to: "PLACED" } });
    expect(events).toHaveLength(1);
  });

  it("payment.captured on an Rx order lands RX_REVIEW (rxStatus stays PENDING)", async () => {
    const { headers, addressId } = await seedPrepaidCart({ requiresRx: true });
    const { order, razorpay } = (await postPrepaid(headers, addressId)).json().data;
    expect(order.requiresRx).toBe(true);

    await injectWebhook(capturedEvent(razorpay.rzpOrderId, "pay_RX", order.totalPaise), {
      eventId: "evt_capture_rx",
    });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("RX_REVIEW");
    expect(updated?.paymentStatus).toBe("PAID");
    expect(updated?.rxStatus).toBe("PENDING");
  });

  it("replaying the same eventId is idempotent — 200, single processing, no double transition", async () => {
    const { headers, addressId } = await seedPrepaidCart();
    const { order, razorpay } = (await postPrepaid(headers, addressId)).json().data;
    const event = capturedEvent(razorpay.rzpOrderId, "pay_DUP", order.totalPaise);

    const first = await injectWebhook(event, { eventId: "evt_dup" });
    expect(first.json()).toMatchObject({ duplicate: false });

    const second = await injectWebhook(event, { eventId: "evt_dup" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, duplicate: true });

    // Still exactly one PLACED transition and one PaymentEvent row.
    const placed = await prisma.orderEvent.findMany({ where: { orderId: order.id, to: "PLACED" } });
    expect(placed).toHaveLength(1);
    const events = await prisma.paymentEvent.count();
    expect(events).toBe(1);
  });

  it("rejects a bad signature with 401 and changes no state", async () => {
    const { headers, addressId } = await seedPrepaidCart();
    const { order, razorpay } = (await postPrepaid(headers, addressId)).json().data;

    const res = await injectWebhook(capturedEvent(razorpay.rzpOrderId, "pay_BAD", order.totalPaise), {
      signature: "deadbeef",
      eventId: "evt_bad",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");

    const unchanged = await prisma.order.findUnique({ where: { id: order.id } });
    expect(unchanged?.status).toBe("PENDING_PAYMENT");
    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it("payment.failed cancels the order and restores stock", async () => {
    const { headers, addressId, product: p, qty } = await seedPrepaidCart({ stock: 30, qty: 3 });
    const { order, razorpay } = (await postPrepaid(headers, addressId)).json().data;
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.stockQty).toBe(30 - qty);

    const res = await injectWebhook(failedEvent(razorpay.rzpOrderId, "pay_FAIL"), { eventId: "evt_fail" });
    expect(res.statusCode).toBe(200);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.paymentStatus).toBe("FAILED");
    // Stock fully restored.
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.stockQty).toBe(30);
    // The customer is notified of the payment-failure cancellation (§7.2, like every
    // other CANCELLED path incl. the payment-timeout handler).
    expect(
      await prisma.notification.count({ where: { userId: updated!.userId, type: "ORDER_CANCELLED" } }),
    ).toBe(1);
  });
});

describe("payment-timeout handler", () => {
  it("auto-cancels a still-PENDING_PAYMENT order and restocks; is a no-op once captured", async () => {
    const { headers, addressId, product: p } = await seedPrepaidCart({ stock: 40, qty: 4 });
    const { order } = (await postPrepaid(headers, addressId)).json().data;

    // Still unpaid → timeout cancels + restocks.
    await expireUnpaidOrder(order.id);
    const cancelled = await prisma.order.findUnique({ where: { id: order.id } });
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.paymentStatus).toBe("FAILED");
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.stockQty).toBe(40);

    // A second order that gets captured first must be immune to a late timeout.
    const second = await seedPrepaidCart({ stock: 40, qty: 1 });
    const { order: o2, razorpay: r2 } = (await postPrepaid(second.headers, second.addressId)).json().data;
    await injectWebhook(capturedEvent(r2.rzpOrderId, "pay_LATE", o2.totalPaise), { eventId: "evt_late" });
    await expireUnpaidOrder(o2.id); // fires late — must no-op
    const stillPlaced = await prisma.order.findUnique({ where: { id: o2.id } });
    expect(stillPlaced?.status).toBe("PLACED");
    expect(stillPlaced?.paymentStatus).toBe("PAID");
  });
});
