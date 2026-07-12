import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COD_REFUSAL_DISABLE_THRESHOLD, IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";
import type { Prisma } from "@prisma/client";

/**
 * Doorstep COD refusal (§10.3): POST /v1/ops/orders/:id/cancel with the
 * EXPLICIT `codRefused: true` marker increments the customer's
 * `codRefusalCount` inside the cancel TX + audits it — never inferred from a
 * plain COD cancel — and only for a COD order out for delivery
 * (ASSIGNED/PICKED_UP). At the threshold, COD checkout auto-disables.
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
let seq = 0;

/** Bare order row in an arbitrary status (no items — restock is a no-op). */
async function makeOrder(
  userId: string,
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.order.create({
    data: {
      orderNo: `MR-TEST-${Date.now()}-${seq}`,
      userId,
      status: "ASSIGNED",
      paymentMethod: "COD",
      paymentStatus: "COD_DUE",
      addressSnapshot: {
        name: "Test Customer",
        phone: "+919876543210",
        line1: "12 MG Road",
        pincode: "560001",
        lat: 12.9716,
        lng: 77.5946,
      },
      distanceM: 1200,
      itemsPaise: 12000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 14000,
      placedAt: new Date(),
      ...overrides,
    },
  });
}

function opsCancel(
  orderId: string,
  headers: Record<string, string>,
  payload: { reason: string; codRefused?: boolean },
) {
  return app.inject({
    method: "POST",
    url: `/v1/ops/orders/${orderId}/cancel`,
    headers,
    payload,
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

describe("POST /v1/ops/orders/:id/cancel — codRefused marker", () => {
  it("COD + ASSIGNED with codRefused → cancelled, counter incremented, audited", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id, { status: "ASSIGNED" });

    const res = await opsCancel(order.id, authHeaders(ops), {
      reason: "customer refused COD at the door",
      codRefused: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe("CANCELLED");

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(fresh.codRefusalCount).toBe(1);

    const audit = await prisma.auditLog.findMany({ where: { action: "COD_REFUSED" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(ops.id);
    expect(audit[0]?.entityId).toBe(order.id);
    expect(audit[0]?.meta).toMatchObject({ userId: customer.id, codRefusalCount: 1 });
  });

  it("COD + PICKED_UP with codRefused → counter incremented", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id, { status: "PICKED_UP" });

    const res = await opsCancel(order.id, authHeaders(ops), {
      reason: "refused at the door",
      codRefused: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(fresh.codRefusalCount).toBe(1);
  });

  it("plain COD cancel WITHOUT codRefused → counter untouched, no audit", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id, { status: "ASSIGNED" });

    const res = await opsCancel(order.id, authHeaders(ops), { reason: "wrong item packed" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe("CANCELLED");

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(fresh.codRefusalCount).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "COD_REFUSED" } })).toBe(0);
  });

  it("codRefused on a COD order NOT out for delivery → 422, nothing mutated", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id, { status: "PLACED" });

    const res = await opsCancel(order.id, authHeaders(ops), {
      reason: "refused (allegedly)",
      codRefused: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // The whole cancel TX rolled back: order untouched, counter untouched.
    const freshOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(freshOrder.status).toBe("PLACED");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(fresh.codRefusalCount).toBe(0);
  });

  it("codRefused on a PREPAID order → 422", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id, {
      status: "ASSIGNED",
      paymentMethod: "PREPAID",
      paymentStatus: "PAID",
    });

    const res = await opsCancel(order.id, authHeaders(ops), {
      reason: "refused",
      codRefused: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(fresh.codRefusalCount).toBe(0);
  });

  it("reaching the refusal threshold disables COD at checkout (§10.3 end-to-end)", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const addr = await address(customer.id);

    for (let i = 0; i < COD_REFUSAL_DISABLE_THRESHOLD; i += 1) {
      const order = await makeOrder(customer.id, { status: "ASSIGNED" });
      const res = await opsCancel(order.id, authHeaders(ops), {
        reason: "refused COD at the door",
        codRefused: true,
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(fresh.codRefusalCount).toBe(COD_REFUSAL_DISABLE_THRESHOLD);

    // The previously half-dead rule now bites: the next COD checkout is refused.
    const p = await product({ stock: 5, pricePaise: 12000 });
    const cart = await prisma.cart.create({ data: { userId: customer.id } });
    await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: 1 } });
    const checkout = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { ...authHeaders(customer), [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
      payload: { addressId: addr.id, paymentMethod: "COD" },
    });
    expect(checkout.statusCode).toBe(422);
    expect(checkout.json().error.code).toBe("COD_DISABLED");
  });
});
