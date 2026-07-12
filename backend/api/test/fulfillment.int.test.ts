import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_VERSION_HEADER, IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Fulfillment golden path over HTTP (Phase 1 DoD): COD order created via API →
 * ops start-packing → ready with the server-proposed FEFO allocations →
 * assignDriver (service, no HTTP per brief) → driver picked-up → deliver with
 * OTP + exact COD amount → DELIVERED, stock/batches/events/wallet all correct.
 * Plus: OTP lockout, illegal deliver transition, partial allocation, ops RBAC.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

const { buildApp } = await import("../src/app");
const { getPrisma } = await import("../src/core/db");
const { assignDriver } = await import("../src/modules/dispatch/service");
const { assertLedgerInvariant } = await import("../src/modules/wallet/ledger");
const { setupTestDb } = await import("./helpers/db");
const { authHeaders } = await import("./helpers/auth");
const factories = await import("./helpers/factories");

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY_MS = 86_400_000;
const STORE_POS = { lat: 12.9716, lng: 77.5946 };
// ~1.2 km north of the store → distanceM ∈ (1000, 2000), so the commission
// ceil() genuinely rounds up (ceil(1.2) = 2 km).
const ADDRESS_POS = { lat: STORE_POS.lat + 0.011, lng: STORE_POS.lng };

const prisma = getPrisma();
let app: App;

function headersFor(user: { firebaseUid: string; phone: string }): Record<string, string> {
  return { ...authHeaders(user), [APP_VERSION_HEADER]: "9.9.9" };
}

beforeAll(async () => {
  await setupTestDb(); // primes DATABASE_URL default + asserts the _test suffix
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

/* ------------------------------------------------------------- fixtures */

async function createBatch(productId: string, batchNo: string, expiryInDays: number, qty: number) {
  return prisma.batch.create({
    data: {
      productId,
      batchNo,
      expiryDate: new Date(Date.now() + expiryInDays * DAY_MS),
      qtyReceived: qty,
      qtyAvailable: qty,
      costPaise: 4_000,
      wholesaler: "Test Wholesale Co",
      invoiceNo: `INV-${batchNo}`,
    },
  });
}

/**
 * Customer + serviceable address + product with three batches (one near-expiry
 * that FEFO must skip, one small early-expiry, one large late-expiry), cart,
 * then a COD order over the API. qty 3 forces a FEFO split: EARLY(2) + LATE(1).
 */
async function placeCodOrder(qty = 3) {
  const customer = await factories.user("CUSTOMER");
  await prisma.user.update({ where: { id: customer.id }, data: { name: "Test Customer" } });
  const address = await prisma.address.create({
    data: {
      userId: customer.id,
      label: "Home",
      line1: "12 MG Road",
      pincode: "560001",
      lat: ADDRESS_POS.lat,
      lng: ADDRESS_POS.lng,
    },
  });

  const product = await factories.product({ stock: 25 });
  // Deterministic money regardless of factory defaults: 3 × 6000 = 18000 paise
  // — above minOrder (9900), below COD caps (50000 new-account / 150000).
  await prisma.product.update({
    where: { id: product.id },
    data: { pricePaise: 6_000, mrpPaise: 8_000 },
  });

  const near = await createBatch(product.id, "NEAR-01", 10, 50);
  const early = await createBatch(product.id, "EARLY-01", 60, 2);
  const late = await createBatch(product.id, "LATE-01", 240, 20);

  await prisma.cart.create({
    data: { userId: customer.id, items: { create: [{ productId: product.id, qty }] } },
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headersFor(customer), [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
    payload: { addressId: address.id, paymentMethod: "COD" },
  });
  expect([200, 201], res.body).toContain(res.statusCode);
  const order = res.json().data.order as { id: string; status: string; totalPaise: number };
  return { customer, address, product, near, early, late, order };
}

async function makeOps() {
  const ops = await factories.user("INVENTORY");
  return { ops, headers: headersFor(ops) };
}

async function makeDriver() {
  const driverUser = await factories.user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: { userId: driverUser.id, isVerified: true, isOnline: true },
  });
  return { driverUser, profile, headers: headersFor(driverUser) };
}

async function fetchOpsDetail(orderId: string, headers: Record<string, string>) {
  const res = await app.inject({ method: "GET", url: `/v1/ops/orders/${orderId}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
}

function allocationsFromDetail(detail: {
  items: Array<{ id: string; fefoSuggestions: Array<{ batchId: string; qty: number }> }>;
}) {
  return detail.items.flatMap((item) =>
    item.fefoSuggestions.map((s) => ({ orderItemId: item.id, batchId: s.batchId, qty: s.qty })),
  );
}

/** Full pipeline up to PICKED_UP; returns everything later steps need. */
async function driveToPickedUp(qty = 3) {
  const fixture = await placeCodOrder(qty);
  const { headers: opsHeaders } = await makeOps();

  const pack = await app.inject({
    method: "POST",
    url: `/v1/ops/orders/${fixture.order.id}/start-packing`,
    headers: opsHeaders,
  });
  expect(pack.statusCode, pack.body).toBe(200);

  const detail = await fetchOpsDetail(fixture.order.id, opsHeaders);
  const allocations = allocationsFromDetail(detail);
  const ready = await app.inject({
    method: "POST",
    url: `/v1/ops/orders/${fixture.order.id}/ready`,
    headers: opsHeaders,
    payload: { allocations },
  });
  expect(ready.statusCode, ready.body).toBe(200);

  const driver = await makeDriver();
  const delivery = await assignDriver(fixture.order.id, driver.profile.id);

  const pickedUp = await app.inject({
    method: "POST",
    url: `/v1/driver/deliveries/${delivery.id}/picked-up`,
    headers: driver.headers,
  });
  expect(pickedUp.statusCode, pickedUp.body).toBe(200);

  const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
  return { ...fixture, opsHeaders, driver, delivery, otp: dbOrder.deliveryOtp ?? "" };
}

/* ----------------------------------------------------------------- tests */

describe("fulfillment golden path (COD, PLACED→DELIVERED over HTTP)", () => {
  it("runs the full pipeline with FEFO, OTP, COD collection and a single wallet credit", async () => {
    const { order, early, late, near } = await placeCodOrder(3);
    expect(order.status).toBe("PLACED");

    const { headers: opsHeaders } = await makeOps();

    // Order appears on the live queue.
    const list = await app.inject({
      method: "GET",
      url: "/v1/ops/orders?status=PLACED",
      headers: opsHeaders,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.map((row: { id: string }) => row.id)).toContain(order.id);

    // PLACED → PACKING.
    const pack = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/start-packing`,
      headers: opsHeaders,
    });
    expect(pack.statusCode, pack.body).toBe(200);
    expect(pack.json().data.status).toBe("PACKING");

    // Detail proposes FEFO: near-expiry batch skipped, split EARLY(2) + LATE(1).
    const detail = await fetchOpsDetail(order.id, opsHeaders);
    expect(detail.items).toHaveLength(1);
    const suggestions = detail.items[0].fefoSuggestions as Array<{ batchId: string; qty: number }>;
    expect(suggestions.map((s) => s.batchId)).toEqual([early.id, late.id]);
    expect(suggestions.map((s) => s.qty)).toEqual([2, 1]);
    expect(suggestions.map((s) => s.batchId)).not.toContain(near.id);

    // PACKING → READY with the proposed allocations.
    const allocations = allocationsFromDetail(detail);
    const ready = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/ready`,
      headers: opsHeaders,
      payload: { allocations },
    });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json().data.status).toBe("READY");

    const readyOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(readyOrder.deliveryOtp).toMatch(/^\d{4}$/);
    expect(readyOrder.readyAt).not.toBeNull();

    // Batches decremented conditionally.
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: early.id } })).qtyAvailable).toBe(0);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: late.id } })).qtyAvailable).toBe(19);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: near.id } })).qtyAvailable).toBe(50);

    // ItemBatchAlloc rows snapshot batchNo + expiry.
    const allocRows = await prisma.itemBatchAlloc.findMany({
      where: { orderItem: { orderId: order.id } },
    });
    expect(allocRows).toHaveLength(2);
    const earlyAlloc = allocRows.find((a) => a.batchId === early.id);
    const lateAlloc = allocRows.find((a) => a.batchId === late.id);
    expect(earlyAlloc?.qty).toBe(2);
    expect(earlyAlloc?.batchNoSnap).toBe("EARLY-01");
    expect(earlyAlloc?.expirySnap.toISOString().slice(0, 10)).toBe(
      early.expiryDate.toISOString().slice(0, 10),
    );
    expect(lateAlloc?.qty).toBe(1);
    expect(lateAlloc?.batchNoSnap).toBe("LATE-01");

    // READY → ASSIGNED via the dispatch service (no HTTP surface in Phase 1).
    const driver = await makeDriver();
    const delivery = await assignDriver(order.id, driver.profile.id);
    expect(delivery.orderId).toBe(order.id);
    expect(delivery.distanceM).toBe(readyOrder.distanceM);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("ASSIGNED");

    // Driver sees the assignment.
    const activeAssigned = await app.inject({
      method: "GET",
      url: "/v1/driver/active",
      headers: driver.headers,
    });
    expect(activeAssigned.statusCode, activeAssigned.body).toBe(200);
    expect(activeAssigned.json().data.deliveryId).toBe(delivery.id);
    expect(activeAssigned.json().data.status).toBe("ASSIGNED");
    expect(activeAssigned.json().data.codDuePaise).toBe(order.totalPaise);

    // ASSIGNED → PICKED_UP.
    const pickedUp = await app.inject({
      method: "POST",
      url: `/v1/driver/deliveries/${delivery.id}/picked-up`,
      headers: driver.headers,
    });
    expect(pickedUp.statusCode, pickedUp.body).toBe(200);
    expect(pickedUp.json().data.status).toBe("PICKED_UP");
    expect(pickedUp.json().data.pickedUpAt).not.toBeNull();

    // PICKED_UP → DELIVERED with the real OTP + exact COD amount.
    const store = await prisma.storeConfig.findUniqueOrThrow({ where: { id: "store" } });
    expect(readyOrder.distanceM).toBeGreaterThan(1000);
    expect(readyOrder.distanceM).toBeLessThan(2000); // ceil() must round 1.2km → 2km
    const expectedCommission =
      store.commissionBasePaise +
      store.commissionPerKmPaise * Math.ceil(readyOrder.distanceM / 1000);

    const deliver = await app.inject({
      method: "POST",
      url: `/v1/driver/deliveries/${delivery.id}/deliver`,
      headers: driver.headers,
      payload: { otp: readyOrder.deliveryOtp, codCollectedPaise: order.totalPaise },
    });
    expect(deliver.statusCode, deliver.body).toBe(200);
    expect(deliver.json().data.commissionPaise).toBe(expectedCommission);
    expect(deliver.json().data.walletBalancePaise).toBe(expectedCommission);

    // Final order + delivery state.
    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    expect(finalOrder.status).toBe("DELIVERED");
    expect(finalOrder.paymentStatus).toBe("COD_COLLECTED");
    expect(finalOrder.deliveredAt).not.toBeNull();

    const finalDelivery = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(finalDelivery.deliveredAt).not.toBeNull();
    expect(finalDelivery.otpVerifiedAt).not.toBeNull();
    expect(finalDelivery.commissionPaise).toBe(expectedCommission);
    expect(finalDelivery.codCollectedPaise).toBe(order.totalPaise);

    // Event chain: exactly one event per transition, in order.
    const transitions = finalOrder.events.map((e) => `${e.from ?? "∅"}→${e.to}`);
    const expectedChain = [
      "PLACED→PACKING",
      "PACKING→READY",
      "READY→ASSIGNED",
      "ASSIGNED→PICKED_UP",
      "PICKED_UP→DELIVERED",
    ];
    expect(transitions.filter((t) => expectedChain.includes(t))).toEqual(expectedChain);

    // Wallet credited exactly once, ledger invariant intact.
    const txns = await prisma.walletTxn.findMany({ where: { refId: order.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0]?.type).toBe("CREDIT");
    expect(txns[0]?.amountPaise).toBe(expectedCommission);
    expect(txns[0]?.balanceAfterPaise).toBe(expectedCommission);
    expect(txns[0]?.refType).toBe("ORDER");
    await assertLedgerInvariant(txns[0]!.walletId);
  });

  it("locks the OTP after 5 wrong attempts (4× OTP_INVALID, then OTP_LOCKED, even for the right OTP)", async () => {
    const { order, delivery, driver, otp } = await driveToPickedUp();
    const wrongOtp = otp === "0000" ? "1111" : "0000";

    const attempt = (candidate: string) =>
      app.inject({
        method: "POST",
        url: `/v1/driver/deliveries/${delivery.id}/deliver`,
        headers: driver.headers,
        payload: { otp: candidate, codCollectedPaise: order.totalPaise },
      });

    for (let i = 1; i <= 4; i += 1) {
      const res = await attempt(wrongOtp);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe("OTP_INVALID");
    }

    const fifth = await attempt(wrongOtp);
    expect(fifth.statusCode, fifth.body).toBe(422);
    expect(fifth.json().error.code).toBe("OTP_LOCKED");

    // Even the correct OTP is rejected once locked (ops unlock = resetting the
    // durable Order.otpAttempts column; cross-instance proof in
    // app-hardening-otp.int.test.ts).
    const sixth = await attempt(otp);
    expect(sixth.statusCode, sixth.body).toBe(422);
    expect(sixth.json().error.code).toBe("OTP_LOCKED");

    // Nothing was delivered or credited.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PICKED_UP",
    );
    expect(await prisma.walletTxn.count({ where: { refId: order.id } })).toBe(0);
  });

  it("rejects deliver on a PLACED order with 409 INVALID_TRANSITION", async () => {
    const { order } = await placeCodOrder();
    const driver = await makeDriver();
    // Simulate a corrupt/raced state: a Delivery row pointing at a PLACED order.
    const delivery = await prisma.delivery.create({
      data: { orderId: order.id, driverId: driver.profile.id, distanceM: 1500 },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/driver/deliveries/${delivery.id}/deliver`,
      headers: driver.headers,
      payload: { otp: "1234", codCollectedPaise: order.totalPaise },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("INVALID_TRANSITION");
  });

  it("rejects ready with partial or unknown-item allocations (422) without touching stock", async () => {
    const { order, early, late } = await placeCodOrder(3);
    const { headers: opsHeaders } = await makeOps();

    const pack = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/start-packing`,
      headers: opsHeaders,
    });
    expect(pack.statusCode, pack.body).toBe(200);

    const detail = await fetchOpsDetail(order.id, opsHeaders);
    const item = detail.items[0] as { id: string; qty: number };

    // Partial: 1 of 3 units allocated.
    const partial = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/ready`,
      headers: opsHeaders,
      payload: { allocations: [{ orderItemId: item.id, batchId: early.id, qty: 1 }] },
    });
    expect(partial.statusCode, partial.body).toBe(422);
    expect(partial.json().error.code).toBe("VALIDATION_ERROR");

    // Unknown order item id.
    const unknown = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/ready`,
      headers: opsHeaders,
      payload: { allocations: [{ orderItemId: "not-a-real-item", batchId: late.id, qty: 3 }] },
    });
    expect(unknown.statusCode, unknown.body).toBe(422);
    expect(unknown.json().error.code).toBe("VALIDATION_ERROR");

    // No side effects: order still PACKING, no OTP, batches untouched.
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe("PACKING");
    expect(dbOrder.deliveryOtp).toBeNull();
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: early.id } })).qtyAvailable).toBe(2);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: late.id } })).qtyAvailable).toBe(20);
    expect(await prisma.itemBatchAlloc.count()).toBe(0);
  });

  it("rejects ready when an allocation uses an expired / near-expiry batch (422)", async () => {
    const { order, near } = await placeCodOrder(3);
    const { headers: opsHeaders } = await makeOps();

    const pack = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/start-packing`,
      headers: opsHeaders,
    });
    expect(pack.statusCode, pack.body).toBe(200);

    const detail = await fetchOpsDetail(order.id, opsHeaders);
    const item = detail.items[0] as { id: string; qty: number };

    // NEAR-01 expires in 10 days — inside the 30-day FEFO shelf-life cutoff, so it
    // is excluded from the suggestion. A stale/crafted client that allocates it
    // anyway must be rejected AT COMMIT (compliance: no near-expiry dispensing).
    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/ready`,
      headers: opsHeaders,
      payload: { allocations: [{ orderItemId: item.id, batchId: near.id, qty: item.qty }] },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // No side effects: order still PACKING, near batch untouched, no allocations.
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe("PACKING");
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: near.id } })).qtyAvailable).toBe(50);
    expect(await prisma.itemBatchAlloc.count()).toBe(0);
  });

  it("rejects a customer token on ops routes with 403 FORBIDDEN", async () => {
    const customer = await factories.user("CUSTOMER");
    const res = await app.inject({
      method: "GET",
      url: "/v1/ops/orders",
      headers: headersFor(customer),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
