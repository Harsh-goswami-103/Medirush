import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * DPDP erasure integration tests (Phase 7 hardening). Real Postgres.
 * POST /v1/admin/users/:id/anonymize: happy path scrubs User PII + deletes the
 * non-statutory satellites (addresses/devices/cart/notifications) while KEEPING
 * orders + prescriptions, writes USER_ANONYMIZED, and kills the live session at
 * the auth plugin. Guards: 404 unknown, 409 self / last-admin / in-flight order
 * / DRIVER role / repeat (ALREADY_ANONYMIZED).
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { anonymizeUser } = await import("../src/modules/admin/userService");
const { setupTestDb } = await import("./helpers/db");
const factories = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

/* ------------------------------------------------------------------ helpers */

async function makeAdmin() {
  const admin = await factories.user("ADMIN");
  return { admin, headers: authHeaders(admin) };
}

let orderSeq = 0;

/** Create an order for `userId` in the given status (COD — no Payment row needed). */
function createOrder(userId: string, status: "DELIVERED" | "PACKING") {
  orderSeq += 1;
  return prisma.order.create({
    data: {
      orderNo: `MR-ANON-${Date.now()}-${orderSeq}`,
      userId,
      status,
      paymentMethod: "COD",
      paymentStatus: status === "DELIVERED" ? "COD_COLLECTED" : "COD_DUE",
      addressSnapshot: { name: "Real Name", phone: "+917000000001", line1: "1 Main St" },
      distanceM: 1_000,
      itemsPaise: 10_000,
      deliveryPaise: 0,
      totalPaise: 10_000,
      ...(status === "DELIVERED" ? { deliveredAt: new Date() } : {}),
    },
  });
}

/** Seed the full PII satellite set for a customer: address, device, cart(2 items), 2 notifications. */
async function seedSatellites(userId: string) {
  await factories.address(userId);
  await prisma.deviceToken.create({
    data: { userId, token: `fcm-token-${userId}`, platform: "web" },
  });
  const productA = await factories.product();
  const productB = await factories.product();
  await prisma.cart.create({
    data: {
      userId,
      items: {
        create: [
          { productId: productA.id, qty: 1 },
          { productId: productB.id, qty: 2 },
        ],
      },
    },
  });
  await prisma.notification.createMany({
    data: [
      { userId, title: "Order update", body: "Your order is on its way", type: "ORDER_STATUS" },
      { userId, title: "Offer", body: "10% off", type: "MARKETING" },
    ],
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
  await factories.storeConfig();
  await factories.appSettings();
});

/* --------------------------------------------------------------- happy path */

describe("POST /v1/admin/users/:id/anonymize", () => {
  it("scrubs PII, deletes satellites, keeps statutory records, audits, and kills the session", async () => {
    const { admin, headers } = await makeAdmin();
    const customer = await factories.user("CUSTOMER", { email: "real@example.com" });
    const customerHeaders = authHeaders(customer);
    await seedSatellites(customer.id);

    // A terminal order + order item + prescription — MUST survive erasure.
    const order = await createOrder(customer.id, "DELIVERED");
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: "prod-x",
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
        orderId: order.id,
        fileKey: "rx/keep-me.jpg",
        mimeType: "image/jpeg",
        patientName: "Real Name",
      },
    });

    // Prime the auth cache with the live session (also proves the token worked).
    const before = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: customerHeaders,
    });
    expect(before.statusCode, before.body).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${customer.id}/anonymize`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { user, deleted } = res.json().data;
    expect(user.phone).toBe(`anon:${customer.id}`);
    expect(user.name).toBe("Deleted user");
    expect(user.email).toBeNull();
    expect(user.isBlocked).toBe(true);
    expect(deleted).toEqual({ addresses: 1, deviceTokens: 1, cartItems: 2, notifications: 2 });

    // User row: both unique columns tombstoned (real phone/uid freed to re-register).
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(dbUser.firebaseUid).toBe(`anon:${customer.id}`);
    expect(dbUser.phone).toBe(`anon:${customer.id}`);
    expect(dbUser.name).toBe("Deleted user");
    expect(dbUser.email).toBeNull();
    expect(dbUser.isBlocked).toBe(true);

    // Satellites gone.
    expect(await prisma.address.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.deviceToken.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.cart.count({ where: { userId: customer.id } })).toBe(0);
    expect(await prisma.cartItem.count()).toBe(0);
    expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(0);

    // Statutory records intact — order, item, prescription, addressSnapshot.
    const dbOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, prescriptions: true },
    });
    expect(dbOrder.items).toHaveLength(1);
    expect(dbOrder.prescriptions).toHaveLength(1);
    expect(dbOrder.prescriptions[0]?.fileKey).toBe("rx/keep-me.jpg");
    expect((dbOrder.addressSnapshot as { name: string }).name).toBe("Real Name");

    // Audit row: actor + counts, no pre-scrub PII.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_ANONYMIZED", entityId: customer.id },
    });
    expect(audit.actorId).toBe(admin.id);
    expect((audit.meta as { deleted: Record<string, number> }).deleted).toEqual({
      addresses: 1,
      deviceTokens: 1,
      cartItems: 2,
      notifications: 2,
    });
    expect(JSON.stringify(audit.meta)).not.toContain(customer.phone);

    // The old token dies at the auth plugin: the uid no longer resolves and the
    // cache was busted, so the very next request fails.
    const after = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: customerHeaders,
    });
    expect(after.statusCode, after.body).toBe(401);

    // Admin user list still serializes with the tombstone phone in place.
    const list = await app.inject({ method: "GET", url: "/v1/admin/users", headers });
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json().data as Array<{ id: string; phone: string }>).find(
      (u) => u.id === customer.id,
    );
    expect(row?.phone).toBe(`anon:${customer.id}`);
  });

  /* ------------------------------------------------------------------ guards */

  it("404s on an unknown user id", async () => {
    const { headers } = await makeAdmin();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/users/does-not-exist/anonymize",
      headers,
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses to let an admin anonymize their own account", async () => {
    const { admin, headers } = await makeAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${admin.id}/anonymize`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    // Untouched.
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(dbUser.firebaseUid).toBe(admin.firebaseUid);
  });

  it("refuses to anonymize the last active admin (service-level lockout guard)", async () => {
    // Unreachable over HTTP (the calling admin always counts as another active
    // admin), so exercise the service directly with a foreign ADMIN actor.
    const soleAdmin = await factories.user("ADMIN");
    await expect(
      anonymizeUser(soleAdmin.id, { userId: "some-other-actor", role: "ADMIN" }),
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } });
    expect(dbUser.firebaseUid).toBe(soleAdmin.firebaseUid);
  });

  it("409s while the user has an in-flight order, and nothing is deleted", async () => {
    const { headers } = await makeAdmin();
    const customer = await factories.user("CUSTOMER");
    await factories.address(customer.id);
    await createOrder(customer.id, "PACKING");

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${customer.id}/anonymize`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");

    // Rolled back / never executed: PII and satellites untouched.
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(dbUser.phone).toBe(customer.phone);
    expect(dbUser.isBlocked).toBe(false);
    expect(await prisma.address.count({ where: { userId: customer.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: "USER_ANONYMIZED", entityId: customer.id } }),
    ).toBe(0);
  });

  it("refuses DRIVER accounts (wallet/payout obligations — offboarding is separate)", async () => {
    const { headers } = await makeAdmin();
    const driver = await factories.user("DRIVER");
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${driver.id}/anonymize`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });
    expect(dbUser.phone).toBe(driver.phone);
  });

  it("repeat call is a clean 409 ALREADY_ANONYMIZED no-op", async () => {
    const { headers } = await makeAdmin();
    const customer = await factories.user("CUSTOMER");
    await seedSatellites(customer.id);

    const first = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${customer.id}/anonymize`,
      headers,
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${customer.id}/anonymize`,
      headers,
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe("CONFLICT");
    expect(second.json().error.details).toEqual({ reason: "ALREADY_ANONYMIZED" });

    // Exactly one audit row — the no-op wrote nothing.
    expect(
      await prisma.auditLog.count({ where: { action: "USER_ANONYMIZED", entityId: customer.id } }),
    ).toBe(1);
  });

  it("rejects a non-admin token with 403", async () => {
    const staff = await factories.user("INVENTORY");
    const customer = await factories.user("CUSTOMER");
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${customer.id}/anonymize`,
      headers: authHeaders(staff),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
