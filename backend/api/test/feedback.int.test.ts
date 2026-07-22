import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Post-delivery feedback (Batch 3): order ratings and return requests. Real
 * Postgres — ownership, the DELIVERED gate, rating upsert idempotency, the
 * driver-rating guard and the one-open-return rule.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c1_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { flushOpsAlertWrites } = await import("../src/core/realtime");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { feedbackRoutes } = await import("../src/modules/feedback/routes");
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;
let seq = 0;

async function makeOrder(userId: string, status: "DELIVERED" | "READY" = "DELIVERED") {
  seq += 1;
  return prisma.order.create({
    data: {
      orderNo: `MR-FBK-${seq}`,
      userId,
      status,
      paymentMethod: "COD",
      paymentStatus: "COD_DUE",
      addressSnapshot: {
        name: "Cust",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: STORE_LAT,
        lng: STORE_LNG,
      } as Prisma.InputJsonValue,
      distanceM: 1500,
      itemsPaise: 10_000,
      deliveryPaise: 2_000,
      discountPaise: 0,
      totalPaise: 12_000,
      requiresRx: false,
      rxStatus: "NA",
      placedAt: new Date(),
      ...(status === "DELIVERED" ? { deliveredAt: new Date() } : {}),
    },
  });
}

/** Attach an accepted Delivery (with its driver) so driverStars is allowed. */
async function attachDriver(orderId: string) {
  const driverUser = await user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: { userId: driverUser.id, isVerified: true, vehicleType: "BIKE" },
  });
  return prisma.delivery.create({
    data: { orderId, driverId: profile.id, distanceM: 1500, deliveredAt: new Date() },
  });
}

async function customerWithOrder(status: "DELIVERED" | "READY" = "DELIVERED") {
  const customer = await user("CUSTOMER");
  const order = await makeOrder(customer.id, status);
  return { customer, order, headers: authHeaders(customer) };
}

type Payload = Record<string, unknown>;

async function postRating(headers: Record<string, string>, orderId: string, payload: Payload) {
  return app.inject({ method: "POST", url: `/v1/orders/${orderId}/rating`, headers, payload });
}

async function getRating(headers: Record<string, string>, orderId: string) {
  return app.inject({ method: "GET", url: `/v1/orders/${orderId}/rating`, headers });
}

async function postReturn(headers: Record<string, string>, orderId: string, payload: Payload) {
  return app.inject({ method: "POST", url: `/v1/orders/${orderId}/returns`, headers, payload });
}

beforeAll(async () => {
  app = await buildApp();
  // v1.ts is owned by the integrator; mount the plugin here only while it is
  // not yet registered there, so this file boots either way.
  const v1Source = readFileSync(new URL("../src/modules/v1.ts", import.meta.url), "utf8");
  if (!v1Source.includes("feedbackRoutes")) {
    await app.register(feedbackRoutes, { prefix: "/v1" });
  }
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  clearAuthCaches();
});

describe("POST /v1/orders/:id/rating", () => {
  it("creates on first submit (201) and updates on re-submit (200) — one row", async () => {
    const { order, headers } = await customerWithOrder();

    const created = await postRating(headers, order.id, { orderStars: 4, comment: "Quick" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({
      orderId: order.id,
      orderStars: 4,
      driverStars: null,
      comment: "Quick",
    });
    expect(created.headers["cache-control"]).toBe("no-store");

    const updated = await postRating(headers, order.id, { orderStars: 2 });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.id).toBe(created.json().data.id);
    expect(updated.json().data.orderStars).toBe(2);
    // Whole-form replace: an omitted comment clears the stored value.
    expect(updated.json().data.comment).toBeNull();

    expect(await prisma.rating.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("accepts driverStars when the order had a driver", async () => {
    const { order, headers } = await customerWithOrder();
    await attachDriver(order.id);

    const res = await postRating(headers, order.id, { orderStars: 5, driverStars: 5 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.driverStars).toBe(5);
  });

  it("rejects driverStars when the order never had a driver → 422", async () => {
    const { order, headers } = await customerWithOrder();

    const res = await postRating(headers, order.id, { orderStars: 5, driverStars: 4 });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.rating.count()).toBe(0);
  });

  it("rejects a not-yet-delivered order → 422", async () => {
    const { order, headers } = await customerWithOrder("READY");

    const res = await postRating(headers, order.id, { orderStars: 5 });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.message).toBe("You can rate an order once it is delivered");
  });

  it("another customer's order is 404, and cannot be rated", async () => {
    const { order } = await customerWithOrder();
    const intruder = await user("CUSTOMER");

    const res = await postRating(authHeaders(intruder), order.id, { orderStars: 1 });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(await prisma.rating.count()).toBe(0);
  });

  it("unknown order → 404; bad stars → 400; no token → 401", async () => {
    const { headers } = await customerWithOrder();

    const missing = await postRating(headers, "nosuchorderid", { orderStars: 3 });
    expect(missing.statusCode, missing.body).toBe(404);

    const { order } = await customerWithOrder();
    const badStars = await postRating(headers, order.id, { orderStars: 9 });
    expect(badStars.statusCode, badStars.body).toBe(400);

    const noBody = await postRating(headers, order.id, {});
    expect(noBody.statusCode, noBody.body).toBe(400);

    const anon = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/rating`,
      payload: { orderStars: 3 },
    });
    expect(anon.statusCode, anon.body).toBe(401);
  });
});

describe("GET /v1/orders/:id/rating", () => {
  it("returns null before rating, the rating after, and 404 for a foreign order", async () => {
    const { order, headers } = await customerWithOrder();

    const before = await getRating(headers, order.id);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().data).toBeNull();

    await postRating(headers, order.id, { orderStars: 3, comment: "Fine" });

    const after = await getRating(headers, order.id);
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().data).toMatchObject({ orderStars: 3, comment: "Fine" });

    const intruder = await user("CUSTOMER");
    const foreign = await getRating(authHeaders(intruder), order.id);
    expect(foreign.statusCode, foreign.body).toBe(404);
  });
});

describe("POST /v1/orders/:id/returns", () => {
  it("creates a REQUESTED row, an ops alert and a customer notification", async () => {
    const { customer, order, headers } = await customerWithOrder();

    const res = await postReturn(headers, order.id, { reason: "DAMAGED", note: "Box crushed" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({
      orderId: order.id,
      orderNo: order.orderNo,
      reason: "DAMAGED",
      note: "Box crushed",
      status: "REQUESTED",
      resolutionNote: null,
      resolvedAt: null,
    });

    await flushOpsAlertWrites();
    const alert = await prisma.opsAlert.findFirst({ where: { kind: "RETURN_REQUESTED" } });
    expect(alert?.message).toContain(order.orderNo);
    expect(alert?.message).toContain("DAMAGED");
    expect(alert?.refId).toBe(res.json().data.id);

    const note = await prisma.notification.findFirst({ where: { userId: customer.id } });
    expect(note?.type).toBe("RETURN_REQUESTED");
    expect(note?.body).toContain(order.orderNo);
  });

  it("a second request while one is open → 409, and no extra row", async () => {
    const { order, headers } = await customerWithOrder();

    const first = await postReturn(headers, order.id, { reason: "MISSING" });
    expect(first.statusCode, first.body).toBe(201);

    const second = await postReturn(headers, order.id, { reason: "EXPIRED" });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe("CONFLICT");
    expect(await prisma.returnRequest.count({ where: { orderId: order.id } })).toBe(1);

    // Once the pharmacist resolves it, the customer may report again.
    await prisma.returnRequest.update({
      where: { id: first.json().data.id },
      data: { status: "REJECTED", resolutionNote: "Not eligible", resolvedAt: new Date() },
    });
    const third = await postReturn(headers, order.id, { reason: "OTHER", note: "Still wrong" });
    expect(third.statusCode, third.body).toBe(201);
    expect(await prisma.returnRequest.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("gates on DELIVERED, ownership and reason validity", async () => {
    const notDelivered = await customerWithOrder("READY");
    const early = await postReturn(notDelivered.headers, notDelivered.order.id, {
      reason: "DAMAGED",
    });
    expect(early.statusCode, early.body).toBe(422);
    expect(early.json().error.code).toBe("VALIDATION_ERROR");

    const owned = await customerWithOrder();
    const intruder = await user("CUSTOMER");
    const foreign = await postReturn(authHeaders(intruder), owned.order.id, { reason: "DAMAGED" });
    expect(foreign.statusCode, foreign.body).toBe(404);

    const badReason = await postReturn(owned.headers, owned.order.id, { reason: "BECAUSE" });
    expect(badReason.statusCode, badReason.body).toBe(400);

    expect(await prisma.returnRequest.count()).toBe(0);
  });
});

describe("GET /v1/returns", () => {
  it("lists only the caller's requests, newest first, cursor-paginated", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);
    const other = await user("CUSTOMER");

    const orders = [
      await makeOrder(customer.id),
      await makeOrder(customer.id),
      await makeOrder(customer.id),
    ];
    for (const order of orders) {
      const created = await postReturn(headers, order.id, { reason: "DAMAGED" });
      expect(created.statusCode, created.body).toBe(201);
    }
    const otherOrder = await makeOrder(other.id);
    const otherCreated = await postReturn(authHeaders(other), otherOrder.id, { reason: "MISSING" });
    expect(otherCreated.statusCode, otherCreated.body).toBe(201);

    const page1 = await app.inject({ method: "GET", url: "/v1/returns?limit=2", headers });
    expect(page1.statusCode, page1.body).toBe(200);
    const ids1 = page1.json().data.map((r: { orderId: string }) => r.orderId);
    expect(ids1).toEqual([orders[2]?.id, orders[1]?.id]);
    expect(page1.json().data[0].orderNo).toBe(orders[2]?.orderNo);
    expect(page1.json().meta.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/returns?limit=2&cursor=${page1.json().meta.nextCursor}`,
      headers,
    });
    expect(page2.statusCode, page2.body).toBe(200);
    expect(page2.json().data.map((r: { orderId: string }) => r.orderId)).toEqual([orders[0]?.id]);
    expect(page2.json().meta.nextCursor).toBeNull();

    // The other customer's row never appears on this caller's list.
    const all = await app.inject({ method: "GET", url: "/v1/returns", headers });
    expect(all.json().data).toHaveLength(3);
    expect(
      all.json().data.some((r: { orderId: string }) => r.orderId === otherOrder.id),
    ).toBe(false);

    const anon = await app.inject({ method: "GET", url: "/v1/returns" });
    expect(anon.statusCode, anon.body).toBe(401);
  });
});
