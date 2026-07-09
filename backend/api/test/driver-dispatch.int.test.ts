import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { APP_VERSION_HEADER } from "@medrush/contracts";

/**
 * Driver dispatch HTTP endpoints (§7.2 driver): status, offers, accept (+ the
 * lost-race 409), location → track pipeline, history, payout request. Real
 * Postgres; offers are seeded by calling the dispatch service directly.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { bustFlagCache } = await import("../src/core/flags");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { resetLocationStore } = await import("../src/core/locationStore");
const { dispatchOrder } = await import("../src/modules/dispatch/service");
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, appSettings, product, storeConfig, user } = await import(
  "./helpers/factories"
);
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;
const prisma = getPrisma();
let app: App;
let seq = 0;

const driverHeaders = (u: { firebaseUid: string; phone: string }) => ({
  ...authHeaders(u),
  [APP_VERSION_HEADER]: "1.0.0",
});

async function makeReadyOrder(): Promise<string> {
  seq += 1;
  const customer = await user("CUSTOMER");
  const p = await product({ stock: 50 });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-DRV-${seq}`,
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

async function makeDriver(km = 0) {
  const u = await user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: {
      userId: u.id,
      isVerified: true,
      isOnline: true,
      lastLat: STORE_LAT,
      lastLng: STORE_LNG + km / 100,
    },
  });
  return { user: u, profileId: profile.id, headers: driverHeaders(u) };
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
  resetLocationStore();
  await storeConfig();
  await appSettings();
});

describe("driver status + offers + accept", () => {
  it("toggles online, lists the offer, and accepts it", async () => {
    const driver = await makeDriver(0);
    const orderId = await makeReadyOrder();

    const status = await app.inject({
      method: "PATCH",
      url: "/v1/driver/status",
      headers: driver.headers,
      payload: { isOnline: true },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data).toMatchObject({ isOnline: true, isVerified: true });

    await dispatchOrder(orderId);

    const offers = await app.inject({ method: "GET", url: "/v1/driver/offers", headers: driver.headers });
    expect(offers.statusCode, offers.body).toBe(200);
    const offerList = offers.json().data;
    expect(offerList).toHaveLength(1);
    expect(offerList[0].orderId).toBe(orderId);

    const accept = await app.inject({
      method: "POST",
      url: `/v1/driver/offers/${offerList[0].offerId}/accept`,
      headers: driver.headers,
    });
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().data).toMatchObject({ orderId, status: "ASSIGNED", codDuePaise: 12000 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("ASSIGNED");
  });

  it("the driver who loses the race gets 409 OFFER_TAKEN", async () => {
    const a = await makeDriver(0);
    const b = await makeDriver(1);
    const orderId = await makeReadyOrder();
    await dispatchOrder(orderId);

    const offerA = (await app.inject({ method: "GET", url: "/v1/driver/offers", headers: a.headers })).json()
      .data[0];
    const offerB = (await app.inject({ method: "GET", url: "/v1/driver/offers", headers: b.headers })).json()
      .data[0];

    const first = await app.inject({
      method: "POST",
      url: `/v1/driver/offers/${offerA.offerId}/accept`,
      headers: a.headers,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/driver/offers/${offerB.offerId}/accept`,
      headers: b.headers,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("OFFER_TAKEN");
  });
});

describe("driver location → track", () => {
  it("a ping while active is stored and surfaced on the order's track", async () => {
    const driver = await makeDriver(0);
    const orderId = await makeReadyOrder();
    await dispatchOrder(orderId);
    const offer = (await app.inject({ method: "GET", url: "/v1/driver/offers", headers: driver.headers })).json()
      .data[0];
    await app.inject({
      method: "POST",
      url: `/v1/driver/offers/${offer.offerId}/accept`,
      headers: driver.headers,
    });

    const ping = await app.inject({
      method: "POST",
      url: "/v1/driver/location",
      headers: driver.headers,
      payload: { points: [{ lat: 12.98, lng: 77.6, ts: new Date().toISOString() }] },
    });
    expect(ping.statusCode, ping.body).toBe(200);

    // The customer's track now reflects the driver position.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const customer = await prisma.user.findUniqueOrThrow({ where: { id: order.userId } });
    const track = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/track`,
      headers: authHeaders(customer),
    });
    expect(track.statusCode, track.body).toBe(200);
    expect(track.json().data.driverLocation).toMatchObject({ lat: 12.98, lng: 77.6 });
  });

  it("a ping with no active delivery is rejected", async () => {
    const driver = await makeDriver(0);
    const res = await app.inject({
      method: "POST",
      url: "/v1/driver/location",
      headers: driver.headers,
      payload: { points: [{ lat: 12.98, lng: 77.6, ts: new Date().toISOString() }] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("driver payout request", () => {
  it("requests a payout ≤ balance and rejects one above it", async () => {
    const driver = await makeDriver(0);
    await prisma.wallet.create({ data: { driverId: driver.profileId, balancePaise: 100000 } });

    const ok = await app.inject({
      method: "POST",
      url: "/v1/driver/payouts",
      headers: { ...driver.headers, "idempotency-key": "payout-1" },
      payload: { amountPaise: 50000, upiOrAcct: "driver@upi", method: "UPI" },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().data).toMatchObject({ amountPaise: 50000, status: "REQUESTED" });

    const tooMuch = await app.inject({
      method: "POST",
      url: "/v1/driver/payouts",
      headers: { ...driver.headers, "idempotency-key": "payout-2" },
      payload: { amountPaise: 150000, upiOrAcct: "driver@upi", method: "UPI" },
    });
    expect(tooMuch.statusCode).toBe(422);

    const list = await app.inject({ method: "GET", url: "/v1/driver/payouts", headers: driver.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
  });
});
