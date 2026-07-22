import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Wishlist / favourites (Batch 3): add/remove idempotency, newest-first cursor
 * paging with live product data, cross-user isolation, delisted/unknown product
 * handling and the batched status lookup. Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c7_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { wishlistRoutes } = await import("../src/modules/wishlist/routes");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

/**
 * The module is registered in v1.ts by the integrator; until that lands the
 * test registers it itself, so this file passes on both sides of that edit.
 */
async function buildAppWithWishlist(): Promise<App> {
  const probe = await buildApp();
  await probe.ready();
  if (probe.hasRoute({ method: "GET", url: "/v1/wishlist" })) return probe;
  await probe.close();
  const built = await buildApp();
  await built.register(wishlistRoutes, { prefix: "/v1" });
  await built.ready();
  return built;
}

async function seedCustomer() {
  const customer = await user("CUSTOMER");
  return { customer, headers: authHeaders(customer) };
}

function add(headers: Record<string, string>, productId: string) {
  return app.inject({ method: "POST", url: "/v1/wishlist", headers, payload: { productId } });
}

function remove(headers: Record<string, string>, productId: string) {
  return app.inject({ method: "DELETE", url: `/v1/wishlist/${productId}`, headers });
}

function list(headers: Record<string, string>, query = "") {
  return app.inject({ method: "GET", url: `/v1/wishlist${query}`, headers });
}

function status(headers: Record<string, string>, productIds: string) {
  return app.inject({
    method: "GET",
    url: `/v1/wishlist/status?productIds=${productIds}`,
    headers,
  });
}

beforeAll(async () => {
  app = await buildAppWithWishlist();
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

describe("POST /v1/wishlist", () => {
  it("adds a product and is idempotent (one row, stable createdAt)", async () => {
    const { customer, headers } = await seedCustomer();
    const p = await product();

    const first = await add(headers, p.id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toEqual({ productId: p.id, wishlisted: true });
    expect(first.headers["cache-control"]).toBe("no-store");

    const row = await prisma.wishlist.findFirstOrThrow({ where: { userId: customer.id } });

    const second = await add(headers, p.id);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data).toEqual({ productId: p.id, wishlisted: true });

    const rows = await prisma.wishlist.findMany({ where: { userId: customer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(row.id);
    expect(rows[0]?.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  it("unknown or delisted product → 404, no row written", async () => {
    const { customer, headers } = await seedCustomer();
    const inactive = await product({ isActive: false });

    const unknown = await add(headers, "no-such-product-id");
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(unknown.json().error.code).toBe("NOT_FOUND");

    const delisted = await add(headers, inactive.id);
    expect(delisted.statusCode, delisted.body).toBe(404);
    expect(delisted.json().error.code).toBe("NOT_FOUND");

    expect(await prisma.wishlist.count({ where: { userId: customer.id } })).toBe(0);
  });

  it("rejects a malformed body (400) and anonymous callers (401)", async () => {
    const { headers } = await seedCustomer();

    const bad = await app.inject({ method: "POST", url: "/v1/wishlist", headers, payload: {} });
    expect(bad.statusCode, bad.body).toBe(400);

    const anon = await app.inject({
      method: "POST",
      url: "/v1/wishlist",
      payload: { productId: "x" },
    });
    expect(anon.statusCode, anon.body).toBe(401);
  });
});

describe("DELETE /v1/wishlist/:productId", () => {
  it("removes the entry and is idempotent (unknown product is a no-op success)", async () => {
    const { customer, headers } = await seedCustomer();
    const p = await product();
    await add(headers, p.id);

    const first = await remove(headers, p.id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toEqual({ productId: p.id, wishlisted: false });
    expect(await prisma.wishlist.count({ where: { userId: customer.id } })).toBe(0);

    const second = await remove(headers, p.id);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data).toEqual({ productId: p.id, wishlisted: false });

    const never = await remove(headers, "no-such-product-id");
    expect(never.statusCode, never.body).toBe(200);
    expect(never.json().data).toEqual({ productId: "no-such-product-id", wishlisted: false });
  });

  it("removes a delisted product's entry (no product lookup on the way out)", async () => {
    const { customer, headers } = await seedCustomer();
    const p = await product();
    await add(headers, p.id);
    await prisma.product.update({ where: { id: p.id }, data: { isActive: false } });

    const res = await remove(headers, p.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.wishlist.count({ where: { userId: customer.id } })).toBe(0);
  });
});

describe("GET /v1/wishlist", () => {
  it("returns newest-first entries with LIVE product summaries", async () => {
    const { headers } = await seedCustomer();
    const older = await product({ name: "Older Pick", pricePaise: 10_000 });
    const newer = await product({ name: "Newer Pick" });
    await add(headers, older.id);
    await add(headers, newer.id);

    // Price/stock move after saving — the list must reflect the catalog, not a snapshot.
    await prisma.product.update({
      where: { id: older.id },
      data: { pricePaise: 8_000, stockQty: 0 },
    });

    const res = await list(headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      data: { id: string; createdAt: string; product: Record<string, unknown> }[];
      meta: { nextCursor: string | null };
    };
    expect(body.data.map((e) => e.product.name)).toEqual(["Newer Pick", "Older Pick"]);
    expect(body.meta.nextCursor).toBeNull();
    expect(body.data[1]?.product.pricePaise).toBe(8_000);
    expect(body.data[1]?.product.inStock).toBe(false);
    expect(body.data[0]?.product.inStock).toBe(true);
    // Raw stock is never exposed on the customer surface.
    expect(body.data[0]?.product).not.toHaveProperty("stockQty");
    expect(typeof body.data[0]?.createdAt).toBe("string");
  });

  it("cursor-pages newest-first without repeats", async () => {
    const { headers } = await seedCustomer();
    const names = ["A", "B", "C"];
    for (const name of names) {
      const p = await product({ name });
      await add(headers, p.id);
    }

    const page1 = await list(headers, "?limit=2");
    expect(page1.statusCode, page1.body).toBe(200);
    expect(page1.json().data.map((e: { product: { name: string } }) => e.product.name)).toEqual([
      "C",
      "B",
    ]);
    const cursor = page1.json().meta.nextCursor as string;
    expect(cursor).toBeTruthy();

    const page2 = await list(headers, `?limit=2&cursor=${cursor}`);
    expect(page2.statusCode, page2.body).toBe(200);
    expect(page2.json().data.map((e: { product: { name: string } }) => e.product.name)).toEqual([
      "A",
    ]);
    expect(page2.json().meta.nextCursor).toBeNull();
  });

  it("hides entries whose product was delisted (the row survives)", async () => {
    const { customer, headers } = await seedCustomer();
    const p = await product();
    await add(headers, p.id);
    await prisma.product.update({ where: { id: p.id }, data: { isActive: false } });

    const res = await list(headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(await prisma.wishlist.count({ where: { userId: customer.id } })).toBe(1);
  });

  it("rejects a bad limit (400), anonymous (401) and non-customer roles (403)", async () => {
    const { headers } = await seedCustomer();

    const bad = await list(headers, "?limit=0");
    expect(bad.statusCode, bad.body).toBe(400);

    const anon = await app.inject({ method: "GET", url: "/v1/wishlist" });
    expect(anon.statusCode, anon.body).toBe(401);

    const driver = await user("DRIVER");
    const forbidden = await list(authHeaders(driver));
    expect(forbidden.statusCode, forbidden.body).toBe(403);
  });
});

describe("GET /v1/wishlist/status", () => {
  it("answers one entry per requested id, in order, deduped", async () => {
    const { headers } = await seedCustomer();
    const saved = await product();
    const notSaved = await product();
    await add(headers, saved.id);

    const res = await status(headers, `${notSaved.id},${saved.id},${saved.id},unknown-id`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([
      { productId: notSaved.id, wishlisted: false },
      { productId: saved.id, wishlisted: true },
      { productId: "unknown-id", wishlisted: false },
    ]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("ignores blank segments and reports a delisted product as not wishlisted", async () => {
    const { headers } = await seedCustomer();
    const p = await product();
    await add(headers, p.id);
    await prisma.product.update({ where: { id: p.id }, data: { isActive: false } });

    const res = await status(headers, `,${p.id},,`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([{ productId: p.id, wishlisted: false }]);
  });

  it("accepts 100 ids and rejects 101 with 422", async () => {
    const { headers } = await seedCustomer();
    const p = await product();
    await add(headers, p.id);

    const filler = (count: number) => Array.from({ length: count }, (_, i) => `pad-${i}`);

    const atCap = await status(headers, [p.id, ...filler(99)].join(","));
    expect(atCap.statusCode, atCap.body).toBe(200);
    expect(atCap.json().data).toHaveLength(100);
    expect(atCap.json().data[0]).toEqual({ productId: p.id, wishlisted: true });

    const overCap = await status(headers, [p.id, ...filler(100)].join(","));
    expect(overCap.statusCode, overCap.body).toBe(422);
    expect(overCap.json().error.code).toBe("VALIDATION_ERROR");
    expect(overCap.json().error.details).toEqual({ max: 100, received: 101 });
  });

  it("requires productIds (400) and authentication (401)", async () => {
    const { headers } = await seedCustomer();

    const missing = await app.inject({ method: "GET", url: "/v1/wishlist/status", headers });
    expect(missing.statusCode, missing.body).toBe(400);

    const anon = await app.inject({ method: "GET", url: "/v1/wishlist/status?productIds=x" });
    expect(anon.statusCode, anon.body).toBe(401);
  });
});

describe("cross-user isolation", () => {
  it("one customer never sees or mutates another's wishlist", async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const shared = await product({ name: "Shared" });
    const onlyB = await product({ name: "Only B" });

    await add(a.headers, shared.id);
    await add(b.headers, shared.id);
    await add(b.headers, onlyB.id);

    const listA = await list(a.headers);
    expect(listA.json().data.map((e: { product: { name: string } }) => e.product.name)).toEqual([
      "Shared",
    ]);

    const statusA = await status(a.headers, `${shared.id},${onlyB.id}`);
    expect(statusA.json().data).toEqual([
      { productId: shared.id, wishlisted: true },
      { productId: onlyB.id, wishlisted: false },
    ]);

    // B deleting the shared product only clears B's own row.
    const removed = await remove(b.headers, shared.id);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await prisma.wishlist.count({ where: { userId: a.customer.id } })).toBe(1);
    expect(
      await prisma.wishlist.count({ where: { userId: b.customer.id, productId: shared.id } }),
    ).toBe(0);

    // …and B cannot page into A's rows with A's cursor.
    const entryA = await prisma.wishlist.findFirstOrThrow({ where: { userId: a.customer.id } });
    const paged = await list(b.headers, `?cursor=${entryA.id}`);
    expect(paged.statusCode, paged.body).toBe(200);
    expect(
      (paged.json().data as { product: { name: string } }[]).every((e) => e.product.name !== "Shared"),
    ).toBe(true);
  });
});
