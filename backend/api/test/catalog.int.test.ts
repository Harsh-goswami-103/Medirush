import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

// Env before app import — config parses eagerly. `??=` so CI/dev URLs win.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

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
    data: { name: `Category ${seq}`, slug: `category-${seq}`, sortOrder: seq, ...overrides },
  });
}

async function seedProduct(
  categoryId: string,
  overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.product.create({
    data: {
      name: `Product ${seq}`,
      slug: `product-${seq}`,
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
  slug: string;
  inStock: boolean;
  imageUrl: string | null;
}
interface ListBody {
  data: ProductCard[];
  meta: { nextCursor: string | null };
}

describe("catalog endpoints", () => {
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

  it("GET /v1/categories → actives only, ordered by sortOrder, cacheable", async () => {
    const second = await seedCategory({ sortOrder: 20 });
    const first = await seedCategory({
      sortOrder: 10,
      imageUrl: "https://cdn.example.com/cat.jpg",
    });
    await seedCategory({ sortOrder: 5, isActive: false });

    const res = await app.inject({ method: "GET", url: "/v1/categories" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE);

    const body = res.json() as {
      data: Array<{ id: string; sortOrder: number; imageUrl: string | null }>;
    };
    expect(body.data.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(body.data[0]?.imageUrl).toBe("https://cdn.example.com/cat.jpg");
    expect(body.data[1]?.imageUrl).toBeNull();
  });

  it("GET /v1/products → lists only active products with keyset paging", async () => {
    const category = await seedCategory();
    const active = [
      await seedProduct(category.id),
      await seedProduct(category.id),
      await seedProduct(category.id),
    ];
    const inactive = await seedProduct(category.id, { isActive: false });

    const page1 = await app.inject({ method: "GET", url: "/v1/products?limit=2" });
    expect(page1.statusCode).toBe(200);
    expect(page1.headers["cache-control"]).toBe(PUBLIC_CACHE);
    const body1 = page1.json() as ListBody;
    expect(body1.data).toHaveLength(2);
    // Cursor rule: keyset over id ASC — nextCursor is the last id of the page.
    expect(body1.meta.nextCursor).toBe(body1.data[1]?.id);

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/products?limit=2&cursor=${body1.meta.nextCursor}`,
    });
    const body2 = page2.json() as ListBody;
    expect(body2.data).toHaveLength(1);
    expect(body2.meta.nextCursor).toBeNull();

    const seen = [...body1.data, ...body2.data].map((p) => p.id).sort();
    expect(seen).toEqual(active.map((p) => p.id).sort());
    expect(seen).not.toContain(inactive.id);
  });

  it("search finds products by composition keyword (trgm), actives only", async () => {
    const category = await seedCategory();
    const dolo = await seedProduct(category.id, {
      name: "Dolo 650",
      composition: "Paracetamol 650mg",
    });
    const unrelated = await seedProduct(category.id, {
      name: "Benadryl Syrup",
      composition: "Diphenhydramine 25mg",
    });
    const inactiveMatch = await seedProduct(category.id, {
      name: "Calpol 500",
      composition: "Paracetamol 500mg",
      isActive: false,
    });

    const res = await app.inject({ method: "GET", url: "/v1/products?search=paracetamol" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    const ids = body.data.map((p) => p.id);
    expect(ids).toContain(dolo.id);
    expect(ids).not.toContain(unrelated.id);
    expect(ids).not.toContain(inactiveMatch.id);
    // Search results are top-N only in Phase 1 — never a cursor.
    expect(body.meta.nextCursor).toBeNull();
  });

  it("search matches a short query against a REALISTIC long doc (word similarity)", async () => {
    // Regression: `doc % q` used WHOLE-STRING similarity — a short query
    // against a production-shaped doc (name + brand + composition + long
    // searchKeywords) scores ~0.07, far below the 0.3 threshold, so every
    // realistic query returned zero rows. Word similarity is the correct
    // pg_trgm mode here (exact word "dolo" inside the doc scores 1.0).
    const category = await seedCategory();
    const dolo = await seedProduct(category.id, {
      name: "Dolo 650 Tablet",
      brand: "Micro Labs",
      composition: "Paracetamol 650mg",
      searchKeywords: "paracetamol acetaminophen fever headache bodyache pain relief bukhar",
    });
    const unrelated = await seedProduct(category.id, {
      name: "Volini Pain Relief Gel 75g",
      brand: "Sun Pharma",
      composition: "Diclofenac Diethylamine",
      searchKeywords: "sprain muscle pain gel topical",
    });

    // The exact brand-name word customers actually type.
    const byName = await app.inject({ method: "GET", url: "/v1/products?search=dolo" });
    expect(byName.statusCode).toBe(200);
    const nameIds = (byName.json() as ListBody).data.map((p) => p.id);
    expect(nameIds).toContain(dolo.id);
    expect(nameIds).not.toContain(unrelated.id);

    // A close-miss typo should still fuzzy-match the composition word.
    const typo = await app.inject({ method: "GET", url: "/v1/products?search=paracetmol" });
    expect(typo.statusCode).toBe(200);
    expect((typo.json() as ListBody).data.map((p) => p.id)).toContain(dolo.id);
  });

  it("short search (<3 chars) falls back to name-prefix match", async () => {
    const category = await seedCategory();
    const dolo = await seedProduct(category.id, { name: "Dolo 650" });
    const other = await seedProduct(category.id, { name: "Crocin Advance" });

    const res = await app.inject({ method: "GET", url: "/v1/products?search=do" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.data.map((p) => p.id)).toContain(dolo.id);
    expect(body.data.map((p) => p.id)).not.toContain(other.id);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("category filter returns only that category's products; unknown slug → empty", async () => {
    const pharma = await seedCategory({ slug: "pharma" });
    const wellness = await seedCategory({ slug: "wellness" });
    const inPharma = await seedProduct(pharma.id);
    await seedProduct(wellness.id);

    const res = await app.inject({ method: "GET", url: "/v1/products?category=pharma" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.data.map((p) => p.id)).toEqual([inPharma.id]);

    const unknown = await app.inject({ method: "GET", url: "/v1/products?category=no-such" });
    expect(unknown.statusCode).toBe(200);
    expect((unknown.json() as ListBody).data).toEqual([]);
  });

  it("GET /v1/products/:slug → detail for active, 404 for inactive/unknown", async () => {
    const category = await seedCategory();
    await seedProduct(category.id, {
      name: "Dolo 650",
      slug: "dolo-650",
      composition: "Paracetamol 650mg",
      images: ["https://cdn.example.com/dolo-1.jpg", "https://cdn.example.com/dolo-2.jpg"],
      stockQty: 4,
    });
    await seedProduct(category.id, { slug: "ghost-product", isActive: false });

    const ok = await app.inject({ method: "GET", url: "/v1/products/dolo-650" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe(PUBLIC_CACHE);
    const detail = (
      ok.json() as {
        data: {
          slug: string;
          composition: string;
          gstRatePct: number;
          categoryId: string;
          imageUrl: string | null;
          images: string[];
          inStock: boolean;
        };
      }
    ).data;
    expect(detail.slug).toBe("dolo-650");
    expect(detail.composition).toBe("Paracetamol 650mg");
    expect(detail.gstRatePct).toBe(12);
    expect(detail.categoryId).toBe(category.id);
    expect(detail.imageUrl).toBe("https://cdn.example.com/dolo-1.jpg");
    expect(detail.images).toHaveLength(2);
    expect(detail.inStock).toBe(true);

    const inactive = await app.inject({ method: "GET", url: "/v1/products/ghost-product" });
    expect(inactive.statusCode).toBe(404);
    expect((inactive.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    const unknown = await app.inject({ method: "GET", url: "/v1/products/never-existed" });
    expect(unknown.statusCode).toBe(404);
  });
});
