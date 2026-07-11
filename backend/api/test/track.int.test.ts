import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { APP_VERSION_HEADER } from "@medrush/contracts";

/**
 * GET /v1/orders/:id/track (Phase 6, §3.5/§18.1): the extended live-tracking
 * payload — map anchors (store + destination), assigned-driver card, status
 * timeline, and heuristic ETA — plus the ownership 404. Real Postgres; the
 * driver flow is driven over real HTTP.
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

async function makeReadyOrder(): Promise<{ orderId: string; customerId: string }> {
  seq += 1;
  const customer = await user("CUSTOMER");
  const p = await product({ stock: 50 });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-TRK-${seq}`,
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
  return { orderId: order.id, customerId: customer.id };
}

async function makeDriver() {
  const u = await user("DRIVER", { name: "Ravi Kumar" });
  const profile = await prisma.driverProfile.create({
    data: {
      userId: u.id,
      isVerified: true,
      isOnline: true,
      vehicleType: "BIKE",
      vehicleNo: "KA01AB1234",
      lastLat: STORE_LAT,
      lastLng: STORE_LNG,
    },
  });
  return { user: u, profileId: profile.id, headers: driverHeaders(u) };
}

/** Drive a READY order to ASSIGNED by dispatching + accepting the offer. */
async function assignViaOffer(orderId: string, driver: Awaited<ReturnType<typeof makeDriver>>) {
  await dispatchOrder(orderId);
  const offer = (
    await app.inject({ method: "GET", url: "/v1/driver/offers", headers: driver.headers })
  ).json().data[0];
  await app.inject({
    method: "POST",
    url: `/v1/driver/offers/${offer.offerId}/accept`,
    headers: driver.headers,
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
  resetLocationStore();
  await storeConfig();
  await appSettings();
});

describe("GET /track payload", () => {
  it("returns store + destination + driver + timeline, ETA from a live ping", async () => {
    const { orderId, customerId } = await makeReadyOrder();
    const driver = await makeDriver();
    await assignViaOffer(orderId, driver);

    // A live ping ~1.4km away drives a positive ETA.
    const ping = await app.inject({
      method: "POST",
      url: "/v1/driver/location",
      headers: driver.headers,
      payload: { points: [{ lat: 12.985, lng: 77.605, ts: new Date().toISOString() }] },
    });
    expect(ping.statusCode, ping.body).toBe(200);

    const customer = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/track`,
      headers: authHeaders(customer),
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;

    expect(data.store).toMatchObject({ lat: STORE_LAT, lng: STORE_LNG });
    expect(data.destination).toMatchObject({ lat: STORE_LAT, lng: STORE_LNG });
    expect(data.driver).toMatchObject({
      name: "Ravi Kumar",
      vehicleType: "BIKE",
      vehicleNo: "KA01AB1234",
    });
    expect(data.driverLocation).toMatchObject({ lat: 12.985, lng: 77.605 });
    // Timeline carries the ASSIGNED transition (oldest→newest), no duplicates.
    expect(data.timeline.length).toBeGreaterThanOrEqual(1);
    expect(data.timeline[data.timeline.length - 1].status).toBe("ASSIGNED");
    // ETA is a positive integer once a ping exists and the order is non-terminal.
    expect(Number.isInteger(data.etaMinutes)).toBe(true);
    expect(data.etaMinutes).toBeGreaterThan(0);
  });

  it("driver is null and ETA null before ASSIGNED (no ping yet)", async () => {
    const { orderId, customerId } = await makeReadyOrder();
    const customer = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/track`,
      headers: authHeaders(customer),
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.driver).toBeNull();
    expect(data.driverLocation).toBeNull();
    expect(data.etaMinutes).toBeNull();
    expect(data.store).toMatchObject({ lat: STORE_LAT, lng: STORE_LNG });
  });

  it("a non-owner customer gets 404 (ownership)", async () => {
    const { orderId } = await makeReadyOrder();
    const intruder = await user("CUSTOMER");
    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/track`,
      headers: authHeaders(intruder),
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
