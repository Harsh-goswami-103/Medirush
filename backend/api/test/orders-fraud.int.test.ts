import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, MAX_ORDERS_PER_HOUR } from "@medrush/contracts";

/**
 * §10.3 fraud gates under PARALLELISM (TOCTOU fix): the pre-TX velocity /
 * first-order-COD-cap counts are fast-fail only — the authoritative re-check
 * runs INSIDE the order-create transaction under a `SELECT … FOR UPDATE` on the
 * User row (assertFraudGatesInTx), so N concurrent checkouts from one account
 * serialise and can never collectively exceed the caps. Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { flushOpsAlertWrites } = await import("../src/core/realtime");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

function postOrder(
  headers: Record<string, string>,
  body: { addressId: string; paymentMethod: string },
) {
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
    payload: body,
  });
}

async function setCartItem(userId: string, productId: string, qty: number): Promise<void> {
  const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    create: { cartId: cart.id, productId, qty },
    update: { qty },
  });
}

async function seedCustomer() {
  const customer = await user("CUSTOMER");
  const addr = await address(customer.id);
  return { customer, headers: authHeaders(customer), addressId: addr.id };
}

/**
 * Deterministic race harness: hold the checkout serialisation point (the User
 * row lock) from a side transaction while the whole burst completes its pre-TX
 * checks and queues on the in-TX gate, then release. Every request is
 * guaranteed to have passed the (stale) pre-checks before ANY order commits —
 * exactly the TOCTOU window the in-TX re-check closes.
 */
async function withUserRowHeld<T>(userId: string, run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    await gate;
  });

  const burst = run();
  // Give every request time to finish its pre-TX reads and block on the lock.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  release();
  await holder;
  return burst;
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

describe("POST /v1/orders — §10.3 fraud gates under parallelism", () => {
  it("a burst of 5 parallel checkouts creates at most MAX_ORDERS_PER_HOUR orders and alerts", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 50, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);

    const results = await withUserRowHeld(customer.id, () =>
      Promise.all(
        Array.from({ length: 5 }, () => postOrder(headers, { addressId, paymentMethod: "COD" })),
      ),
    );

    // Exactly the cap succeeds; every loser is the velocity 429, not a 500.
    const created = results.filter((r) => r.statusCode === 201);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(created).toHaveLength(MAX_ORDERS_PER_HOUR);
    expect(limited).toHaveLength(5 - MAX_ORDERS_PER_HOUR);
    for (const r of limited) {
      expect(r.json().error.code).toBe("RATE_LIMITED");
    }

    // The DB can never hold more orders than the hourly cap.
    expect(await prisma.order.count({ where: { userId: customer.id } })).toBe(
      MAX_ORDERS_PER_HOUR,
    );

    // The in-TX trip emits the FRAUD_VELOCITY ops alert (durable row) too —
    // one per loser; the write is fire-and-forget, so drain it first.
    await flushOpsAlertWrites();
    const alerts = await prisma.opsAlert.count({ where: { kind: "FRAUD_VELOCITY" } });
    expect(alerts).toBe(5 - MAX_ORDERS_PER_HOUR);
  });

  it("parallel PREPAID checkouts respect the velocity cap too", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 50, pricePaise: 12000 });
    await setCartItem(customer.id, p.id, 1);

    const results = await withUserRowHeld(customer.id, () =>
      Promise.all(
        Array.from({ length: 5 }, () =>
          postOrder(headers, { addressId, paymentMethod: "PREPAID" }),
        ),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(created).toHaveLength(MAX_ORDERS_PER_HOUR);
    expect(limited).toHaveLength(5 - MAX_ORDERS_PER_HOUR);
    expect(await prisma.order.count({ where: { userId: customer.id } })).toBe(
      MAX_ORDERS_PER_HOUR,
    );
  });

  it("first-order COD cap holds under parallelism: two over-cap bursts → zero orders", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    // 60000 items ≥ freeDeliveryAbove 49900 → delivery 0 → total 60000 > cap 50000.
    const p = await product({ stock: 50, pricePaise: 60000, mrpPaise: 65000 });
    await setCartItem(customer.id, p.id, 1);

    const results = await withUserRowHeld(customer.id, () =>
      Promise.all(
        Array.from({ length: 2 }, () => postOrder(headers, { addressId, paymentMethod: "COD" })),
      ),
    );

    for (const r of results) {
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error.code).toBe("COD_LIMIT_EXCEEDED");
    }
    expect(await prisma.order.count({ where: { userId: customer.id } })).toBe(0);
    // Stock untouched — no reservation survived.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(50);
  });

  it("sequential fast-fail still works: 4th order in the hour → 429 before any TX", async () => {
    const { customer, headers, addressId } = await seedCustomer();
    const p = await product({ stock: 20, pricePaise: 12000 });

    for (let i = 0; i < MAX_ORDERS_PER_HOUR; i += 1) {
      await setCartItem(customer.id, p.id, 1);
      const ok = await postOrder(headers, { addressId, paymentMethod: "COD" });
      expect(ok.statusCode, ok.body).toBe(201);
    }

    await setCartItem(customer.id, p.id, 1);
    const res = await postOrder(headers, { addressId, paymentMethod: "COD" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(await prisma.order.count()).toBe(MAX_ORDERS_PER_HOUR);
  });
});
