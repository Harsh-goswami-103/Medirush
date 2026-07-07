import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Stock never oversold (§9.4 conditional UPDATE): stock 3, five distinct buyers
 * each purchasing qty 1 in parallel → exactly 3 succeed, stock lands at 0, and
 * no negative values appear anywhere.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
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

describe("POST /v1/orders — parallel stock race", () => {
  it("stock 3, five single-qty buyers → exactly 3 succeed, stock 0, no negatives", async () => {
    const p = await product({ stock: 3, pricePaise: 12000 });

    const buyers = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const customer = await user("CUSTOMER");
        const addr = await address(customer.id);
        const cart = await prisma.cart.create({ data: { userId: customer.id } });
        await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: 1 } });
        return { headers: authHeaders(customer), addressId: addr.id };
      }),
    );

    const results = await Promise.all(
      buyers.map((b) =>
        app.inject({
          method: "POST",
          url: "/v1/orders",
          headers: { ...b.headers, [IDEMPOTENCY_KEY_HEADER]: randomUUID() },
          payload: { addressId: b.addressId, paymentMethod: "COD" },
        }),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const conflicts = results.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(3);
    expect(conflicts).toHaveLength(2);
    for (const r of conflicts) {
      expect(r.json().error.code).toBe("STOCK_INSUFFICIENT");
    }

    // Stock lands exactly at 0 — never oversold, never negative.
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(fresh.stockQty).toBe(0);

    // Exactly 3 orders + 3 SALE adjustments of -1 each.
    expect(await prisma.order.count()).toBe(3);
    const sales = await prisma.stockAdjustment.findMany({
      where: { productId: p.id, reason: "SALE" },
    });
    expect(sales).toHaveLength(3);
    for (const s of sales) {
      expect(s.delta).toBe(-1);
    }

    // Defensive: no product/batch quantity anywhere went negative.
    const negativeProducts = await prisma.product.count({ where: { stockQty: { lt: 0 } } });
    expect(negativeProducts).toBe(0);
    const negativeBatches = await prisma.batch.count({ where: { qtyAvailable: { lt: 0 } } });
    expect(negativeBatches).toBe(0);
  });
});
