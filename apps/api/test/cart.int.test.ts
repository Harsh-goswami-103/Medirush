import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

// Env before app import — config parses eagerly. `??=` so CI/dev URLs win.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { validateCart } = await import("../src/modules/cart/service");
const { setupTestDb } = await import("./helpers/db");
const { storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();

let seq = 0;
async function seedProduct(overrides: Partial<Prisma.ProductUncheckedCreateInput> = {}) {
  seq += 1;
  const category = await prisma.category.create({
    data: { name: `Cart Category ${seq}`, slug: `cart-category-${seq}` },
  });
  return prisma.product.create({
    data: {
      name: `Cart Product ${seq}`,
      slug: `cart-product-${seq}`,
      categoryId: category.id,
      mrpPaise: 15000,
      pricePaise: 12000,
      gstRatePct: 12,
      packSize: "Strip of 10",
      stockQty: 10,
      ...overrides,
    },
  });
}

interface CartPayload {
  id: string;
  items: Array<{
    productId: string;
    qty: number;
    lineTotalPaise: number;
    product: { id: string; pricePaise: number; inStock: boolean; requiresRx: boolean };
  }>;
  itemsPaise: number;
  requiresRx: boolean;
  updatedAt: string;
}
interface ValidatePayload {
  valid: boolean;
  issues: Array<{ productId: string; kind: string; availableQty?: number }>;
  cart: CartPayload;
}

describe("cart endpoints", () => {
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
  });

  async function customerHeaders() {
    const customer = await user("CUSTOMER");
    const headers = await authHeaders(customer);
    return { customer, headers };
  }

  function putItem(headers: Record<string, string>, productId: string, qty: number) {
    return app.inject({
      method: "PUT",
      url: "/v1/cart/items",
      headers,
      payload: { productId, qty },
    });
  }

  it("PUT → update → DELETE roundtrip keeps server-priced totals", async () => {
    const { headers } = await customerHeaders();
    const product = await seedProduct({ pricePaise: 4550 });

    const added = await putItem(headers, product.id, 2);
    expect(added.statusCode).toBe(200);
    expect(added.headers["cache-control"]).toBe("no-store");
    let cart = (added.json() as { data: CartPayload }).data;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({
      productId: product.id,
      qty: 2,
      lineTotalPaise: 9100,
    });
    expect(cart.itemsPaise).toBe(9100);

    // PUT is set-to-qty, not additive.
    const updated = await putItem(headers, product.id, 5);
    cart = (updated.json() as { data: CartPayload }).data;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.qty).toBe(5);
    expect(cart.itemsPaise).toBe(5 * 4550);

    const fetched = await app.inject({ method: "GET", url: "/v1/cart", headers });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["cache-control"]).toBe("no-store");
    expect((fetched.json() as { data: CartPayload }).data.itemsPaise).toBe(22750);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/cart/items/${product.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    cart = (removed.json() as { data: CartPayload }).data;
    expect(cart.items).toEqual([]);
    expect(cart.itemsPaise).toBe(0);
    expect(cart.requiresRx).toBe(false);
  });

  it("PUT beyond maxPerOrder → 422 VALIDATION_ERROR; at the cap → 200", async () => {
    const { headers } = await customerHeaders();
    const product = await seedProduct({ maxPerOrder: 3 });

    const rejected = await putItem(headers, product.id, 4);
    expect(rejected.statusCode).toBe(422);
    expect((rejected.json() as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");

    const atCap = await putItem(headers, product.id, 3);
    expect(atCap.statusCode).toBe(200);
    expect((atCap.json() as { data: CartPayload }).data.items[0]?.qty).toBe(3);
  });

  it("PUT with an inactive product → 404 NOT_FOUND", async () => {
    const { headers } = await customerHeaders();
    const inactive = await seedProduct({ isActive: false });

    const res = await putItem(headers, inactive.id, 1);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("cart requires an authenticated CUSTOMER (401 anonymous, 403 other roles)", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/v1/cart" });
    expect(anonymous.statusCode).toBe(401);

    const driver = await user("DRIVER");
    const asDriver = await app.inject({
      method: "GET",
      url: "/v1/cart",
      headers: await authHeaders(driver),
    });
    expect(asDriver.statusCode).toBe(403);
  });

  it("validate flags stock shortfall after a direct stock decrement", async () => {
    await storeConfig();
    const { headers } = await customerHeaders();
    const product = await seedProduct({ stockQty: 5 });

    expect((await putItem(headers, product.id, 5)).statusCode).toBe(200);

    // Someone else bought stock out from under the cart.
    await prisma.product.update({ where: { id: product.id }, data: { stockQty: 2 } });

    const res = await app.inject({ method: "POST", url: "/v1/cart/validate", headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = (res.json() as { data: ValidatePayload }).data;
    expect(body.valid).toBe(false);
    expect(body.issues).toEqual([
      expect.objectContaining({
        productId: product.id,
        kind: "STOCK_INSUFFICIENT",
        availableQty: 2,
      }),
    ]);
    // The cart itself still hydrates with live product state.
    expect(body.cart.items[0]?.product.inStock).toBe(true);

    // Fully sold out → OUT_OF_STOCK.
    await prisma.product.update({ where: { id: product.id }, data: { stockQty: 0 } });
    const soldOut = await app.inject({ method: "POST", url: "/v1/cart/validate", headers });
    const soldOutBody = (soldOut.json() as { data: ValidatePayload }).data;
    expect(soldOutBody.valid).toBe(false);
    expect(soldOutBody.issues).toEqual([
      expect.objectContaining({ productId: product.id, kind: "OUT_OF_STOCK" }),
    ]);
    expect(soldOutBody.cart.items[0]?.product.inStock).toBe(false);
  });

  it("totals math in paise: line totals, itemsPaise, Rx flag, delivery preview", async () => {
    await storeConfig();
    const { customer, headers } = await customerHeaders();
    const paracetamol = await seedProduct({ pricePaise: 4550 });
    const insulin = await seedProduct({ pricePaise: 12005, requiresRx: true });

    expect((await putItem(headers, paracetamol.id, 2)).statusCode).toBe(200);
    expect((await putItem(headers, insulin.id, 3)).statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/v1/cart", headers });
    const cart = (res.json() as { data: CartPayload }).data;
    const lines = new Map(cart.items.map((item) => [item.productId, item]));
    expect(lines.get(paracetamol.id)?.lineTotalPaise).toBe(9100);
    expect(lines.get(insulin.id)?.lineTotalPaise).toBe(36015);
    expect(cart.itemsPaise).toBe(45115);
    expect(cart.requiresRx).toBe(true);

    // Totals preview (service-level — not yet in the wire contract, see report):
    // §9.2 delivery = items >= freeDeliveryAbovePaise ? 0 : deliveryBasePaise.
    const result = await validateCart(customer.id);
    const cfg = await prisma.storeConfig.findFirstOrThrow();
    const expectedDelivery = 45115 >= cfg.freeDeliveryAbovePaise ? 0 : cfg.deliveryBasePaise;
    expect(result.valid).toBe(true);
    expect(result.totals.itemsPaise).toBe(45115);
    expect(result.totals.deliveryPaise).toBe(expectedDelivery);
    expect(result.totals.totalPaise).toBe(45115 + expectedDelivery);
    expect(result.totals.minOrderPaise).toBe(cfg.minOrderPaise);
    expect(result.totals.minOrderMet).toBe(45115 >= cfg.minOrderPaise);
  });
});
