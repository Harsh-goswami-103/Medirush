import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { APP_VERSION_HEADER, OFFER_EXPIRES_SEC } from "@medrush/contracts";

/**
 * Ops dispatch-recovery endpoints (Phase 7): manual assign, re-dispatch and
 * un-assign — the escape hatches for the §9.5 dead-end where both offer waves
 * expired and nothing re-offers automatically. Real Postgres over real HTTP;
 * offers are seeded via the dispatch service directly.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { acceptOffer, dispatchOrder, expireAndEscalate } = await import(
  "../src/modules/dispatch/service"
);
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;
const prisma = getPrisma();
let app: App;
let seq = 0;

async function makeReadyOrder(): Promise<string> {
  seq += 1;
  const customer = await user("CUSTOMER");
  const p = await product({ stock: 50 });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-DOPS-${seq}`,
      userId: customer.id,
      status: "READY",
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
      itemsPaise: 10000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 12000,
      requiresRx: false,
      rxStatus: "NA",
      placedAt: new Date(),
      readyAt: new Date(),
      deliveryOtp: "1234",
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
  return order.id;
}

/** Online, verified driver `km` kilometres east of the store by default. */
async function makeDriver(opts: { online?: boolean; verified?: boolean; km?: number } = {}) {
  const u = await user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: {
      userId: u.id,
      isVerified: opts.verified ?? true,
      isOnline: opts.online ?? true,
      lastLat: STORE_LAT,
      lastLng: STORE_LNG + (opts.km ?? 0) / 100,
    },
  });
  return { user: u, profileId: profile.id };
}

async function opsUser() {
  const inv = await user("INVENTORY");
  return { user: inv, headers: authHeaders(inv) };
}

const offersFor = (orderId: string) =>
  prisma.deliveryOffer.findMany({ where: { orderId }, orderBy: { offeredAt: "asc" } });

/**
 * Age an order's pending offers past the OFFER_EXPIRES_SEC window — an expiry
 * pass only touches offers that have genuinely timed out (the real job fires
 * OFFER_EXPIRES_SEC after the wave created them).
 */
const backdateOffers = (orderId: string) =>
  prisma.deliveryOffer.updateMany({
    where: { orderId, status: "OFFERED" },
    data: { offeredAt: new Date(Date.now() - (OFFER_EXPIRES_SEC + 5) * 1000) },
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
  await storeConfig();
});

/* ------------------------------------------------------------ manual assign */

describe("POST /v1/ops/orders/:id/assign", () => {
  it("assigns a verified driver to a READY order with full side-effects", async () => {
    const ops = await opsUser();
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: driver.profileId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      orderId,
      status: "ASSIGNED",
      driverId: driver.profileId,
    });

    // Delivery created, order flipped, one OPS-actored event.
    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { orderId } });
    expect(delivery.driverId).toBe(driver.profileId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "ASSIGNED",
    );
    const events = await prisma.orderEvent.findMany({ where: { orderId, to: "ASSIGNED" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "OPS", actorId: ops.user.id });

    // Sensitive mutation → AuditLog.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ORDER_MANUAL_ASSIGN", entity: "Order", entityId: orderId },
    });
    expect(audit.actorId).toBe(ops.user.id);
    expect(audit.meta).toMatchObject({ driverId: driver.profileId, deliveryId: delivery.id });

    // The driver did not initiate this — they get a durable notification (+push).
    expect(
      await prisma.notification.count({
        where: { userId: driver.user.id, type: "DELIVERY_ASSIGNED" },
      }),
    ).toBe(1);

    // The driver app now sees the delivery as active.
    const active = await app.inject({
      method: "GET",
      url: "/v1/driver/active",
      headers: { ...authHeaders(driver.user), [APP_VERSION_HEADER]: "1.0.0" },
    });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().data).toMatchObject({ orderId, status: "ASSIGNED" });
  });

  it("settles pending offers like an accept: chosen ACCEPTED, others EXPIRED", async () => {
    const ops = await opsUser();
    const a = await makeDriver({ km: 0 });
    const b = await makeDriver({ km: 1 });
    const orderId = await makeReadyOrder();
    await dispatchOrder(orderId);
    expect(await offersFor(orderId)).toHaveLength(2);

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: a.profileId },
    });
    expect(res.statusCode, res.body).toBe(200);

    const offers = await offersFor(orderId);
    expect(offers.find((o) => o.driverId === a.profileId)?.status).toBe("ACCEPTED");
    expect(offers.find((o) => o.driverId === b.profileId)?.status).toBe("EXPIRED");
    expect(offers.some((o) => o.status === "OFFERED")).toBe(false);
  });

  it("rejects a non-READY order with 409 INVALID_TRANSITION", async () => {
    const ops = await opsUser();
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();
    await prisma.order.update({ where: { id: orderId }, data: { status: "PACKING" } });

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: driver.profileId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INVALID_TRANSITION");
    expect(await prisma.delivery.count({ where: { orderId } })).toBe(0);
  });

  it("404s an unknown order and an unknown driver", async () => {
    const ops = await opsUser();
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();

    const noOrder = await app.inject({
      method: "POST",
      url: "/v1/ops/orders/nope/assign",
      headers: ops.headers,
      payload: { driverId: driver.profileId },
    });
    expect(noOrder.statusCode).toBe(404);
    expect(noOrder.json().error.code).toBe("NOT_FOUND");

    const noDriver = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: "nope" },
    });
    expect(noDriver.statusCode).toBe(404);
  });

  it("rejects an unverified driver (403) and a driver with an active delivery (409)", async () => {
    const ops = await opsUser();
    const unverified = await makeDriver({ verified: false });
    const orderId = await makeReadyOrder();

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: unverified.profileId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");

    // Busy driver: give them another active delivery first.
    const busy = await makeDriver();
    const otherOrder = await makeReadyOrder();
    await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${otherOrder}/assign`,
      headers: ops.headers,
      payload: { driverId: busy.profileId },
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: busy.profileId },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("CONFLICT");
  });

  it("is INVENTORY/ADMIN only — a CUSTOMER gets 403", async () => {
    const customer = await user("CUSTOMER");
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: authHeaders(customer),
      payload: { driverId: driver.profileId },
    });
    expect(res.statusCode).toBe(403);
  });
});

/* -------------------------------------------------------------- re-dispatch */

describe("POST /v1/ops/orders/:id/redispatch", () => {
  it("re-offers previously-EXPIRED drivers exactly once after both waves died", async () => {
    const ops = await opsUser();
    const d0 = await makeDriver({ km: 0 });
    const d1 = await makeDriver({ km: 1 });
    const d2 = await makeDriver({ km: 2 });
    const orderId = await makeReadyOrder();

    // Wave 1 hits the whole 3-driver fleet; expiry finds no wave-2 candidates —
    // this is the launch dead-end: nothing will ever re-offer the order.
    await dispatchOrder(orderId);
    await backdateOffers(orderId);
    await expireAndEscalate(orderId);
    const dead = await offersFor(orderId);
    expect(dead).toHaveLength(3);
    expect(dead.every((o) => o.status === "EXPIRED")).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/redispatch`,
      headers: ops.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      orderId,
      status: "READY",
      clearedOffers: 3,
      offersCreated: 3,
    });

    // The same fleet is re-offered — exactly ONE live offer per driver.
    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(3);
    expect(offers.every((o) => o.status === "OFFERED" && o.wave === 1)).toBe(true);
    expect(new Set(offers.map((o) => o.driverId))).toEqual(
      new Set([d0.profileId, d1.profileId, d2.profileId]),
    );

    await prisma.auditLog.findFirstOrThrow({
      where: { action: "ORDER_REDISPATCH", entity: "Order", entityId: orderId },
    });

    // The restarted round is fully functional: an accept still wins normally.
    const first = offers[0];
    if (!first) throw new Error("expected an offer");
    await acceptOffer(first.id, first.driverId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "ASSIGNED",
    );
  });

  it("keeps a still-PENDING offer — that driver gets no duplicate", async () => {
    const ops = await opsUser();
    await makeDriver({ km: 0 });
    await makeDriver({ km: 1 });
    await makeDriver({ km: 2 });
    const far = await makeDriver({ km: 5 }); // wave-2-only (4th nearest)
    const orderId = await makeReadyOrder();

    await dispatchOrder(orderId);
    await backdateOffers(orderId);
    await expireAndEscalate(orderId); // wave 1 EXPIRED ×3, wave 2 OFFERED to `far`

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/redispatch`,
      headers: ops.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ clearedOffers: 3, offersCreated: 3 });

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(4);
    expect(offers.every((o) => o.status === "OFFERED")).toBe(true);
    // `far` kept its single pending wave-2 offer — no duplicate row.
    const farOffers = offers.filter((o) => o.driverId === far.profileId);
    expect(farOffers).toHaveLength(1);
    expect(farOffers[0]?.wave).toBe(2);
  });

  it("refuses a non-READY order (409) and 404s an unknown one", async () => {
    const ops = await opsUser();
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();
    await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/assign`,
      headers: ops.headers,
      payload: { driverId: driver.profileId },
    });

    const conflict = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/redispatch`,
      headers: ops.headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("CONFLICT");

    const missing = await app.inject({
      method: "POST",
      url: "/v1/ops/orders/nope/redispatch",
      headers: ops.headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});

/* ---------------------------------------------------------------- un-assign */

describe("POST /v1/ops/orders/:id/unassign", () => {
  it("restores READY pre-pickup: delivery deleted, offer voided, driver notified", async () => {
    const ops = await opsUser();
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();
    await dispatchOrder(orderId);
    const offer = (await offersFor(orderId))[0];
    if (!offer) throw new Error("expected an offer");
    await acceptOffer(offer.id, driver.profileId);

    // No body at all — the flag-less un-assign must work.
    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/unassign`,
      headers: ops.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      orderId,
      status: "READY",
      driverId: driver.profileId,
      redispatched: false,
      offersCreated: 0,
    });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("READY");
    expect(await prisma.delivery.count({ where: { orderId } })).toBe(0);
    // The winning offer no longer reads as a live win (and won't block re-offers).
    expect(
      (await prisma.deliveryOffer.findUniqueOrThrow({ where: { id: offer.id } })).status,
    ).toBe("EXPIRED");

    const events = await prisma.orderEvent.findMany({ where: { orderId, to: "READY" } });
    expect(events.some((e) => e.actorType === "OPS" && e.actorId === ops.user.id)).toBe(true);
    await prisma.auditLog.findFirstOrThrow({
      where: { action: "ORDER_UNASSIGN", entity: "Order", entityId: orderId },
    });
    expect(
      await prisma.notification.count({
        where: { userId: driver.user.id, type: "DELIVERY_UNASSIGNED" },
      }),
    ).toBe(1);
  });

  it("is refused once pickup happened", async () => {
    const ops = await opsUser();
    const driver = await makeDriver();
    const orderId = await makeReadyOrder();
    await dispatchOrder(orderId);
    const offer = (await offersFor(orderId))[0];
    if (!offer) throw new Error("expected an offer");
    await acceptOffer(offer.id, driver.profileId);

    // Raced shape first: pickedUpAt stamped while the order still reads ASSIGNED.
    await prisma.delivery.update({
      where: { orderId },
      data: { pickedUpAt: new Date() },
    });
    const raced = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/unassign`,
      headers: ops.headers,
    });
    expect(raced.statusCode).toBe(409);
    expect(raced.json().error.code).toBe("CONFLICT");

    // Settled shape: order PICKED_UP → the state machine refuses the edge.
    await prisma.order.update({ where: { id: orderId }, data: { status: "PICKED_UP" } });
    const settled = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/unassign`,
      headers: ops.headers,
    });
    expect(settled.statusCode).toBe(409);
    expect(settled.json().error.code).toBe("INVALID_TRANSITION");

    // Nothing was undone.
    expect(await prisma.delivery.count({ where: { orderId } })).toBe(1);
  });

  it("refuses an order that was never assigned (409) and 404s an unknown one", async () => {
    const ops = await opsUser();
    const orderId = await makeReadyOrder();

    const notAssigned = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/unassign`,
      headers: ops.headers,
    });
    expect(notAssigned.statusCode).toBe(409);

    const missing = await app.inject({
      method: "POST",
      url: "/v1/ops/orders/nope/unassign",
      headers: ops.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  it("with { redispatch: true } clears stale offers and re-offers the fleet", async () => {
    const ops = await opsUser();
    const a = await makeDriver({ km: 0 });
    const b = await makeDriver({ km: 1 });
    const orderId = await makeReadyOrder();
    await dispatchOrder(orderId);
    const offerA = (await offersFor(orderId)).find((o) => o.driverId === a.profileId);
    if (!offerA) throw new Error("expected an offer for driver A");
    await acceptOffer(offerA.id, a.profileId); // B's sibling offer auto-EXPIREs

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${orderId}/unassign`,
      headers: ops.headers,
      payload: { redispatch: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    // A's voided win + B's expired sibling were cleared; both got fresh offers.
    expect(res.json().data).toMatchObject({
      status: "READY",
      redispatched: true,
      clearedOffers: 2,
      offersCreated: 2,
    });

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(2);
    expect(offers.every((o) => o.status === "OFFERED" && o.wave === 1)).toBe(true);
    expect(new Set(offers.map((o) => o.driverId))).toEqual(new Set([a.profileId, b.profileId]));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("READY");
  });
});
