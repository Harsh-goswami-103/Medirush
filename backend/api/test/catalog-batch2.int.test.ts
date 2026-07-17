import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Batch 2 catalog surface: list filters + sort, same-composition substitutes,
 * back-in-stock alerts (subscribe lifecycle + restock fan-out). Real Postgres.
 */

// Env before app import — config parses eagerly. `??=` so CI/dev URLs win.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");
const factories = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY_MS = 86_400_000;
const ymd = (msFromNow: number): string =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 10);

const prisma = getPrisma();

let seq = 0;
async function seedCategory(overrides: Partial<Prisma.CategoryUncheckedCreateInput> = {}) {
  seq += 1;
  return prisma.category.create({
    data: { name: `B2 Category ${seq}`, slug: `b2-category-${seq}`, sortOrder: seq, ...overrides },
  });
}

async function seedProduct(
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.product.create({
    data: {
      name: `B2 Product ${seq}`,
      slug: `b2-product-${seq}`,
      categoryId,
      mrpPaise: 12000,
      pricePaise: 9900,
      gstRatePct: 12,
      packSize: "Strip of 10",
      stockQty: 10,
      ...overrides,
    },
  });
}

interface ProductCard {
  id: string;
  name: string;
  pricePaise: number;
  inStock: boolean;
  requiresRx: boolean;
}
interface ListBody {
  data: ProductCard[];
  meta: { nextCursor: string | null };
}
interface AlertBody {
  data: { subscribed: boolean };
}
interface ErrorBody {
  error: { code: string };
}

describe("catalog batch 2", () => {
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

  async function list(query: string): Promise<ListBody> {
    const res = await app.inject({ method: "GET", url: `/v1/products?${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as ListBody;
  }

  describe("list filters", () => {
    it("inStock is tri-state on the plain listing", async () => {
      const category = await seedCategory();
      const stocked = await seedProduct(category.id, { stockQty: 5 });
      const empty = await seedProduct(category.id, { stockQty: 0 });

      expect((await list("inStock=true")).data.map((p) => p.id)).toEqual([stocked.id]);
      expect((await list("inStock=false")).data.map((p) => p.id)).toEqual([empty.id]);
      expect((await list("limit=20")).data).toHaveLength(2);
    });

    it("price band, requiresRx and discounted filters on the plain listing", async () => {
      const category = await seedCategory();
      const cheapOtc = await seedProduct(category.id, { pricePaise: 5000, mrpPaise: 5000 });
      const midRx = await seedProduct(category.id, {
        pricePaise: 15000,
        mrpPaise: 20000,
        requiresRx: true,
      });
      const dearOtc = await seedProduct(category.id, { pricePaise: 30000, mrpPaise: 30000 });

      expect((await list("minPricePaise=10000&maxPricePaise=20000")).data.map((p) => p.id)).toEqual([
        midRx.id,
      ]);
      expect((await list("requiresRx=true")).data.map((p) => p.id)).toEqual([midRx.id]);
      expect((await list("requiresRx=false")).data.map((p) => p.id).sort()).toEqual(
        [cheapOtc.id, dearOtc.id].sort(),
      );
      expect((await list("discounted=true")).data.map((p) => p.id)).toEqual([midRx.id]);
    });

    it("filters compose with trgm search", async () => {
      const category = await seedCategory();
      const dolo = await seedProduct(category.id, {
        name: "Dolo 650",
        composition: "Paracetamol 650mg",
        stockQty: 10,
        pricePaise: 2000,
      });
      const calpol = await seedProduct(category.id, {
        name: "Calpol 500",
        composition: "Paracetamol 500mg",
        stockQty: 0,
        pricePaise: 9000,
      });
      await seedProduct(category.id, {
        name: "Benadryl Syrup",
        composition: "Diphenhydramine 25mg",
        stockQty: 0,
      });

      const inStock = await list("search=paracetamol&inStock=true");
      expect(inStock.data.map((p) => p.id)).toEqual([dolo.id]);
      expect(inStock.meta.nextCursor).toBeNull();

      expect((await list("search=paracetamol&inStock=false")).data.map((p) => p.id)).toEqual([
        calpol.id,
      ]);
      expect((await list("search=paracetamol&maxPricePaise=5000")).data.map((p) => p.id)).toEqual([
        dolo.id,
      ]);
    });
  });

  describe("list sort", () => {
    it("price_asc / price_desc / name return ordered top-N with a null cursor", async () => {
      const category = await seedCategory();
      const mid = await seedProduct(category.id, { name: "Bbb", pricePaise: 5000 });
      const cheap = await seedProduct(category.id, { name: "Ccc", pricePaise: 1000 });
      const dear = await seedProduct(category.id, { name: "Aaa", pricePaise: 9000 });

      const asc = await list("sort=price_asc&limit=2");
      expect(asc.data.map((p) => p.id)).toEqual([cheap.id, mid.id]);
      // Sorted reads are top-N only — never a cursor, even with more rows left.
      expect(asc.meta.nextCursor).toBeNull();

      const desc = await list("sort=price_desc");
      expect(desc.data.map((p) => p.id)).toEqual([dear.id, mid.id, cheap.id]);
      expect(desc.meta.nextCursor).toBeNull();

      expect((await list("sort=name")).data.map((p) => p.id)).toEqual([dear.id, mid.id, cheap.id]);
    });

    it("sort=discount ranks by percentage off, not absolute paise", async () => {
      const category = await seedCategory();
      // 40% off (4000 paise absolute).
      const forty = await seedProduct(category.id, { mrpPaise: 10000, pricePaise: 6000 });
      // 5% off but the LARGEST absolute cut (5000 paise) — catches an absolute-diff sort.
      const five = await seedProduct(category.id, { mrpPaise: 100000, pricePaise: 95000 });
      // 50% off.
      const fifty = await seedProduct(category.id, { mrpPaise: 20000, pricePaise: 10000 });

      const res = await list("sort=discount");
      expect(res.data.map((p) => p.id)).toEqual([fifty.id, forty.id, five.id]);
      expect(res.meta.nextCursor).toBeNull();
    });

    it("sort overrides similarity ordering in the search path", async () => {
      const category = await seedCategory();
      const dear = await seedProduct(category.id, {
        name: "Dolo 650",
        composition: "Paracetamol 650mg",
        pricePaise: 8000,
      });
      const cheap = await seedProduct(category.id, {
        name: "Calpol 500",
        composition: "Paracetamol 500mg",
        pricePaise: 3000,
      });

      const res = await list("search=paracetamol&sort=price_asc");
      expect(res.data.map((p) => p.id)).toEqual([cheap.id, dear.id]);
      expect(res.meta.nextCursor).toBeNull();
    });
  });

  describe("substitutes", () => {
    it("matches normalized composition with Rx parity; self/inactive excluded; in-stock first then cheapest", async () => {
      const category = await seedCategory();
      await seedProduct(category.id, {
        slug: "dolo-650",
        composition: "Paracetamol 650mg",
        stockQty: 10,
        pricePaise: 3000,
      });
      const cheapIn = await seedProduct(category.id, {
        composition: "  paracetamol 650MG ", // case + whitespace differ → still matches
        stockQty: 5,
        pricePaise: 2000,
      });
      const dearIn = await seedProduct(category.id, {
        composition: "PARACETAMOL 650MG",
        stockQty: 3,
        pricePaise: 4000,
      });
      const cheapestOos = await seedProduct(category.id, {
        composition: "Paracetamol 650mg",
        stockQty: 0,
        pricePaise: 1000,
      });
      await seedProduct(category.id, {
        composition: "Paracetamol 650mg",
        requiresRx: true, // Rx-parity: never suggested for an OTC base
      });
      await seedProduct(category.id, { composition: "Paracetamol 650mg", isActive: false });
      await seedProduct(category.id, { composition: "Ibuprofen 400mg" });

      const res = await app.inject({ method: "GET", url: "/v1/products/dolo-650/substitutes" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, s-maxage=60, stale-while-revalidate=300");
      const body = res.json() as { data: ProductCard[] };
      // Cheapest OOS row sorts AFTER every in-stock row.
      expect(body.data.map((p) => p.id)).toEqual([cheapIn.id, dearIn.id, cheapestOos.id]);
      expect(body.data.map((p) => p.inStock)).toEqual([true, true, false]);
    });

    it("404 for unknown or inactive base product", async () => {
      const category = await seedCategory();
      await seedProduct(category.id, { slug: "ghost", isActive: false });

      const inactive = await app.inject({ method: "GET", url: "/v1/products/ghost/substitutes" });
      expect(inactive.statusCode).toBe(404);
      expect((inactive.json() as ErrorBody).error.code).toBe("NOT_FOUND");

      const unknown = await app.inject({ method: "GET", url: "/v1/products/nope/substitutes" });
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe("stock alerts", () => {
    async function customer() {
      const row = await factories.user("CUSTOMER");
      return { row, headers: authHeaders(row) };
    }

    it("requires auth (401) and rejects in-stock products (422)", async () => {
      const category = await seedCategory();
      const stocked = await seedProduct(category.id, { slug: "stocked", stockQty: 5 });

      const anon = await app.inject({ method: "POST", url: "/v1/products/stocked/stock-alert" });
      expect(anon.statusCode).toBe(401);

      const { headers } = await customer();
      const inStock = await app.inject({
        method: "POST",
        url: "/v1/products/stocked/stock-alert",
        headers,
      });
      expect(inStock.statusCode, inStock.body).toBe(422);
      expect((inStock.json() as ErrorBody).error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.stockAlert.count({ where: { productId: stocked.id } })).toBe(0);
    });

    it("subscribe → status → unsubscribe lifecycle, idempotent both ways", async () => {
      const category = await seedCategory();
      const product = await seedProduct(category.id, { slug: "oos", stockQty: 0 });
      const { row, headers } = await customer();

      const post = await app.inject({ method: "POST", url: "/v1/products/oos/stock-alert", headers });
      expect(post.statusCode, post.body).toBe(200);
      expect(post.headers["cache-control"]).toBe("no-store");
      expect((post.json() as AlertBody).data.subscribed).toBe(true);

      // Re-subscribe is an upsert — still one row.
      const again = await app.inject({ method: "POST", url: "/v1/products/oos/stock-alert", headers });
      expect(again.statusCode).toBe(200);
      expect(
        await prisma.stockAlert.count({ where: { userId: row.id, productId: product.id } }),
      ).toBe(1);

      const status = await app.inject({ method: "GET", url: "/v1/products/oos/stock-alert", headers });
      expect(status.statusCode).toBe(200);
      expect((status.json() as AlertBody).data.subscribed).toBe(true);

      const del = await app.inject({ method: "DELETE", url: "/v1/products/oos/stock-alert", headers });
      expect(del.statusCode).toBe(200);
      expect((del.json() as AlertBody).data.subscribed).toBe(false);
      expect(await prisma.stockAlert.count({ where: { userId: row.id } })).toBe(0);

      const after = await app.inject({ method: "GET", url: "/v1/products/oos/stock-alert", headers });
      expect((after.json() as AlertBody).data.subscribed).toBe(false);

      // Idempotent delete on a non-subscribed product.
      const delAgain = await app.inject({
        method: "DELETE",
        url: "/v1/products/oos/stock-alert",
        headers,
      });
      expect(delAgain.statusCode).toBe(200);

      const missing = await app.inject({
        method: "POST",
        url: "/v1/products/never-existed/stock-alert",
        headers,
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("restock notifications", () => {
    async function opsHeaders() {
      return authHeaders(await factories.user("INVENTORY"));
    }

    function grn(productId: string, headers: Record<string, string>, qty: number, tag: string) {
      return app.inject({
        method: "POST",
        url: `/v1/ops/products/${productId}/batches`,
        headers,
        payload: {
          batchNo: `B-${tag}`,
          expiryDate: ymd(200 * DAY_MS),
          qtyReceived: qty,
          costPaise: 4000,
          wholesaler: "Acme Distributors",
          invoiceNo: `INV-${tag}`,
        },
      });
    }

    it("0→N GRN notifies every subscriber, clears the waitlist, and does not re-fire on N→M", async () => {
      const category = await seedCategory();
      const product = await seedProduct(category.id, { slug: "waitlisted", stockQty: 0 });
      const alice = await factories.user("CUSTOMER");
      const bob = await factories.user("CUSTOMER");
      for (const u of [alice, bob]) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/products/waitlisted/stock-alert",
          headers: authHeaders(u),
        });
        expect(res.statusCode, res.body).toBe(200);
      }

      const ops = await opsHeaders();
      const received = await grn(product.id, ops, 10, "1");
      expect(received.statusCode, received.body).toBe(200);

      const notifications = await prisma.notification.findMany({
        where: { type: "PRODUCT_BACK_IN_STOCK" },
      });
      expect(notifications).toHaveLength(2);
      expect(notifications.map((n) => n.userId).sort()).toEqual([alice.id, bob.id].sort());
      expect(notifications[0]?.title).toBe("Back in stock");
      expect(notifications[0]?.body).toContain("available again");
      expect(notifications[0]?.data).toMatchObject({ productId: product.id, slug: "waitlisted" });
      // Waitlist cleared — a later restock must not double-notify.
      expect(await prisma.stockAlert.count({ where: { productId: product.id } })).toBe(0);

      const topUp = await grn(product.id, ops, 5, "2");
      expect(topUp.statusCode, topUp.body).toBe(200);
      expect(await prisma.notification.count({ where: { type: "PRODUCT_BACK_IN_STOCK" } })).toBe(2);
    });

    it("N→M GRN with a live subscription does NOT notify", async () => {
      const category = await seedCategory();
      const product = await seedProduct(category.id, { stockQty: 5 });
      const buyer = await factories.user("CUSTOMER");
      // Direct row: the API refuses in-stock subscribes, but a row can exist
      // legitimately (subscribed while OOS, restocked via order-cancel restock).
      await prisma.stockAlert.create({ data: { userId: buyer.id, productId: product.id } });

      const res = await grn(product.id, await opsHeaders(), 10, "3");
      expect(res.statusCode, res.body).toBe(200);

      expect(await prisma.notification.count({ where: { type: "PRODUCT_BACK_IN_STOCK" } })).toBe(0);
      expect(await prisma.stockAlert.count({ where: { productId: product.id } })).toBe(1);
    });

    it("positive stock adjustment 0→N notifies and clears; negative never fires", async () => {
      const category = await seedCategory();
      const product = await seedProduct(category.id, { slug: "adjusted", stockQty: 0 });
      const buyer = await factories.user("CUSTOMER");
      const subscribe = await app.inject({
        method: "POST",
        url: "/v1/products/adjusted/stock-alert",
        headers: authHeaders(buyer),
      });
      expect(subscribe.statusCode, subscribe.body).toBe(200);

      const ops = await opsHeaders();
      const up = await app.inject({
        method: "POST",
        url: "/v1/ops/stock/adjust",
        headers: ops,
        payload: { productId: product.id, delta: 3, reason: "CORRECTION" },
      });
      expect(up.statusCode, up.body).toBe(200);

      const notifications = await prisma.notification.findMany({
        where: { type: "PRODUCT_BACK_IN_STOCK" },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.userId).toBe(buyer.id);
      expect(await prisma.stockAlert.count({ where: { productId: product.id } })).toBe(0);

      // Down to zero and no subscribers — nothing new fires either way.
      const down = await app.inject({
        method: "POST",
        url: "/v1/ops/stock/adjust",
        headers: ops,
        payload: { productId: product.id, delta: -3, reason: "DAMAGE" },
      });
      expect(down.statusCode, down.body).toBe(200);
      expect(await prisma.notification.count({ where: { type: "PRODUCT_BACK_IN_STOCK" } })).toBe(1);
    });
  });
});
