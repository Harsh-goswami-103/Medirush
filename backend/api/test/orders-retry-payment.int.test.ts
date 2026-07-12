import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, PAYMENT_TIMEOUT_MIN } from "@medrush/contracts";

/**
 * GET /v1/orders/:id/payment — re-serve the Razorpay checkout handoff for a
 * stranded PREPAID order (customer dismissed the sheet; cart already consumed).
 * Owner-scoped 404 (IDOR), 409 for COD / no-longer-awaiting-payment, and the
 * SAME rzpOrderId minted at create so the client reopens the existing order.
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

async function seedCustomer() {
  const customer = await user("CUSTOMER");
  const addr = await address(customer.id);
  return { customer, headers: authHeaders(customer), addressId: addr.id };
}

async function checkout(
  customerId: string,
  headers: Record<string, string>,
  addressId: string,
  paymentMethod: "COD" | "PREPAID",
) {
  const p = await product({ stock: 10, pricePaise: 12000 });
  const cart = await prisma.cart.upsert({
    where: { userId: customerId },
    create: { userId: customerId },
    update: {},
  });
  await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: 1 } });
  const res = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
    payload: { addressId, paymentMethod },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data;
}

function getPayment(orderId: string, headers: Record<string, string>) {
  return app.inject({ method: "GET", url: `/v1/orders/${orderId}/payment`, headers });
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

describe("GET /v1/orders/:id/payment", () => {
  it("owner + PENDING_PAYMENT → the same handoff shape as create, with the deadline", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const created = await checkout(customer.id, headers, addressId, "PREPAID");
    expect(created.order.status).toBe("PENDING_PAYMENT");

    const res = await getPayment(created.order.id, headers);
    expect(res.statusCode, res.body).toBe(200);
    const { razorpay, expiresAt } = res.json().data;

    // Exactly the handoff minted at create — the EXISTING rzpOrderId, not a new one.
    expect(razorpay).toEqual(created.razorpay);
    const paymentRow = await prisma.payment.findUniqueOrThrow({
      where: { orderId: created.order.id },
    });
    expect(razorpay.rzpOrderId).toBe(paymentRow.rzpOrderId);
    expect(razorpay.amountPaise).toBe(created.order.totalPaise);
    expect(razorpay.currency).toBe("INR");

    // Auto-cancel deadline = createdAt + the §9.3 payment timeout.
    const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: created.order.id } });
    expect(new Date(expiresAt).getTime()).toBe(
      orderRow.createdAt.getTime() + PAYMENT_TIMEOUT_MIN * 60_000,
    );
  });

  it("foreign order → 404 (IDOR convention)", async () => {
    const owner = await seedCustomer();
    const created = await checkout(owner.customer.id, owner.headers, owner.addressId, "PREPAID");

    const stranger = await seedCustomer();
    const res = await getPayment(created.order.id, stranger.headers);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("unknown order id → 404", async () => {
    const { headers } = await seedCustomer();
    const res = await getPayment("nonexistent-order-id", headers);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("COD order → 409 CONFLICT (nothing to retry)", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const created = await checkout(customer.id, headers, addressId, "COD");
    expect(created.order.status).toBe("PLACED");

    const res = await getPayment(created.order.id, headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("already-paid order → 409 CONFLICT", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const created = await checkout(customer.id, headers, addressId, "PREPAID");

    // Simulate the payment.captured webhook promotion.
    await prisma.order.update({
      where: { id: created.order.id },
      data: { status: "PLACED", paymentStatus: "PAID", placedAt: new Date() },
    });

    const res = await getPayment(created.order.id, headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("timed-out CANCELLED order → 409 CONFLICT", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const created = await checkout(customer.id, headers, addressId, "PREPAID");

    await prisma.order.update({
      where: { id: created.order.id },
      data: { status: "CANCELLED", paymentStatus: "FAILED", cancelledAt: new Date() },
    });

    const res = await getPayment(created.order.id, headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});
