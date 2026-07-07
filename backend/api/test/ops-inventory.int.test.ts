import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Ops inventory management integration tests (§7.2, phase-3 brief). Real
 * Postgres. Products/categories CRUD, GRN batch receipt, signed stock adjust
 * (never-negative guard), low-stock + near-expiry alerts, and RBAC.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const factories = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY_MS = 86_400_000;
const ymd = (msFromNow: number): string =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 10);

const prisma = getPrisma();
let app: App;

/** Fresh INVENTORY operator + its bearer header (unique per call). */
async function inventory(): Promise<{ id: string; headers: Record<string, string> }> {
  const user = await factories.user("INVENTORY");
  return { id: user.id, headers: authHeaders(user) };
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
  await factories.storeConfig();
  await factories.appSettings();
});

describe("ops products CRUD", () => {
  it("creates a product: slug from name, price ≤ MRP, no-store header, audit row", async () => {
    const { id: actorId, headers } = await inventory();
    const category = await prisma.category.create({ data: { name: "Pain", slug: "pain" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ops/products",
      headers,
      payload: {
        name: "Crocin Advance 500",
        categoryId: category.id,
        mrpPaise: 5000,
        pricePaise: 4500,
        gstRatePct: 12,
        packSize: "Strip of 15",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const product = res.json().data;
    expect(product.slug).toBe("crocin-advance-500");
    expect(product.pricePaise).toBe(4500);
    expect(product.isActive).toBe(true);

    const audit = await prisma.auditLog.findMany({
      where: { entity: "Product", entityId: product.id, action: "PRODUCT_CREATED" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(actorId);
  });

  it("auto-suffixes a colliding generated slug", async () => {
    const { headers } = await inventory();
    const category = await prisma.category.create({ data: { name: "Pain", slug: "pain-2" } });
    const body = {
      name: "Crocin Advance 500",
      categoryId: category.id,
      mrpPaise: 5000,
      pricePaise: 4500,
      gstRatePct: 12,
      packSize: "Strip of 15",
    };

    const first = await app.inject({ method: "POST", url: "/v1/ops/products", headers, payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/ops/products", headers, payload: body });
    expect(first.json().data.slug).toBe("crocin-advance-500");
    expect(second.json().data.slug).toBe("crocin-advance-500-2");
  });

  it("rejects price > MRP on create via the frozen contract (400)", async () => {
    const { headers } = await inventory();
    const category = await prisma.category.create({ data: { name: "Pain", slug: "pain-3" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ops/products",
      headers,
      payload: {
        name: "Overpriced",
        categoryId: category.id,
        mrpPaise: 4000,
        pricePaise: 5000,
        gstRatePct: 12,
        packSize: "Strip of 10",
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("updates a product and re-checks merged price ≤ MRP (422), then soft-deletes", async () => {
    const { headers } = await inventory();
    const created = await factories.product({ pricePaise: 4500, mrpPaise: 5000 });

    // Merged pricePaise (6000) > merged mrpPaise (5000) → 422.
    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/ops/products/${created.id}`,
      headers,
      payload: { pricePaise: 6000 },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");

    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/ops/products/${created.id}`,
      headers,
      payload: { pricePaise: 4800 },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.pricePaise).toBe(4800);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/ops/products/${created.id}`,
      headers,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().data.ok).toBe(true);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: created.id } })).isActive).toBe(
      false,
    );
  });

  it("filters the list by category slug and isActive", async () => {
    const { headers } = await inventory();
    const active = await factories.product({ isActive: true });
    const inactive = await factories.product({ isActive: false });

    const res = await app.inject({
      method: "GET",
      url: "/v1/ops/products?isActive=false",
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).toContain(inactive.id);
    expect(ids).not.toContain(active.id);
    expect(res.json().meta).toHaveProperty("nextCursor");
  });
});

describe("ops categories CRUD", () => {
  it("creates (slug gen), updates, soft-deletes and lists categories", async () => {
    const { headers } = await inventory();

    const create = await app.inject({
      method: "POST",
      url: "/v1/ops/categories",
      headers,
      payload: { name: "Cold & Flu" },
    });
    expect(create.statusCode, create.body).toBe(200);
    const category = create.json().data;
    expect(category.slug).toBe("cold-flu");

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/ops/categories/${category.id}`,
      headers,
      payload: { sortOrder: 5 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().data.sortOrder).toBe(5);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/ops/categories/${category.id}`,
      headers,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: category.id } })).isActive).toBe(
      false,
    );

    const list = await app.inject({ method: "GET", url: "/v1/ops/categories", headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.some((c: { id: string }) => c.id === category.id)).toBe(true);
  });
});

describe("ops GRN batches", () => {
  it("receives a batch: bumps stock cache + writes a RECEIVED adjustment", async () => {
    const { headers } = await inventory();
    const product = await factories.product({ stock: 0 });

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/products/${product.id}/batches`,
      headers,
      payload: {
        batchNo: "B-100",
        expiryDate: ymd(200 * DAY_MS),
        qtyReceived: 50,
        costPaise: 4000,
        wholesaler: "Acme Distributors",
        invoiceNo: "INV-100",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.batch.qtyAvailable).toBe(50);
    expect(data.batch.qtyReceived).toBe(50);
    expect(data.product.stockQty).toBe(50);

    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty).toBe(50);
    const adjustments = await prisma.stockAdjustment.findMany({
      where: { productId: product.id, reason: "RECEIVED" },
    });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.delta).toBe(50);
    expect(adjustments[0]?.batchId).toBe(data.batch.id);
  });

  it("refuses a past expiry date (422)", async () => {
    const { headers } = await inventory();
    const product = await factories.product({ stock: 0 });

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/products/${product.id}/batches`,
      headers,
      payload: {
        batchNo: "B-OLD",
        expiryDate: ymd(-DAY_MS),
        qtyReceived: 10,
        costPaise: 4000,
        wholesaler: "Acme Distributors",
        invoiceNo: "INV-OLD",
      },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty).toBe(0);
  });
});

describe("ops stock adjust", () => {
  it("applies a signed delta and records the adjustment", async () => {
    const { headers } = await inventory();
    const product = await factories.product({ stock: 10 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ops/stock/adjust",
      headers,
      payload: { productId: product.id, delta: -3, reason: "DAMAGE" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.stockQty).toBe(7);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty).toBe(7);
    expect(
      await prisma.stockAdjustment.count({ where: { productId: product.id, reason: "DAMAGE" } }),
    ).toBe(1);
  });

  it("never drives stock negative — the guard aborts with 409, stock unchanged", async () => {
    const { headers } = await inventory();
    const product = await factories.product({ stock: 5 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ops/stock/adjust",
      headers,
      payload: { productId: product.id, delta: -100, reason: "CORRECTION" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty).toBe(5);
    expect(await prisma.stockAdjustment.count({ where: { productId: product.id } })).toBe(0);
  });

  it("optionally decrements a specific batch's qtyAvailable", async () => {
    const { headers } = await inventory();
    const product = await factories.product({ stock: 20 });
    const batch = await factories.batch(product.id, { qty: 20 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/ops/stock/adjust",
      headers,
      payload: { productId: product.id, batchId: batch.id, delta: -5, reason: "EXPIRY" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.stockQty).toBe(15);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } })).qtyAvailable).toBe(15);
  });
});

describe("ops stock alerts", () => {
  it("low-stock lists products at/below their threshold only", async () => {
    const { headers } = await inventory();
    const low = await factories.product({ stock: 5, lowStockThreshold: 10 });
    const atThreshold = await factories.product({ stock: 10, lowStockThreshold: 10 });
    const healthy = await factories.product({ stock: 50, lowStockThreshold: 10 });

    const res = await app.inject({ method: "GET", url: "/v1/ops/stock/low", headers });
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json().data.map((i: { productId: string }) => i.productId);
    expect(ids).toContain(low.id);
    expect(ids).toContain(atThreshold.id);
    expect(ids).not.toContain(healthy.id);
  });

  it("near-expiry lists batches with stock expiring within the window", async () => {
    const { headers } = await inventory();
    const product = await factories.product({ stock: 100 });
    const soon = await factories.batch(product.id, { batchNo: "SOON", expiryInDays: 20, qty: 30 });
    const far = await factories.batch(product.id, { batchNo: "FAR", expiryInDays: 200, qty: 30 });

    const res = await app.inject({
      method: "GET",
      url: "/v1/ops/stock/near-expiry?days=60",
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().data as Array<{ batchId: string; daysToExpiry: number }>;

    const soonItem = items.find((i) => i.batchId === soon.id);
    expect(soonItem).toBeTruthy();
    expect(soonItem?.daysToExpiry).toBeGreaterThanOrEqual(18);
    expect(soonItem?.daysToExpiry).toBeLessThanOrEqual(22);
    expect(items.find((i) => i.batchId === far.id)).toBeUndefined();
  });
});

describe("ops inventory RBAC", () => {
  it("rejects a CUSTOMER token with 403", async () => {
    const customer = await factories.user("CUSTOMER");
    const res = await app.inject({
      method: "GET",
      url: "/v1/ops/products",
      headers: authHeaders(customer),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
