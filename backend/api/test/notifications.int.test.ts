import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { APP_VERSION_HEADER } from "@medrush/contracts";

/**
 * Notification center (Phase 6, §7.2): the own-rows-only read/mark endpoints and
 * their RBAC, plus the lifecycle wiring — an order driven to DELIVERED writes a
 * customer notification and a payout approval writes a driver notification. Real
 * Postgres; flows driven over real HTTP.
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
const { notifyUser } = await import("../src/modules/notifications/service");
const { creditWallet } = await import("../src/modules/wallet/ledger");
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

/* --------------------------------------------------------- center endpoints */

describe("notification center endpoints", () => {
  it("lists, counts unread, marks one read, and marks all read (own rows only)", async () => {
    const a = await user("CUSTOMER");
    await notifyUser({
      userId: a.id,
      type: "ORDER_PLACED",
      title: "Order placed",
      body: "We've received your order.",
      data: { orderId: "order-x" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: authHeaders(a),
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().data as Array<{ id: string; type: string; readAt: string | null }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("ORDER_PLACED");
    expect(items[0]?.readAt).toBeNull();
    const notifId = items[0]!.id;

    const count1 = await app.inject({
      method: "GET",
      url: "/v1/notifications/unread-count",
      headers: authHeaders(a),
    });
    expect(count1.json().data.count).toBe(1);

    const read = await app.inject({
      method: "POST",
      url: `/v1/notifications/${notifId}/read`,
      headers: authHeaders(a),
    });
    expect(read.statusCode, read.body).toBe(200);

    const count0 = await app.inject({
      method: "GET",
      url: "/v1/notifications/unread-count",
      headers: authHeaders(a),
    });
    expect(count0.json().data.count).toBe(0);

    // Two more, then read-all → back to zero unread.
    await notifyUser({ userId: a.id, type: "ORDER_READY", title: "Packed", body: "Ready." });
    await notifyUser({ userId: a.id, type: "ORDER_PICKED_UP", title: "On the way", body: "Soon." });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/notifications/unread-count",
          headers: authHeaders(a),
        })
      ).json().data.count,
    ).toBe(2);

    const readAll = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: authHeaders(a),
    });
    expect(readAll.statusCode, readAll.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/notifications/unread-count",
          headers: authHeaders(a),
        })
      ).json().data.count,
    ).toBe(0);
  });

  it("a user cannot see or mark another user's notifications", async () => {
    const a = await user("CUSTOMER");
    const b = await user("CUSTOMER");
    await notifyUser({ userId: a.id, type: "ORDER_PLACED", title: "A's order", body: "hi" });

    const aRow = await prisma.notification.findFirstOrThrow({ where: { userId: a.id } });

    // B's list is empty and B's unread count is zero.
    const bList = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: authHeaders(b),
    });
    expect(bList.json().data).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/notifications/unread-count",
          headers: authHeaders(b),
        })
      ).json().data.count,
    ).toBe(0);

    // B marking A's row is a silent no-op (scoped by userId) — A's row stays unread.
    const bMark = await app.inject({
      method: "POST",
      url: `/v1/notifications/${aRow.id}/read`,
      headers: authHeaders(b),
    });
    expect(bMark.statusCode).toBe(200);
    const stillUnread = await prisma.notification.findUniqueOrThrow({ where: { id: aRow.id } });
    expect(stillUnread.readAt).toBeNull();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/notifications/unread-count",
          headers: authHeaders(a),
        })
      ).json().data.count,
    ).toBe(1);
  });
});

/* ------------------------------------------------------------- lifecycle */

async function makeReadyOrder(): Promise<{ orderId: string; customerId: string }> {
  seq += 1;
  const customer = await user("CUSTOMER");
  const p = await product({ stock: 50 });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-NOTIF-${seq}`,
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
    data: { userId: u.id, isVerified: true, isOnline: true, lastLat: STORE_LAT, lastLng: STORE_LNG },
  });
  return { user: u, profileId: profile.id, headers: driverHeaders(u) };
}

describe("lifecycle → notifications", () => {
  it("an order driven to DELIVERED writes a customer notification", async () => {
    const { orderId, customerId } = await makeReadyOrder();
    const driver = await makeDriver();

    await dispatchOrder(orderId);
    const offer = (
      await app.inject({ method: "GET", url: "/v1/driver/offers", headers: driver.headers })
    ).json().data[0];
    const accept = await app.inject({
      method: "POST",
      url: `/v1/driver/offers/${offer.offerId}/accept`,
      headers: driver.headers,
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const deliveryId = accept.json().data.deliveryId as string;

    const pickedUp = await app.inject({
      method: "POST",
      url: `/v1/driver/deliveries/${deliveryId}/picked-up`,
      headers: driver.headers,
    });
    expect(pickedUp.statusCode, pickedUp.body).toBe(200);

    const delivered = await app.inject({
      method: "POST",
      url: `/v1/driver/deliveries/${deliveryId}/deliver`,
      headers: driver.headers,
      payload: { otp: "1234", codCollectedPaise: 12000 },
    });
    expect(delivered.statusCode, delivered.body).toBe(200);

    // ASSIGNED, PICKED_UP and DELIVERED all wrote customer notifications.
    const notifs = await prisma.notification.findMany({ where: { userId: customerId } });
    const types = notifs.map((n) => n.type);
    expect(types).toContain("ORDER_ASSIGNED");
    expect(types).toContain("ORDER_PICKED_UP");
    expect(types).toContain("ORDER_DELIVERED");
    const delivRow = notifs.find((n) => n.type === "ORDER_DELIVERED");
    expect((delivRow?.data as { orderId?: string } | null)?.orderId).toBe(orderId);
  });

  it("a payout approval writes a driver notification", async () => {
    const admin = await user("ADMIN");
    const driver = await makeDriver();
    await prisma.$transaction((tx) =>
      creditWallet(tx, driver.profileId, 100000, { type: "ORDER", id: randomUUID() }, "seed"),
    );
    const payout = await prisma.payout.create({
      data: {
        driverId: driver.profileId,
        amountPaise: 60000,
        status: "REQUESTED",
        upiOrAcct: "driver@upi",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/approve`,
      headers: authHeaders(admin),
    });
    expect(res.statusCode, res.body).toBe(200);

    const notif = await prisma.notification.findFirstOrThrow({
      where: { userId: driver.user.id, type: "PAYOUT_APPROVED" },
    });
    expect((notif.data as { payoutId?: string } | null)?.payoutId).toBe(payout.id);
  });
});
