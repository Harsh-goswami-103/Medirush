import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_VERSION_HEADER, IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Wallet ledger integration tests (§9.6): balanceAfter chain + invariant under
 * creditWallet, exactly-once crediting across a double deliver (second → 409),
 * and the driver wallet read endpoints.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

const { buildApp } = await import("../src/app");
const { getPrisma } = await import("../src/core/db");
const { assignDriver } = await import("../src/modules/dispatch/service");
const { markReady, startPacking } = await import("../src/modules/orders/opsService");
const { assertLedgerInvariant, creditWallet } = await import("../src/modules/wallet/ledger");
const { setupTestDb } = await import("./helpers/db");
const { authHeaders } = await import("./helpers/auth");
const factories = await import("./helpers/factories");

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY_MS = 86_400_000;
const STORE_POS = { lat: 12.9716, lng: 77.5946 };
const ADDRESS_POS = { lat: STORE_POS.lat + 0.011, lng: STORE_POS.lng };

const prisma = getPrisma();
let app: App;

function headersFor(user: { firebaseUid: string; phone: string }): Record<string, string> {
  return { ...authHeaders(user), [APP_VERSION_HEADER]: "9.9.9" };
}

beforeAll(async () => {
  await setupTestDb();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await setupTestDb();
  await factories.storeConfig({
    lat: STORE_POS.lat,
    lng: STORE_POS.lng,
    isOpen: true,
    openTime: "00:00",
    closeTime: "23:59",
  });
  await factories.appSettings();
});

async function makeDriver() {
  const driverUser = await factories.user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: { userId: driverUser.id, isVerified: true, isOnline: true },
  });
  return { driverUser, profile, headers: headersFor(driverUser) };
}

/**
 * Compact pipeline to PICKED_UP: COD order over the API, then ops actions via
 * the opsService (start-packing/ready), assignDriver service, driver HTTP
 * picked-up. Single eligible batch keeps allocations trivial.
 */
async function driveToPickedUp() {
  const customer = await factories.user("CUSTOMER");
  await prisma.user.update({ where: { id: customer.id }, data: { name: "Wallet Tester" } });
  const address = await prisma.address.create({
    data: {
      userId: customer.id,
      label: "Home",
      line1: "7 Residency Road",
      pincode: "560025",
      lat: ADDRESS_POS.lat,
      lng: ADDRESS_POS.lng,
    },
  });

  const product = await factories.product({ stock: 25 });
  await prisma.product.update({
    where: { id: product.id },
    data: { pricePaise: 6_000, mrpPaise: 8_000 },
  });
  const batch = await prisma.batch.create({
    data: {
      productId: product.id,
      batchNo: "WLT-01",
      expiryDate: new Date(Date.now() + 240 * DAY_MS),
      qtyReceived: 20,
      qtyAvailable: 20,
      costPaise: 4_000,
      wholesaler: "Test Wholesale Co",
      invoiceNo: "INV-WLT-01",
    },
  });

  await prisma.cart.create({
    data: { userId: customer.id, items: { create: [{ productId: product.id, qty: 3 }] } },
  });

  const createRes = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headersFor(customer), [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
    payload: { addressId: address.id, paymentMethod: "COD" },
  });
  expect([200, 201], createRes.body).toContain(createRes.statusCode);
  const order = createRes.json().data.order as { id: string; totalPaise: number };

  const ops = await factories.user("INVENTORY");
  const actor = { userId: ops.id as string, role: "INVENTORY" as const };
  await startPacking(order.id, actor);
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  await markReady(order.id, [{ orderItemId: item.id, batchId: batch.id, qty: item.qty }], actor);

  const driver = await makeDriver();
  const delivery = await assignDriver(order.id, driver.profile.id);

  const pickedUp = await app.inject({
    method: "POST",
    url: `/v1/driver/deliveries/${delivery.id}/picked-up`,
    headers: driver.headers,
  });
  expect(pickedUp.statusCode, pickedUp.body).toBe(200);

  const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  return { order, delivery, driver, otp: dbOrder.deliveryOtp ?? "", distanceM: dbOrder.distanceM };
}

describe("wallet ledger", () => {
  it("creditWallet keeps the balanceAfter chain and the ledger invariant", async () => {
    const { profile } = await makeDriver();

    await prisma.$transaction((tx) =>
      creditWallet(tx, profile.id, 12_345, { type: "ORDER", id: "order-a" }),
    );
    await prisma.$transaction((tx) =>
      creditWallet(tx, profile.id, 655, { type: "ORDER", id: "order-b" }, "second delivery"),
    );

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: profile.id } });
    expect(wallet.balancePaise).toBe(13_000);

    const txns = await prisma.walletTxn.findMany({ where: { walletId: wallet.id } });
    expect(txns).toHaveLength(2);
    expect(txns.every((t) => t.type === "CREDIT" && t.amountPaise > 0)).toBe(true);
    // balanceAfter chain (sorted client-side — createdAt can tie at ms precision).
    expect(txns.map((t) => t.balanceAfterPaise).sort((a, b) => a - b)).toEqual([12_345, 13_000]);

    await assertLedgerInvariant(wallet.id);
  });

  it("rejects zero and negative credit amounts", async () => {
    const { profile } = await makeDriver();
    await expect(
      prisma.$transaction((tx) => creditWallet(tx, profile.id, 0, { type: "ORDER", id: "x" })),
    ).rejects.toThrow();
    await expect(
      prisma.$transaction((tx) => creditWallet(tx, profile.id, -500, { type: "ORDER", id: "x" })),
    ).rejects.toThrow();
    expect(await prisma.walletTxn.count()).toBe(0);
  });

  it("deliver credits exactly once — the second deliver gets 409 and no extra credit", async () => {
    const { order, delivery, driver, otp, distanceM } = await driveToPickedUp();

    const store = await prisma.storeConfig.findUniqueOrThrow({ where: { id: "store" } });
    const expectedCommission =
      store.commissionBasePaise + store.commissionPerKmPaise * Math.ceil(distanceM / 1000);

    const deliverOnce = () =>
      app.inject({
        method: "POST",
        url: `/v1/driver/deliveries/${delivery.id}/deliver`,
        headers: driver.headers,
        payload: { otp, codCollectedPaise: order.totalPaise },
      });

    const first = await deliverOnce();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.commissionPaise).toBe(expectedCommission);

    const second = await deliverOnce();
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe("INVALID_TRANSITION");

    const txns = await prisma.walletTxn.findMany({ where: { refId: order.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0]?.amountPaise).toBe(expectedCommission);

    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { driverId: driver.profile.id },
    });
    expect(wallet.balancePaise).toBe(expectedCommission);
    await assertLedgerInvariant(wallet.id);

    // Driver-facing reads reflect the single credit.
    const balanceRes = await app.inject({
      method: "GET",
      url: "/v1/driver/wallet",
      headers: driver.headers,
    });
    expect(balanceRes.statusCode, balanceRes.body).toBe(200);
    expect(balanceRes.json().data.balancePaise).toBe(expectedCommission);

    const txnsRes = await app.inject({
      method: "GET",
      url: "/v1/driver/wallet/txns",
      headers: driver.headers,
    });
    expect(txnsRes.statusCode, txnsRes.body).toBe(200);
    const body = txnsRes.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe("CREDIT");
    expect(body.data[0].refType).toBe("ORDER");
    expect(body.data[0].refId).toBe(order.id);
    expect(body.data[0].balanceAfterPaise).toBe(expectedCommission);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("returns a zero balance and empty ledger for a driver with no wallet row yet", async () => {
    const { headers } = await makeDriver();

    const balanceRes = await app.inject({ method: "GET", url: "/v1/driver/wallet", headers });
    expect(balanceRes.statusCode, balanceRes.body).toBe(200);
    expect(balanceRes.json().data.balancePaise).toBe(0);

    const txnsRes = await app.inject({ method: "GET", url: "/v1/driver/wallet/txns", headers });
    expect(txnsRes.statusCode, txnsRes.body).toBe(200);
    expect(txnsRes.json().data).toEqual([]);
    expect(txnsRes.json().meta.nextCursor).toBeNull();
  });

  it("rejects a customer token on driver wallet routes with 403", async () => {
    const customer = await factories.user("CUSTOMER");
    const res = await app.inject({
      method: "GET",
      url: "/v1/driver/wallet",
      headers: headersFor(customer),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
