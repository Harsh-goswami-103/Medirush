import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { APP_VERSION_HEADER, DELIVERY_OTP_MAX_ATTEMPTS } from "@medrush/contracts";

/**
 * Durable delivery-OTP attempts (Phase 7 §10): the wrong-attempt counter lives
 * in `Order.otpAttempts` — a process restart must NOT refill the brute-force
 * budget of a 4-digit OTP, and the ops reset (writing the column to 0) must
 * unlock. Proven with TWO separate app builds sharing the database.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");
const { authHeaders } = await import("./helpers/auth");
const factories = await import("./helpers/factories");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
const OTP = "1234";
const WRONG = "0000";

afterAll(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  await factories.storeConfig();
  await factories.appSettings();
});

/** A PICKED_UP COD order with a known OTP, its delivery, and a verified driver. */
async function makeFixture() {
  const customer = await factories.user("CUSTOMER");
  const driverUser = await factories.user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: { userId: driverUser.id, isVerified: true, isOnline: true },
  });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-OTP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      userId: customer.id,
      status: "PICKED_UP",
      paymentMethod: "COD",
      paymentStatus: "COD_DUE",
      deliveryOtp: OTP,
      addressSnapshot: {
        name: "Cust",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: factories.STORE_LAT,
        lng: factories.STORE_LNG,
      } as Prisma.InputJsonValue,
      distanceM: 1500,
      itemsPaise: 10000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 12000,
      requiresRx: false,
      rxStatus: "NA",
    },
  });
  const delivery = await prisma.delivery.create({
    data: { orderId: order.id, driverId: profile.id, distanceM: 1500, pickedUpAt: new Date() },
  });
  const headers = { ...authHeaders(driverUser), [APP_VERSION_HEADER]: "9.9.9" };
  return { order, delivery, headers };
}

function attempt(app: App, deliveryId: string, headers: Record<string, string>, otp: string) {
  return app.inject({
    method: "POST",
    url: `/v1/driver/deliveries/${deliveryId}/deliver`,
    headers,
    payload: { otp, codCollectedPaise: 12000 },
  });
}

describe("Order.otpAttempts is the single durable source of truth", () => {
  it("wrong-attempt budget accumulates across app instances (restart survives)", async () => {
    const { order, delivery, headers } = await makeFixture();

    // Instance #1: two wrong attempts land in the COLUMN, not process memory.
    const app1 = await buildApp();
    await app1.ready();
    try {
      for (const attemptsLeft of [4, 3]) {
        const res = await attempt(app1, delivery.id, headers, WRONG);
        expect(res.statusCode, res.body).toBe(422);
        expect(res.json().error.code).toBe("OTP_INVALID");
        expect(res.json().error.details.attemptsLeft).toBe(attemptsLeft);
      }
    } finally {
      await app1.close();
    }
    const afterTwo = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterTwo.otpAttempts).toBe(2);

    // Instance #2 ("after restart"): the budget continues where #1 left off.
    const app2 = await buildApp();
    await app2.ready();
    try {
      const third = await attempt(app2, delivery.id, headers, WRONG);
      expect(third.statusCode, third.body).toBe(422);
      expect(third.json().error.code).toBe("OTP_INVALID");
      expect(third.json().error.details.attemptsLeft).toBe(2);

      // Simulate a previous life having burned 4 attempts — instance #2 has no
      // in-process history at all, so only the column can lock attempt #5.
      await prisma.order.update({
        where: { id: order.id },
        data: { otpAttempts: DELIVERY_OTP_MAX_ATTEMPTS - 1 },
      });
      const fifth = await attempt(app2, delivery.id, headers, WRONG);
      expect(fifth.statusCode, fifth.body).toBe(422);
      expect(fifth.json().error.code).toBe("OTP_LOCKED");

      // Locked means locked — even the CORRECT OTP is rejected.
      const locked = await attempt(app2, delivery.id, headers, OTP);
      expect(locked.statusCode, locked.body).toBe(422);
      expect(locked.json().error.code).toBe("OTP_LOCKED");

      // Nothing was delivered or credited while locked.
      const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(dbOrder.status).toBe("PICKED_UP");
      expect(dbOrder.otpAttempts).toBe(DELIVERY_OTP_MAX_ATTEMPTS);
      expect(await prisma.walletTxn.count()).toBe(0);

      // Ops unlock = the column reset; the correct OTP then delivers normally.
      await prisma.order.update({ where: { id: order.id }, data: { otpAttempts: 0 } });
      const unlocked = await attempt(app2, delivery.id, headers, OTP);
      expect(unlocked.statusCode, unlocked.body).toBe(200);
      const delivered = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(delivered.status).toBe("DELIVERED");
      expect(delivered.otpAttempts).toBe(0);
    } finally {
      await app2.close();
    }
  });
});
