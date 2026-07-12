import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { AlertKind, OrderStatus } from "@medrush/contracts";

/**
 * Business watchdog (§15) incl. the Phase 7 blindspot scans: PENDING_PAYMENT
 * past the payment timeout runs the SAME idempotent expiry path as the
 * payment-timeout job (a lost job must never reserve stock forever), and
 * PACKING / RX_REVIEW / ASSIGNED-without-pickup past their SLAs raise durable
 * STUCK_ORDER alerts. Real Postgres.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");
const { STORE_LAT, STORE_LNG, product, user } = await import("./helpers/factories");
const { flushOpsAlertWrites } = await import("../src/core/realtime");
const { runStuckOrderScan } = await import("../src/jobs/stuckOrders");

const prisma = getPrisma();
let seq = 0;

const minsAgo = (mins: number): Date => new Date(Date.now() - mins * 60_000);

interface MakeOrderInput {
  status: OrderStatus;
  createdAt?: Date;
  placedAt?: Date | null;
  packedAt?: Date | null;
  readyAt?: Date | null;
  paymentMethod?: "PREPAID" | "COD";
  paymentStatus?: "PENDING" | "COD_DUE";
  productId?: string;
  qty?: number;
}

async function makeOrder(input: MakeOrderInput) {
  seq += 1;
  const customer = await user("CUSTOMER");
  return prisma.order.create({
    data: {
      orderNo: `MR-STUCK-${seq}`,
      userId: customer.id,
      status: input.status,
      paymentMethod: input.paymentMethod ?? "COD",
      paymentStatus: input.paymentStatus ?? "COD_DUE",
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
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      placedAt: input.placedAt ?? null,
      packedAt: input.packedAt ?? null,
      readyAt: input.readyAt ?? null,
      ...(input.productId
        ? {
            items: {
              create: [
                {
                  productId: input.productId,
                  nameSnap: "Test Product",
                  packSizeSnap: "Strip of 10",
                  pricePaise: 10000,
                  mrpPaise: 12000,
                  gstRatePct: 12,
                  requiresRx: false,
                  qty: input.qty ?? 1,
                },
              ],
            },
          }
        : {}),
    },
  });
}

/** ASSIGNED order + delivery accepted `acceptedMinsAgo` minutes ago, no pickup. */
async function makeAssignedOrder(acceptedMinsAgo: number) {
  const order = await makeOrder({ status: OrderStatus.ASSIGNED, placedAt: minsAgo(60) });
  const driverUser = await user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: { userId: driverUser.id, isVerified: true },
  });
  await prisma.delivery.create({
    data: {
      orderId: order.id,
      driverId: profile.id,
      acceptedAt: minsAgo(acceptedMinsAgo),
      distanceM: 1500,
    },
  });
  return order;
}

afterAll(async () => {
  await disconnectPrisma();
});
beforeEach(async () => {
  await setupTestDb();
});

describe("stuck-order watchdog — PENDING_PAYMENT backstop", () => {
  it("expires an order stuck past timeout+slack via the payment-timeout path (stock released)", async () => {
    const p = await product({ stock: 48 }); // 50 minus 2 reserved at checkout
    const stale = await makeOrder({
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: "PREPAID",
      paymentStatus: "PENDING",
      createdAt: minsAgo(26), // > 15 min timeout + 10 min slack
      productId: p.id,
      qty: 2,
    });
    const fresh = await makeOrder({
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: "PREPAID",
      paymentStatus: "PENDING",
      createdAt: minsAgo(20), // past the timeout but within the slack — job's territory
    });

    const count = await runStuckOrderScan();
    expect(count).toBe(1);

    const expired = await prisma.order.findUniqueOrThrow({ where: { id: stale.id } });
    expect(expired.status).toBe(OrderStatus.CANCELLED);
    expect(expired.cancelReason).toBeTruthy();
    const restocked = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(restocked.stockQty).toBe(50); // the 2 reserved units came back

    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(untouched.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Idempotent: a second pass finds nothing left to expire.
    expect(await runStuckOrderScan()).toBe(0);
  });
});

describe("stuck-order watchdog — blindspot scans", () => {
  it("flags PACKING > 20 min, RX_REVIEW > 45 min and ASSIGNED without pickup > 15 min", async () => {
    await makeOrder({ status: OrderStatus.PACKING, placedAt: minsAgo(60), packedAt: minsAgo(21) });
    await makeOrder({ status: OrderStatus.PACKING, placedAt: minsAgo(10), packedAt: minsAgo(5) });
    const rxStuck = await makeOrder({ status: OrderStatus.RX_REVIEW, placedAt: minsAgo(46) });
    await makeOrder({ status: OrderStatus.RX_REVIEW, placedAt: minsAgo(10) });
    await makeAssignedOrder(16);
    await makeAssignedOrder(5);

    const count = await runStuckOrderScan();
    expect(count).toBe(3);

    // Alerts are durable now — drain the fire-and-forget writes, then assert.
    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where: { kind: AlertKind.STUCK_ORDER } })).toBe(3);
    const rxAlert = await prisma.opsAlert.findFirstOrThrow({ where: { refId: rxStuck.id } });
    expect(rxAlert.message).toContain("RX_REVIEW");
  });

  it("keeps the original PLACED / READY / PICKED_UP scans working", async () => {
    await makeOrder({ status: OrderStatus.PLACED, placedAt: minsAgo(11) });
    await makeOrder({ status: OrderStatus.PLACED, placedAt: minsAgo(2) });
    await makeOrder({ status: OrderStatus.READY, placedAt: minsAgo(30), readyAt: minsAgo(8) });

    const count = await runStuckOrderScan();
    expect(count).toBe(2);
  });
});

describe("stuck-order watchdog — re-alert dedupe", () => {
  it("re-scans over the same stuck order create exactly one unacked alert; ack re-arms", async () => {
    const order = await makeOrder({ status: OrderStatus.PLACED, placedAt: minsAgo(11) });
    const where = { kind: AlertKind.STUCK_ORDER, refId: order.id };

    expect(await runStuckOrderScan()).toBe(1);
    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where })).toBe(1);

    // The 5-min-later pass: the order is still stuck (still counted) but the
    // open unacked alert suppresses a duplicate row/page.
    expect(await runStuckOrderScan()).toBe(1);
    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where })).toBe(1);

    // Acking re-arms: the next pass over the STILL-stuck order pages again.
    await prisma.opsAlert.updateMany({ where, data: { acknowledgedAt: new Date() } });
    expect(await runStuckOrderScan()).toBe(1);
    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where })).toBe(2);
    expect(await prisma.opsAlert.count({ where: { ...where, acknowledgedAt: null } })).toBe(1);
  });
});
