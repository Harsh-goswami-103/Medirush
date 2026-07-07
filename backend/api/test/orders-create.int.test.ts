import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * POST /v1/orders — checkout validation order (§9.2), stock reservation (§9.4),
 * COD gates + velocity (§10.3), idempotency header (§7.1). Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

function postOrder(
  headers: Record<string, string>,
  body: { addressId: string; paymentMethod: string; couponCode?: string },
  key: string = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: key },
    payload: body,
  });
}

async function setCartItem(userId: string, productId: string, qty: number): Promise<void> {
  const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    create: { cartId: cart.id, productId, qty },
    update: { qty },
  });
}

async function seedCustomer(addressOverrides: { lat?: number; lng?: number } = {}) {
  const customer = await user("CUSTOMER");
  const addr = await address(customer.id, addressOverrides);
  return { customer, headers: authHeaders(customer), addressId: addr.id };
}

/** Minimal FLAT coupon with an open window; override limits/minOrder per test. */
async function makeCoupon(
  code: string,
  overrides: { minOrderPaise?: number; perUserLimit?: number; usageLimit?: number | null } = {},
) {
  return prisma.coupon.create({
    data: {
      code,
      kind: "FLAT",
      valuePaiseOrPct: 1000,
      minOrderPaise: overrides.minOrderPaise ?? 0,
      maxDiscountPaise: null,
      usageLimit: overrides.usageLimit ?? null,
      perUserLimit: overrides.perUserLimit ?? 1,
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      isActive: true,
    },
  });
}

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

describe("POST /v1/orders (COD checkout)", () => {
  it("happy path → PLACED with one event, stock decremented, cart cleared", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 25, pricePaise: 5000 });
    await setCartItem(customer.id, p.id, 3);

    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode, res.body).toBe(201);

    const order = res.json().data.order;
    expect(order.status).toBe("PLACED");
    expect(order.paymentMethod).toBe("COD");
    expect(order.paymentStatus).toBe("COD_DUE");
    expect(order.itemsPaise).toBe(15000);
    expect(order.deliveryPaise).toBe(2000);
    expect(order.discountPaise).toBe(0);
    expect(order.totalPaise).toBe(17000);
    expect(order.orderNo).toMatch(/^MR-\d{6}-\d{4}$/);
    expect(order.placedAt).not.toBeNull();
    expect(order.deliveryOtp).toBeNull();
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ productId: p.id, qty: 3, pricePaise: 5000 });

    // Stock decremented + SALE adjustment.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(22);
    const sale = await prisma.stockAdjustment.findMany({ where: { refOrderId: order.id } });
    expect(sale).toHaveLength(1);
    expect(sale[0]?.reason).toBe("SALE");
    expect(sale[0]?.delta).toBe(-3);

    // Exactly one OrderEvent: null → PLACED, by the customer.
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.from).toBeNull();
    expect(events[0]?.to).toBe("PLACED");
    expect(events[0]?.actorType).toBe("CUSTOMER");

    // Cart cleared; a single order row exists.
    expect(await prisma.cartItem.count({ where: { cart: { userId: customer.id } } })).toBe(0);
    expect(await prisma.order.count()).toBe(1);
  });

  it("cart with an Rx item → RX_REVIEW / rxStatus PENDING", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 12000, requiresRx: true });
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode, res.body).toBe(201);

    const order = res.json().data.order;
    expect(order.status).toBe("RX_REVIEW");
    expect(order.requiresRx).toBe(true);
    expect(order.rxStatus).toBe("PENDING");

    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.from).toBeNull();
    expect(events[0]?.to).toBe("RX_REVIEW");
  });

  it("PREPAID → PENDING_PAYMENT with a razorpay handoff and reserved stock (Phase 2)", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, { addressId, paymentMethod: "PREPAID" });
    expect(res.statusCode, res.body).toBe(201);

    const { order, razorpay } = res.json().data;
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(order.paymentStatus).toBe("PENDING");
    expect(razorpay.rzpOrderId).toMatch(/^order_/);
    expect(razorpay.amountPaise).toBe(order.totalPaise);

    // Stock reserved at create for PREPAID too (§9.4); a Payment row is written.
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(9);
    expect(await prisma.payment.count()).toBe(1);
  });

  it("below the store minimum → 422 MIN_ORDER_NOT_MET without touching stock", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 5000 }); // 5000 < minOrder 9900
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("MIN_ORDER_NOT_MET");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(10);
  });

  it("address outside the service radius → 422 OUT_OF_SERVICE_AREA", async () => {
    // ~14km due north of the store → outside the 5km radius.
    const { customer, headers, addressId } = await seedCustomer({ lat: 13.1, lng: 77.5946 });
    const p = await product({ stock: 10, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("OUT_OF_SERVICE_AREA");
  });

  it("first COD order above the new-account cap → 422 COD_LIMIT_EXCEEDED", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    // items 60000 ≥ freeDeliveryAbove 49900 → delivery 0 → total 60000 > cap 50000.
    const p = await product({ stock: 10, pricePaise: 60000, mrpPaise: 65000 });
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("COD_LIMIT_EXCEEDED");
  });

  it("missing Idempotency-Key header → 400 VALIDATION_ERROR", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers, // no Idempotency-Key
      payload: { addressId, paymentMethod: "COD" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.order.count()).toBe(0);
  });

  it("4th order within the hour → 429 RATE_LIMITED", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 20, pricePaise: 12000 });

    for (let i = 0; i < 3; i += 1) {
      await setCartItem(customer.id, p.id, 1);
      const ok = await postOrder(headers, { addressId, paymentMethod: "COD" });
      expect(ok.statusCode, ok.body).toBe(201);
    }

    await setCartItem(customer.id, p.id, 1);
    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(await prisma.order.count()).toBe(3);
  });

  // ── regressions for the Phase 1 review findings ──────────────────────────

  it("a prior CANCELLED order does NOT lift the new-account COD cap (§10.3)", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const cheap = await product({ stock: 10, pricePaise: 12000, mrpPaise: 12000 });
    const pricey = await product({ stock: 10, pricePaise: 60000, mrpPaise: 65000 });

    // Place a within-cap order, then cancel it (PLACED → CANCELLED).
    await setCartItem(customer.id, cheap.id, 1);
    const placed = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(placed.statusCode, placed.body).toBe(201);
    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/orders/${placed.json().data.order.id}/cancel`,
      headers,
      payload: { reason: "changed my mind" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // The next order above the cap must STILL be rejected — the cancelled order
    // is not a "real" first order, so the new-account cap still applies.
    await setCartItem(customer.id, pricey.id, 1);
    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("COD_LIMIT_EXCEEDED");
  });

  it("below-minimum cart with a coupon → MIN_ORDER_NOT_MET before COUPON_INVALID (§9.2 order)", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    // itemsPaise 5000 is below BOTH the store min (9900) and the coupon min (8000).
    const p = await product({ stock: 10, pricePaise: 5000, mrpPaise: 5000 });
    await makeCoupon("SAVE50", { minOrderPaise: 8000 });
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, { addressId, paymentMethod: "COD", couponCode: "SAVE50" });
    expect(res.statusCode).toBe(422);
    // Store min-order is checked first → the customer learns the actionable reason.
    expect(res.json().error.code).toBe("MIN_ORDER_NOT_MET");
  });

  it("two users racing a usageLimit=1 coupon → exactly one redemption (TOCTOU fix)", async () => {
    // Two DISTINCT customers (own carts, so cart-clearing can't mask the race)
    // both redeem a globally single-use coupon at the same instant.
    const u1 = await seedCustomer();
    const u2 = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 12000, mrpPaise: 12000 });
    await makeCoupon("GLOBAL1", { usageLimit: 1 });
    await setCartItem(u1.customer.id, p.id, 1);
    await setCartItem(u2.customer.id, p.id, 1);

    const [a, b] = await Promise.all([
      postOrder(u1.headers, { addressId: u1.addressId, paymentMethod: "COD", couponCode: "GLOBAL1" }),
      postOrder(u2.headers, { addressId: u2.addressId, paymentMethod: "COD", couponCode: "GLOBAL1" }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([201, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json().error.code).toBe("COUPON_INVALID");
    // The coupon was redeemed exactly once despite the concurrent submit.
    expect(await prisma.couponRedemption.count()).toBe(1);
  });
});
