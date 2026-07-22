import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_VERSION_HEADER, IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Customer Batch 2 order surface: delivery note + contactless threading
 * (create → customer detail → ops detail → driver active payload) and refund
 * visibility on the order detail. Real Postgres, stub Razorpay.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, address, appSettings, product, storeConfig, user } = await import(
  "./helpers/factories"
);
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

function postOrder(
  headers: Record<string, string>,
  body: {
    addressId: string;
    paymentMethod: string;
    deliveryNote?: string;
    contactless?: boolean;
  },
) {
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
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

async function seedCustomer() {
  const customer = await user("CUSTOMER");
  const addr = await address(customer.id);
  return { customer, headers: authHeaders(customer), addressId: addr.id };
}

/** Create a COD order via the API with a stocked cart; returns the order payload. */
async function placeCodOrder(body: { deliveryNote?: string; contactless?: boolean } = {}) {
  const { customer, headers, addressId } = await seedCustomer();
  const p = await product({ stock: 10, pricePaise: 12000 });
  await setCartItem(customer.id, p.id, 1);
  const res = await postOrder(headers, { addressId, paymentMethod: "COD", ...body });
  expect(res.statusCode, res.body).toBe(201);
  return { customer, headers, order: res.json().data.order };
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

describe("delivery note + contactless", () => {
  it("COD create persists both and echoes them on GET /v1/orders/:id", async () => {
    const { headers, order } = await placeCodOrder({
      deliveryNote: "Blue gate, call on arrival",
      contactless: true,
    });
    expect(order.deliveryNote).toBe("Blue gate, call on arrival");
    expect(order.contactless).toBe(true);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.deliveryNote).toBe("Blue gate, call on arrival");
    expect(row.contactless).toBe(true);

    const res = await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.deliveryNote).toBe("Blue gate, call on arrival");
    expect(res.json().data.contactless).toBe(true);
  });

  it("create without them → deliveryNote null, contactless false", async () => {
    const { headers, order } = await placeCodOrder();
    expect(order.deliveryNote).toBeNull();
    expect(order.contactless).toBe(false);

    const res = await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.deliveryNote).toBeNull();
    expect(res.json().data.contactless).toBe(false);
  });

  it("deliveryNote over 200 chars → 400 VALIDATION_ERROR, no order created", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);

    const res = await postOrder(headers, {
      addressId,
      paymentMethod: "COD",
      deliveryNote: "x".repeat(201),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.order.count()).toBe(0);
  });

  it("ops order detail exposes the note + contactless", async () => {
    const { order } = await placeCodOrder({ deliveryNote: "Ring twice", contactless: true });
    const ops = await user("INVENTORY");

    const res = await app.inject({
      method: "GET",
      url: `/v1/ops/orders/${order.id}`,
      headers: authHeaders(ops),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.deliveryNote).toBe("Ring twice");
    expect(res.json().data.contactless).toBe(true);
  });

  it("driver active-delivery payload carries the note + contactless", async () => {
    const { order } = await placeCodOrder({ deliveryNote: "Leave at the door", contactless: true });

    // Promote to an assigned delivery without walking the whole ops pipeline.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "ASSIGNED", readyAt: new Date(), deliveryOtp: "1234" },
    });
    const driverUser = await user("DRIVER");
    const profile = await prisma.driverProfile.create({
      data: {
        userId: driverUser.id,
        isVerified: true,
        isOnline: true,
        lastLat: STORE_LAT,
        lastLng: STORE_LNG,
      },
    });
    await prisma.delivery.create({
      data: { orderId: order.id, driverId: profile.id, distanceM: order.distanceM },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/driver/active",
      headers: { ...authHeaders(driverUser), [APP_VERSION_HEADER]: "1.0.0" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.orderId).toBe(order.id);
    expect(res.json().data.deliveryNote).toBe("Leave at the door");
    expect(res.json().data.contactless).toBe(true);
  });
});

describe("refund visibility on GET /v1/orders/:id", () => {
  /** PREPAID order via the API (creates the Payment row in the create TX). */
  async function placePrepaidOrder() {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 10, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);
    const res = await postOrder(headers, { addressId, paymentMethod: "PREPAID" });
    expect(res.statusCode, res.body).toBe(201);
    return { headers, order: res.json().data.order };
  }

  it("REFUND_INITIATED → refund block with refundId + amountPaise", async () => {
    const { headers, order } = await placePrepaidOrder();
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: "REFUND_INITIATED" },
    });
    await prisma.payment.update({
      where: { orderId: order.id },
      data: { refundId: "rfnd_test_123" },
    });

    const res = await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    const refund = res.json().data.refund;
    expect(refund).not.toBeNull();
    expect(refund.refundId).toBe("rfnd_test_123");
    expect(refund.amountPaise).toBe(order.totalPaise);
    expect(typeof refund.updatedAt).toBe("string");
  });

  it("PAID order → refund null", async () => {
    const { headers, order } = await placePrepaidOrder();
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "PLACED", paymentStatus: "PAID", placedAt: new Date() },
    });

    const res = await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.refund).toBeNull();
  });
});
