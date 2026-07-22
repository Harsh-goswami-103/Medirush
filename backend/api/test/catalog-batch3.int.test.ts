import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Batch 3 catalog surface: GET /v1/concerns (shop-by-health-concern browse),
 * the `concern` product filter on every search path, and the structured
 * medical info on the product detail. Real Postgres.
 */

// Env before app import — config parses eagerly. `??=` so CI/dev URLs win.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c8_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");

type App = Awaited<ReturnType<typeof buildApp>>;

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

const prisma = getPrisma();

let seq = 0;

async function seedCategory(overrides: Partial<Prisma.CategoryUncheckedCreateInput> = {}) {
  seq += 1;
  return prisma.category.create({
    data: { name: `B3 Category ${seq}`, slug: `b3-category-${seq}`, sortOrder: seq, ...overrides },
  });
}

async function seedConcern(overrides: Partial<Prisma.HealthConcernUncheckedCreateInput> = {}) {
  seq += 1;
  return prisma.healthConcern.create({
    data: { name: `B3 Concern ${seq}`, slug: `b3-concern-${seq}`, sortOrder: seq, ...overrides },
  });
}

async function seedProduct(
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.product.create({
    data: {
      name: `B3 Product ${seq}`,
      slug: `b3-product-${seq}`,
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

async function tag(productId: string, concernId: string) {
  await prisma.productHealthConcern.create({ data: { productId, concernId } });
}

interface ProductCard {
  id: string;
  name: string;
  pricePaise: number;
  inStock: boolean;
}
interface ListBody {
  data: ProductCard[];
  meta: { nextCursor: string | null };
}
interface ConcernCard {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  sortOrder: number;
}

describe("catalog batch 3", () => {
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
    // HealthConcern is not in the shared truncate list yet (test/helpers/db.ts is
    // owned elsewhere) — clear it here so listings are isolated per test.
    await prisma.productHealthConcern.deleteMany({});
    await prisma.healthConcern.deleteMany({});
  });

  async function list(query: string): Promise<ListBody> {
    const res = await app.inject({ method: "GET", url: `/v1/products?${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as ListBody;
  }

  describe("GET /v1/concerns", () => {
    it("lists active concerns by sortOrder, cacheable, image key → URL", async () => {
      const fever = await seedConcern({ name: "Fever", slug: "fever", sortOrder: 1 });
      const diabetes = await seedConcern({
        name: "Diabetes Care",
        slug: "diabetes-care",
        sortOrder: 2,
        imageUrl: "https://cdn.example.com/concerns/diabetes.png",
      });
      await seedConcern({ name: "Hidden", slug: "hidden", sortOrder: 0, isActive: false });

      const res = await app.inject({ method: "GET", url: "/v1/concerns" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE);

      const body = res.json() as { data: ConcernCard[] };
      expect(body.data.map((c) => c.id)).toEqual([fever.id, diabetes.id]);
      expect(body.data[0]).toEqual({
        id: fever.id,
        name: "Fever",
        slug: "fever",
        imageUrl: null,
        sortOrder: 1,
      });
      expect(body.data[1]?.imageUrl).toBe("https://cdn.example.com/concerns/diabetes.png");
      // Ops-only column never leaks onto the public browse surface.
      expect(body.data[0]).not.toHaveProperty("isActive");
    });

    it("is public (no auth) and returns an empty list when nothing is configured", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/concerns" });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { data: ConcernCard[] }).data).toEqual([]);
    });
  });

  describe("GET /v1/products?concern", () => {
    it("filters the plain listing to the concern's products", async () => {
      const category = await seedCategory();
      const fever = await seedConcern({ slug: "fever" });
      const cold = await seedConcern({ slug: "cold" });
      const dolo = await seedProduct(category.id);
      const crocin = await seedProduct(category.id);
      const cough = await seedProduct(category.id);
      await tag(dolo.id, fever.id);
      await tag(crocin.id, fever.id);
      await tag(cough.id, cold.id);

      const res = await list("concern=fever");
      expect(res.data.map((p) => p.id).sort()).toEqual([dolo.id, crocin.id].sort());
      expect((await list("concern=cold")).data.map((p) => p.id)).toEqual([cough.id]);
    });

    it("never duplicates a product tagged with several concerns", async () => {
      const category = await seedCategory();
      const fever = await seedConcern({ slug: "fever" });
      const pain = await seedConcern({ slug: "pain" });
      const dolo = await seedProduct(category.id);
      await tag(dolo.id, fever.id);
      await tag(dolo.id, pain.id);

      expect((await list("concern=fever")).data.map((p) => p.id)).toEqual([dolo.id]);
    });

    it("unknown or inactive concern slug → empty page (filter semantics, not 404)", async () => {
      const category = await seedCategory();
      const retired = await seedConcern({ slug: "retired", isActive: false });
      const product = await seedProduct(category.id);
      await tag(product.id, retired.id);

      const unknown = await app.inject({ method: "GET", url: "/v1/products?concern=nope" });
      expect(unknown.statusCode, unknown.body).toBe(200);
      expect(unknown.headers["cache-control"]).toBe(PUBLIC_CACHE);
      expect((unknown.json() as ListBody).data).toEqual([]);

      const inactive = await list("concern=retired");
      expect(inactive.data).toEqual([]);
      expect(inactive.meta.nextCursor).toBeNull();
    });

    it("excludes inactive products and composes with category", async () => {
      const catA = await seedCategory({ slug: "b3-cat-a" });
      const catB = await seedCategory({ slug: "b3-cat-b" });
      const fever = await seedConcern({ slug: "fever" });
      const inA = await seedProduct(catA.id);
      const inB = await seedProduct(catB.id);
      const gone = await seedProduct(catA.id, { isActive: false });
      for (const p of [inA, inB, gone]) await tag(p.id, fever.id);

      expect((await list("concern=fever")).data.map((p) => p.id).sort()).toEqual(
        [inA.id, inB.id].sort(),
      );
      expect((await list("concern=fever&category=b3-cat-a")).data.map((p) => p.id)).toEqual([inA.id]);
      // Category that has no product in this concern → empty, not a 404.
      const catC = await seedCategory({ slug: "b3-cat-c" });
      await seedProduct(catC.id);
      expect((await list("concern=fever&category=b3-cat-c")).data).toEqual([]);
    });

    it("composes with keyset pagination on the plain listing", async () => {
      const category = await seedCategory();
      const fever = await seedConcern({ slug: "fever" });
      const first = await seedProduct(category.id);
      const second = await seedProduct(category.id);
      const other = await seedProduct(category.id);
      await tag(first.id, fever.id);
      await tag(second.id, fever.id);

      const ordered = [first.id, second.id].sort();
      const page1 = await list("concern=fever&limit=1");
      expect(page1.data.map((p) => p.id)).toEqual([ordered[0]]);
      expect(page1.meta.nextCursor).toBe(ordered[0]);

      const page2 = await list(`concern=fever&limit=1&cursor=${page1.meta.nextCursor ?? ""}`);
      expect(page2.data.map((p) => p.id)).toEqual([ordered[1]]);
      expect(page2.meta.nextCursor).toBeNull();
      // The untagged row is never reachable through the concern filter.
      expect(page2.data.map((p) => p.id)).not.toContain(other.id);
    });

    it("composes with the trgm search path and with other filters", async () => {
      const category = await seedCategory();
      const fever = await seedConcern({ slug: "fever" });
      const dolo = await seedProduct(category.id, {
        name: "Dolo 650",
        composition: "Paracetamol 650mg",
        pricePaise: 2000,
        stockQty: 10,
      });
      const calpol = await seedProduct(category.id, {
        name: "Calpol 500",
        composition: "Paracetamol 500mg",
        pricePaise: 9000,
        stockQty: 0,
      });
      const untagged = await seedProduct(category.id, {
        name: "Pacimol 650",
        composition: "Paracetamol 650mg",
        pricePaise: 2500,
      });
      await tag(dolo.id, fever.id);
      await tag(calpol.id, fever.id);

      const searched = await list("concern=fever&search=paracetamol");
      expect(searched.data.map((p) => p.id).sort()).toEqual([dolo.id, calpol.id].sort());
      expect(searched.data.map((p) => p.id)).not.toContain(untagged.id);
      expect(searched.meta.nextCursor).toBeNull();

      expect(
        (await list("concern=fever&search=paracetamol&inStock=true")).data.map((p) => p.id),
      ).toEqual([dolo.id]);
      expect(
        (await list("concern=fever&search=paracetamol&maxPricePaise=5000")).data.map((p) => p.id),
      ).toEqual([dolo.id]);
    });

    it("composes with the short-query prefix path", async () => {
      const category = await seedCategory();
      const fever = await seedConcern({ slug: "fever" });
      const dolo = await seedProduct(category.id, { name: "Dolo 650" });
      const doxy = await seedProduct(category.id, { name: "Doxy 100" });
      await tag(dolo.id, fever.id);

      // 2 chars → ILIKE 'do%' prefix path (below the trgm threshold).
      const res = await list("concern=fever&search=do");
      expect(res.data.map((p) => p.id)).toEqual([dolo.id]);
      expect(res.data.map((p) => p.id)).not.toContain(doxy.id);
    });

    it("composes with an explicit sort (raw top-N path)", async () => {
      const category = await seedCategory();
      const fever = await seedConcern({ slug: "fever" });
      const dear = await seedProduct(category.id, { pricePaise: 9000 });
      const cheap = await seedProduct(category.id, { pricePaise: 1000 });
      const cheapestUntagged = await seedProduct(category.id, { pricePaise: 100 });
      await tag(dear.id, fever.id);
      await tag(cheap.id, fever.id);

      const asc = await list("concern=fever&sort=price_asc");
      expect(asc.data.map((p) => p.id)).toEqual([cheap.id, dear.id]);
      expect(asc.data.map((p) => p.id)).not.toContain(cheapestUntagged.id);
      expect(asc.meta.nextCursor).toBeNull();

      expect((await list("concern=fever&sort=price_desc")).data.map((p) => p.id)).toEqual([
        dear.id,
        cheap.id,
      ]);
      // Sorted + searched together still honours the concern.
      expect(
        (await list("concern=fever&search=b3&sort=price_asc")).data.map((p) => p.id),
      ).toEqual([cheap.id, dear.id]);
    });

    it("rejects a malformed concern slug with 400 VALIDATION_ERROR", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/products?concern=Not%20A%20Slug" });
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /v1/products/:slug medical info", () => {
    it("exposes the structured medical fields on the detail payload", async () => {
      const category = await seedCategory();
      await seedProduct(category.id, {
        slug: "dolo-650-b3",
        uses: "Fever and mild to moderate pain.",
        directions: "One tablet after food, up to 3 times a day.",
        sideEffects: "Nausea, rash.",
        storageInfo: "Store below 30°C, away from light.",
        warnings: "Do not exceed 4g of paracetamol in 24 hours.",
        manufacturer: "Micro Labs Ltd",
      });

      const res = await app.inject({ method: "GET", url: "/v1/products/dolo-650-b3" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE);
      expect(res.json().data).toMatchObject({
        uses: "Fever and mild to moderate pain.",
        directions: "One tablet after food, up to 3 times a day.",
        sideEffects: "Nausea, rash.",
        storageInfo: "Store below 30°C, away from light.",
        warnings: "Do not exceed 4g of paracetamol in 24 hours.",
        manufacturer: "Micro Labs Ltd",
      });
    });

    it("undocumented fields come back as empty strings / null manufacturer", async () => {
      const category = await seedCategory();
      await seedProduct(category.id, { slug: "bare-b3" });

      const res = await app.inject({ method: "GET", url: "/v1/products/bare-b3" });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({
        uses: "",
        directions: "",
        sideEffects: "",
        storageInfo: "",
        warnings: "",
        manufacturer: null,
      });
    });
  });
});
