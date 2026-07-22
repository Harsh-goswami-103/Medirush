import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Notification consent + DPDP self-service erasure (Batch 3). Real Postgres.
 * GET/PATCH /v1/me/notification-prefs (lazy all-true defaults, partial update,
 * per-user isolation), the push suppression `notifyUser` applies while still
 * persisting the in-app row, and DELETE /v1/me (live-order 409, anonymisation
 * that keeps the statutory records, audit row, dead session, repeat no-op).
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c4_test";
delete process.env.FIREBASE_PROJECT_ID;

/** Captured push enqueues — the only observable difference consent makes. */
const { pushed } = vi.hoisted(() => ({ pushed: [] as Array<{ userId: string; title: string }> }));

vi.mock("../src/jobs/notificationFanout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/jobs/notificationFanout")>();
  return {
    ...actual,
    enqueuePush: async (payload: { userId: string; title: string }) => {
      pushed.push(payload);
    },
  };
});

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { flushOpsAlertWrites } = await import("../src/core/realtime");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { preferenceRoutes } = await import("../src/modules/preferences/routes");
const { deleteOwnAccount } = await import("../src/modules/preferences/service");
const { notifyUser } = await import("../src/modules/notifications/service");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;
let seq = 0;

const PREFS_URL = "/v1/me/notification-prefs";

/** A DELIVERED (or in-flight) order with an issued invoice number. */
async function makeOrder(userId: string, status: "DELIVERED" | "PACKING" = "DELIVERED") {
  seq += 1;
  return prisma.order.create({
    data: {
      orderNo: `MR-PREF-${seq}`,
      userId,
      status,
      paymentMethod: "COD",
      paymentStatus: status === "DELIVERED" ? "COD_COLLECTED" : "COD_DUE",
      addressSnapshot: {
        name: "Real Name",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
      } as Prisma.InputJsonValue,
      distanceM: 1_500,
      itemsPaise: 10_000,
      deliveryPaise: 2_000,
      totalPaise: 12_000,
      ...(status === "DELIVERED"
        ? { deliveredAt: new Date(), invoiceNo: `MR/25-26/${100 + seq}` }
        : {}),
    },
  });
}

function getPrefs(headers: Record<string, string>) {
  return app.inject({ method: "GET", url: PREFS_URL, headers });
}

function patchPrefs(headers: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: PREFS_URL, headers, payload });
}

function deleteMe(headers: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: "DELETE", url: "/v1/me", headers, payload });
}

beforeAll(async () => {
  app = await buildApp();
  // v1.ts is owned by the integrator; mount the plugin here only while it is
  // not yet registered there, so this file boots either way.
  const v1Source = readFileSync(new URL("../src/modules/v1.ts", import.meta.url), "utf8");
  if (!v1Source.includes("preferenceRoutes")) {
    await app.register(preferenceRoutes, { prefix: "/v1" });
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
  await storeConfig();
  await appSettings();
  pushed.length = 0;
});

/* ------------------------------------------------------------ read + patch */

describe("GET /v1/me/notification-prefs", () => {
  it("creates the row with all-true defaults on first read, then reuses it", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);

    expect(await prisma.notificationPreference.count()).toBe(0);

    const first = await getPrefs(headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const data = first.json().data;
    expect(data.orderUpdates).toBe(true);
    expect(data.promotions).toBe(true);
    expect(data.refillReminders).toBe(true);
    expect(new Date(data.updatedAt).toISOString()).toBe(data.updatedAt);

    const row = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId: customer.id },
    });
    expect(row.orderUpdates).toBe(true);

    const second = await getPrefs(headers);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.updatedAt).toBe(data.updatedAt);
    expect(await prisma.notificationPreference.count({ where: { userId: customer.id } })).toBe(1);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: PREFS_URL });
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("PATCH /v1/me/notification-prefs", () => {
  it("applies a partial update and leaves the other flags alone", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);
    await getPrefs(headers);

    const res = await patchPrefs(headers, { promotions: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      orderUpdates: true,
      promotions: false,
      refillReminders: true,
    });

    const read = await getPrefs(headers);
    expect(read.json().data.promotions).toBe(false);
    expect(read.json().data.refillReminders).toBe(true);
    expect(await prisma.notificationPreference.count({ where: { userId: customer.id } })).toBe(1);
  });

  it("creates the row when patched before it has ever been read", async () => {
    const customer = await user("CUSTOMER");
    const res = await patchPrefs(authHeaders(customer), {
      promotions: false,
      refillReminders: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      orderUpdates: true,
      promotions: false,
      refillReminders: false,
    });
    const row = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId: customer.id },
    });
    expect(row.promotions).toBe(false);
  });

  it("rejects an empty body and a non-boolean flag", async () => {
    const headers = authHeaders(await user("CUSTOMER"));

    const empty = await patchPrefs(headers, {});
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json().error.code).toBe("VALIDATION_ERROR");

    const wrongType = await patchPrefs(headers, { promotions: "no" });
    expect(wrongType.statusCode, wrongType.body).toBe(400);
    expect(await prisma.notificationPreference.count()).toBe(0);
  });

  it("never touches another user's row", async () => {
    const alice = await user("CUSTOMER");
    const bob = await user("CUSTOMER");
    await getPrefs(authHeaders(bob));

    const res = await patchPrefs(authHeaders(alice), { promotions: false });
    expect(res.statusCode, res.body).toBe(200);

    const bobRow = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId: bob.id },
    });
    expect(bobRow.promotions).toBe(true);
    expect(await prisma.notificationPreference.count()).toBe(2);
  });
});

/* ------------------------------------------------------- consent → push gate */

describe("notifyUser consent gate", () => {
  it("suppresses the push for an opted-out category but still persists the row", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);
    await patchPrefs(headers, { promotions: false });

    await notifyUser({
      userId: customer.id,
      type: "PROMO",
      title: "20% off vitamins",
      body: "This weekend only",
      category: "promo",
    });

    expect(pushed).toEqual([]);
    const rows = await prisma.notification.findMany({ where: { userId: customer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("20% off vitamins");

    // The in-app history stays complete and readable.
    const list = await app.inject({ method: "GET", url: "/v1/notifications", headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(1);
  });

  it("still pushes transactional order updates to a marketing opt-out", async () => {
    const customer = await user("CUSTOMER");
    await patchPrefs(authHeaders(customer), { promotions: false });

    await notifyUser({
      userId: customer.id,
      type: "ORDER_STATUS",
      title: "Out for delivery",
      body: "Arriving soon",
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ userId: customer.id, title: "Out for delivery" });
  });

  it("suppresses refill nudges when refillReminders is false", async () => {
    const customer = await user("CUSTOMER");
    await patchPrefs(authHeaders(customer), { refillReminders: false });

    await notifyUser({
      userId: customer.id,
      type: "REFILL_DUE",
      title: "Time to reorder",
      body: "Your medicine runs out soon",
      category: "refill",
    });

    expect(pushed).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(1);
  });

  it("treats a missing preference row as fully opted in", async () => {
    const customer = await user("CUSTOMER");

    await notifyUser({
      userId: customer.id,
      type: "PROMO",
      title: "Welcome offer",
      body: "₹50 off",
      category: "promo",
    });

    expect(pushed).toHaveLength(1);
    expect(await prisma.notificationPreference.count()).toBe(0);
  });
});

/* ------------------------------------------------------------ DELETE /v1/me */

describe("DELETE /v1/me", () => {
  it("refuses while an order is still in flight and changes nothing", async () => {
    const customer = await user("CUSTOMER", { email: "real@example.com" });
    await address(customer.id);
    await makeOrder(customer.id, "PACKING");

    const res = await deleteMe(authHeaders(customer), { confirm: "DELETE" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(dbUser.phone).toBe(customer.phone);
    expect(dbUser.email).toBe("real@example.com");
    expect(dbUser.isBlocked).toBe(false);
    expect(await prisma.address.count({ where: { userId: customer.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: customer.id } })).toBe(0);
  });

  it("anonymises the account, keeps statutory records, audits, and kills the session", async () => {
    const customer = await user("CUSTOMER", { email: "real@example.com" });
    const headers = authHeaders(customer);
    const bystander = await user("CUSTOMER");
    await getPrefs(authHeaders(bystander));
    await address(bystander.id);

    // Personal satellites — all must be gone afterwards.
    await address(customer.id);
    await prisma.deviceToken.create({
      data: { userId: customer.id, token: `fcm-${customer.id}`, platform: "web" },
    });
    const item = await product();
    await prisma.cart.create({
      data: { userId: customer.id, items: { create: [{ productId: item.id, qty: 2 }] } },
    });
    await prisma.notification.create({
      data: { userId: customer.id, type: "PROMO", title: "Offer", body: "10% off" },
    });
    await prisma.stockAlert.create({ data: { userId: customer.id, productId: item.id } });
    await prisma.wishlist.create({ data: { userId: customer.id, productId: item.id } });
    await prisma.refillReminder.create({
      data: {
        userId: customer.id,
        productId: item.id,
        intervalDays: 30,
        nextDueAt: new Date(Date.now() + 86_400_000),
      },
    });
    await patchPrefs(headers, { promotions: false });
    const patient = await prisma.patient.create({
      data: { userId: customer.id, name: "Aarti Sharma", relation: "PARENT" },
    });

    // Statutory records — all must survive.
    const order = await makeOrder(customer.id, "DELIVERED");
    await prisma.order.update({ where: { id: order.id }, data: { patientId: patient.id } });
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: item.id,
        nameSnap: "Paracetamol 650",
        packSizeSnap: "Strip of 10",
        pricePaise: 10_000,
        mrpPaise: 12_000,
        gstRatePct: 12,
        requiresRx: false,
        qty: 1,
      },
    });
    await prisma.prescription.create({
      data: {
        userId: customer.id,
        orderId: order.id,
        patientId: patient.id,
        fileKey: "rx/keep-me.jpg",
        mimeType: "image/jpeg",
        patientName: "Aarti Sharma",
      },
    });
    await prisma.rating.create({
      data: { orderId: order.id, userId: customer.id, orderStars: 5, comment: "Ravi was great" },
    });

    const res = await deleteMe(headers, { confirm: "DELETE", reason: "Moving cities" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
    expect(res.headers["cache-control"]).toBe("no-store");

    // PII scrubbed, unique columns tombstoned, account blocked.
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(dbUser.phone).toBe(`anon:${customer.id}`);
    expect(dbUser.firebaseUid).toBe(`anon:${customer.id}`);
    expect(dbUser.name).toBe("Deleted user");
    expect(dbUser.email).toBeNull();
    expect(dbUser.isBlocked).toBe(true);

    // Satellites purged (device tokens revoked with them).
    expect(await prisma.address.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.deviceToken.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.cart.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.cartItem.count()).toBe(0);
    expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.stockAlert.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.wishlist.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.refillReminder.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.notificationPreference.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.patient.count({ where: { userId: customer.id } })).toBe(0);

    // Statutory records intact — order, invoice number, item, Rx (+H1 name).
    const dbOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, prescriptions: true },
    });
    expect(dbOrder.invoiceNo).toBe(order.invoiceNo);
    expect(dbOrder.totalPaise).toBe(12_000);
    expect(dbOrder.items).toHaveLength(1);
    expect(dbOrder.prescriptions[0]?.fileKey).toBe("rx/keep-me.jpg");
    expect(dbOrder.prescriptions[0]?.patientName).toBe("Aarti Sharma");
    expect((dbOrder.addressSnapshot as { name: string }).name).toBe("Real Name");

    // Rating survives for aggregates; its free-text comment does not.
    const rating = await prisma.rating.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(rating.orderStars).toBe(5);
    expect(rating.comment).toBeNull();

    // Audit trail: self-service action, actor = the subject, no pre-scrub PII.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_SELF_DELETED", entityId: customer.id },
    });
    expect(audit.actorId).toBe(customer.id);
    expect(audit.meta).toMatchObject({ source: "SELF_SERVICE", reason: "Moving cities" });
    expect(JSON.stringify(audit.meta)).not.toContain(customer.phone);

    // Session is dead: the token's uid no longer resolves.
    const after = await getPrefs(headers);
    expect(after.statusCode, after.body).toBe(401);

    // A bystander is entirely untouched.
    expect(await prisma.address.count({ where: { userId: bystander.id } })).toBe(1);
    const bystanderRow = await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(bystanderRow.phone).toBe(bystander.phone);
    expect(await prisma.notificationPreference.count({ where: { userId: bystander.id } })).toBe(1);

    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where: { refId: customer.id } })).toBe(1);
  });

  it("is a no-op on repeat: the token is dead and a direct retry writes no second audit row", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);

    const first = await deleteMe(headers, { confirm: "DELETE" });
    expect(first.statusCode, first.body).toBe(200);

    const second = await deleteMe(headers, { confirm: "DELETE" });
    expect(second.statusCode, second.body).toBe(401);

    await expect(deleteOwnAccount(customer.id, { confirm: "DELETE" })).resolves.toBeUndefined();
    expect(
      await prisma.auditLog.count({ where: { action: "USER_SELF_DELETED", entityId: customer.id } }),
    ).toBe(1);
  });

  it("rejects a wrong or missing confirmation phrase", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);

    const wrong = await deleteMe(headers, { confirm: "delete" });
    expect(wrong.statusCode, wrong.body).toBe(400);
    expect(wrong.json().error.code).toBe("VALIDATION_ERROR");

    const missing = await deleteMe(headers, {});
    expect(missing.statusCode, missing.body).toBe(400);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(dbUser.phone).toBe(customer.phone);
  });

  it("is customer-only and requires authentication", async () => {
    const driver = await user("DRIVER");
    const forbidden = await deleteMe(authHeaders(driver), { confirm: "DELETE" });
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");

    const anonymous = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      payload: { confirm: "DELETE" },
    });
    expect(anonymous.statusCode, anonymous.body).toBe(401);

    const dbDriver = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });
    expect(dbDriver.phone).toBe(driver.phone);
  });
});
