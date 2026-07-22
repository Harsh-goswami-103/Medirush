import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Lock-order discipline in the §9.4 stock reservation.
 *
 * `reserveStockOrThrow` takes a row-level lock per line (`UPDATE "Product" …`)
 * in `lineItems` order. If two concurrent checkouts hold the same two products
 * in OPPOSITE order, they deadlock (Postgres 40P01) — Prisma surfaces P2010 and
 * the customer gets a 500 on a perfectly valid order.
 *
 * `orders-race.int.test.ts` cannot catch this: it uses a SINGLE product, so
 * there is only ever one lock to take and no ordering to get wrong. The bug
 * needs two products held in opposite order — which is what this file sets up.
 *
 * The opposite order is not contrived. The cart read had no `orderBy`, so
 * Postgres answered from the heap in physical insert order: a customer who
 * added paracetamol then cough syrup got [A,B], and one who added them the other
 * way round got [B,A]. Two people buying the same two popular medicines at the
 * same moment is an ordinary Tuesday for a pharmacy, not an edge case.
 */

process.env.NODE_ENV = "test";

/**
 * This file DELIBERATELY forces sequential scans for its own connection.
 *
 * Without it the test is worthless as a regression guard: on a small table
 * Postgres reads cart items via the `@@unique([cartId, productId])` index, which
 * happens to return them productId-ascending, so even the unfixed code looks
 * correct. The heap-order path only appears once the table is large enough for
 * the planner to prefer a seq scan — i.e. in production, not in CI.
 *
 * Disabling index scans reproduces the production plan on a tiny test table, so
 * the AB-BA window is exercised on every run. Verified: against the unfixed
 * code this file fails with 9/10 checkouts returning 500 and Postgres logging
 * `40P01 deadlock detected` on the Product relation.
 *
 * Must be set BEFORE the dynamic imports below — the Prisma client reads
 * DATABASE_URL when it is constructed.
 */
const PLANNER_OPTS = [
  "-c enable_indexscan=off",
  "-c enable_bitmapscan=off",
  "-c enable_indexonlyscan=off",
].join(" ");
const BASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5433/medrush_test";
process.env.DATABASE_URL = `${BASE_URL.split("?")[0]}?options=${encodeURIComponent(PLANNER_OPTS)}`;

delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

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

describe("POST /v1/orders — concurrent checkouts sharing products", () => {
  it("buyers holding the same two products in opposite order all succeed", async () => {
    // Generous stock: every checkout is legitimately satisfiable, so the ONLY
    // thing that can fail these orders is lock contention.
    const a = await product({ stock: 500, pricePaise: 12000 });
    const b = await product({ stock: 500, pricePaise: 9000 });

    // Half the buyers insert A then B, half insert B then A. With no ORDER BY on
    // the cart read, the seq scan returns physical insert order, so the two
    // halves reserve in opposite directions — the AB-BA deadlock setup.
    const BUYERS = 10;
    const buyers = await Promise.all(
      Array.from({ length: BUYERS }, async (_, i) => {
        const customer = await user("CUSTOMER");
        const addr = await address(customer.id);
        const cart = await prisma.cart.create({ data: { userId: customer.id } });
        const order = i % 2 === 0 ? [a, b] : [b, a];
        // Sequential inserts: the physical row order within this cart is the
        // order we choose here.
        for (const p of order) {
          await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: 1 } });
        }
        return { headers: authHeaders(customer), addressId: addr.id };
      }),
    );

    const results = await Promise.all(
      buyers.map((buyer) =>
        app.inject({
          method: "POST",
          url: "/v1/orders",
          headers: { ...buyer.headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
          payload: { addressId: buyer.addressId, paymentMethod: "COD" },
        }),
      ),
    );

    // A deadlock surfaces as a 500. Report it loudly rather than as a bare count
    // mismatch, so a future regression names its own cause.
    const failures = results.filter((r) => r.statusCode !== 201);
    expect(
      failures.map((r) => `${r.statusCode} ${JSON.stringify(r.json())}`),
      "no checkout may fail: stock is ample, so any failure is lock contention",
    ).toEqual([]);
    expect(results).toHaveLength(BUYERS);

    // Stock is exact — a deadlock rollback that silently lost a reservation
    // would show up here even if the HTTP status somehow looked fine.
    const freshA = await prisma.product.findUniqueOrThrow({ where: { id: a.id } });
    const freshB = await prisma.product.findUniqueOrThrow({ where: { id: b.id } });
    expect(freshA.stockQty).toBe(500 - BUYERS);
    expect(freshB.stockQty).toBe(500 - BUYERS);
    expect(await prisma.order.count()).toBe(BUYERS);
  });

  it("reserves in a deterministic product order regardless of cart insert order", async () => {
    // The guarantee behind the test above: whatever order the customer added
    // items in, reservation walks products in a single canonical order, so no
    // two checkouts can ever request locks in opposite directions.
    const a = await product({ stock: 50, pricePaise: 12000 });
    const b = await product({ stock: 50, pricePaise: 9000 });
    // Explicit compare rather than destructuring a sort(): `noUncheckedIndexedAccess`
    // widens indexed reads to `string | undefined`.
    const first = a.id < b.id ? a.id : b.id;
    const second = a.id < b.id ? b.id : a.id;

    const customer = await user("CUSTOMER");
    const addr = await address(customer.id);
    const cart = await prisma.cart.create({ data: { userId: customer.id } });
    // Insert in DESCENDING id order — the opposite of the canonical order.
    for (const id of [second, first]) {
      await prisma.cartItem.create({ data: { cartId: cart.id, productId: id, qty: 1 } });
    }

    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { ...authHeaders(customer), [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
      payload: { addressId: addr.id, paymentMethod: "COD" },
    });
    expect(res.statusCode).toBe(201);

    // Order lines are persisted in the canonical product order, which is the
    // observable proxy for the order the locks were taken in.
    const order = await prisma.order.findFirstOrThrow({
      include: { items: { orderBy: { id: "asc" } } },
    });
    expect(order.items.map((i) => i.productId)).toEqual([first, second]);
  });
});
