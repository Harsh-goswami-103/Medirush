import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_OTP_MAX_ATTEMPTS } from "@medrush/contracts";
import type { Prisma } from "@prisma/client";

/**
 * POST /v1/ops/orders/:id/reset-otp — §9.7 lockout recovery. Ops zeroes the
 * durable `Order.otpAttempts` counter on an active delivery-stage order
 * (READY/ASSIGNED/PICKED_UP), audited, idempotent; 404 unknown, 409 outside the
 * delivery stage, 403 for non-ops roles.
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
const { appSettings, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;
let seq = 0;

/** Bare order row in an arbitrary status (locked-out delivery by default). */
async function makeOrder(
  userId: string,
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.order.create({
    data: {
      orderNo: `MR-TEST-${Date.now()}-${seq}`,
      userId,
      status: "PICKED_UP",
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
      deliveryOtp: "1234",
      otpAttempts: DELIVERY_OTP_MAX_ATTEMPTS,
      placedAt: new Date(),
      ...overrides,
    },
  });
}

function resetOtp(orderId: string, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: `/v1/ops/orders/${orderId}/reset-otp`,
    headers,
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

describe("POST /v1/ops/orders/:id/reset-otp", () => {
  it("zeroes the counter on a locked-out PICKED_UP order + writes the audit row", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id);

    const res = await resetOtp(order.id, authHeaders(ops));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ ok: true });

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.otpAttempts).toBe(0);

    const audit = await prisma.auditLog.findMany({ where: { action: "OTP_RESET" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(ops.id);
    expect(audit[0]?.entityId).toBe(order.id);
    expect(audit[0]?.meta).toMatchObject({ previousAttempts: DELIVERY_OTP_MAX_ATTEMPTS });
  });

  it("works for READY and ASSIGNED orders too, and is idempotent", async () => {
    const ops = await user("ADMIN");
    const customer = await user("CUSTOMER");

    for (const status of ["READY", "ASSIGNED"] as const) {
      const order = await makeOrder(customer.id, { status, otpAttempts: 3 });
      const first = await resetOtp(order.id, authHeaders(ops));
      expect(first.statusCode, first.body).toBe(200);

      // Second reset on an already-zero counter is still a success.
      const second = await resetOtp(order.id, authHeaders(ops));
      expect(second.statusCode, second.body).toBe(200);

      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(fresh.otpAttempts).toBe(0);
    }
  });

  it("unknown order → 404", async () => {
    const ops = await user("INVENTORY");
    const res = await resetOtp("nonexistent-order-id", authHeaders(ops));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("outside the delivery stage → 409 CONFLICT, counter untouched", async () => {
    const ops = await user("INVENTORY");
    const customer = await user("CUSTOMER");

    for (const status of ["PLACED", "DELIVERED", "CANCELLED"] as const) {
      const order = await makeOrder(customer.id, { status });
      const res = await resetOtp(order.id, authHeaders(ops));
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe("CONFLICT");
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(fresh.otpAttempts).toBe(DELIVERY_OTP_MAX_ATTEMPTS);
    }
  });

  it("non-ops roles → 403 FORBIDDEN", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeOrder(customer.id);

    const res = await resetOtp(order.id, authHeaders(customer));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
