import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Customer coupons (feature-gap Batch 2): GET /v1/coupons public offers list,
 * POST /v1/coupons/validate quote against the caller's server cart, and the
 * admin description/isPublic passthrough. Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const prisma = getPrisma();
let app: App;

/** Direct-DB coupon seed: FLAT ₹10 off, open window, public. Override per case. */
async function coupon(code: string, overrides: Partial<Prisma.CouponUncheckedCreateInput> = {}) {
  return prisma.coupon.create({
    data: {
      code,
      kind: "FLAT",
      valuePaiseOrPct: 1_000,
      minOrderPaise: 0,
      startsAt: new Date(Date.now() - HOUR_MS),
      endsAt: new Date(Date.now() + DAY_MS),
      isActive: true,
      isPublic: true,
      ...overrides,
    },
  });
}

/** A CUSTOMER whose server cart holds one line per `{ pricePaise, qty }` entry. */
async function seedCustomerWithCart(lines: { pricePaise: number; qty: number }[]) {
  const customer = await user("CUSTOMER");
  const cart = await prisma.cart.create({ data: { userId: customer.id } });
  for (const line of lines) {
    const p = await product({ pricePaise: line.pricePaise });
    await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: line.qty } });
  }
  return { customer, headers: authHeaders(customer) };
}

function postValidate(headers: Record<string, string>, code: string) {
  return app.inject({ method: "POST", url: "/v1/coupons/validate", headers, payload: { code } });
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
  await storeConfig(); // minOrder 9_900, delivery 2_000, free above 49_900
  await appSettings();
});

describe("GET /v1/coupons", () => {
  it("lists only active+public+in-window coupons, endsAt ASC, cacheable", async () => {
    await coupon("PUBLIC-LATER", {
      endsAt: new Date(Date.now() + 2 * DAY_MS),
      description: "₹10 off any order",
    });
    await coupon("PUBLIC-SOON", { endsAt: new Date(Date.now() + DAY_MS) });
    await coupon("PRIVATE1", { isPublic: false });
    await coupon("EXPIRED1", {
      startsAt: new Date(Date.now() - 2 * DAY_MS),
      endsAt: new Date(Date.now() - DAY_MS),
    });
    await coupon("INACTIVE1", { isActive: false });
    await coupon("FUTURE1", {
      startsAt: new Date(Date.now() + DAY_MS),
      endsAt: new Date(Date.now() + 2 * DAY_MS),
    });

    const res = await app.inject({ method: "GET", url: "/v1/coupons" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe(PUBLIC_CACHE);

    const body = res.json() as {
      data: Array<Record<string, unknown> & { code: string; description: string | null }>;
    };
    expect(body.data.map((c) => c.code)).toEqual(["PUBLIC-SOON", "PUBLIC-LATER"]);
    expect(body.data[1]?.description).toBe("₹10 off any order");
    expect(body.data[0]?.description).toBeNull();
    // Admin-only fields never leak onto the customer surface.
    expect(body.data[0]).not.toHaveProperty("usageLimit");
    expect(body.data[0]).not.toHaveProperty("perUserLimit");
    expect(body.data[0]).not.toHaveProperty("id");
  });
});

describe("POST /v1/coupons/validate", () => {
  it("FLAT happy path → quote from the server cart (code uppercased)", async () => {
    const { headers } = await seedCustomerWithCart([{ pricePaise: 10_000, qty: 2 }]);
    await coupon("FLAT50", { kind: "FLAT", valuePaiseOrPct: 5_000 });

    const res = await postValidate(headers, "flat50");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({
      code: "FLAT50",
      discountPaise: 5_000,
      itemsPaise: 20_000,
      deliveryPaise: 2_000, // 20_000 < freeDeliveryAbove 49_900
      totalPaise: 17_000,
    });
  });

  it("PERCENT is floored and capped by maxDiscountPaise", async () => {
    const { headers } = await seedCustomerWithCart([{ pricePaise: 10_000, qty: 2 }]);
    await coupon("PCT10CAP", { kind: "PERCENT", valuePaiseOrPct: 10, maxDiscountPaise: 1_500 });

    const res = await postValidate(headers, "PCT10CAP");
    expect(res.statusCode, res.body).toBe(200);
    // 10% of 20_000 = 2_000 → capped at 1_500.
    expect(res.json().data).toEqual({
      code: "PCT10CAP",
      discountPaise: 1_500,
      itemsPaise: 20_000,
      deliveryPaise: 2_000,
      totalPaise: 20_500,
    });
  });

  it("unknown and expired codes → 422 COUPON_INVALID", async () => {
    const { headers } = await seedCustomerWithCart([{ pricePaise: 10_000, qty: 2 }]);
    await coupon("EXPIRED1", {
      startsAt: new Date(Date.now() - 2 * DAY_MS),
      endsAt: new Date(Date.now() - DAY_MS),
    });

    const unknown = await postValidate(headers, "NOSUCH1");
    expect(unknown.statusCode, unknown.body).toBe(422);
    expect(unknown.json().error.code).toBe("COUPON_INVALID");

    const expired = await postValidate(headers, "EXPIRED1");
    expect(expired.statusCode, expired.body).toBe(422);
    expect(expired.json().error.code).toBe("COUPON_INVALID");
  });

  it("empty cart → 422 COUPON_INVALID before any coupon lookup", async () => {
    const customer = await user("CUSTOMER"); // no cart rows at all
    await coupon("FLAT50", { kind: "FLAT", valuePaiseOrPct: 5_000 });

    const res = await postValidate(authHeaders(customer), "FLAT50");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("COUPON_INVALID");
    expect(res.json().error.message).toBe("Your cart is empty");
  });

  it("cart below the store minimum → 422 MIN_ORDER_NOT_MET", async () => {
    const { headers } = await seedCustomerWithCart([{ pricePaise: 5_000, qty: 1 }]);
    await coupon("FLAT50", { kind: "FLAT", valuePaiseOrPct: 5_000 });

    const res = await postValidate(headers, "FLAT50");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("MIN_ORDER_NOT_MET");
  });

  it("requires customer auth → 401 without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/coupons/validate",
      payload: { code: "FLAT50" },
    });
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("admin description/isPublic passthrough", () => {
  it("create round-trips description+isPublic and surfaces on GET /v1/coupons", async () => {
    const admin = await user("ADMIN");
    const headers = authHeaders(admin);

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/coupons",
      headers,
      payload: {
        code: "WELCOME50",
        kind: "FLAT",
        valuePaiseOrPct: 5_000,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
        description: "₹50 off your first order",
        isPublic: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data.description).toBe("₹50 off your first order");
    expect(created.json().data.isPublic).toBe(true);

    const row = await prisma.coupon.findUniqueOrThrow({ where: { code: "WELCOME50" } });
    expect(row.description).toBe("₹50 off your first order");
    expect(row.isPublic).toBe(true);

    const listed = await app.inject({ method: "GET", url: "/v1/coupons" });
    expect(listed.json().data.map((c: { code: string }) => c.code)).toEqual(["WELCOME50"]);
    expect(listed.json().data[0].description).toBe("₹50 off your first order");

    // Defaults: omitted fields land as null / false (admin list echoes them).
    const bare = await app.inject({
      method: "POST",
      url: "/v1/admin/coupons",
      headers,
      payload: {
        code: "QUIET10",
        kind: "PERCENT",
        valuePaiseOrPct: 10,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      },
    });
    expect(bare.statusCode, bare.body).toBe(201);
    expect(bare.json().data.description).toBeNull();
    expect(bare.json().data.isPublic).toBe(false);

    // PATCH passthrough: flip isPublic off → drops off the public list.
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/admin/coupons/${row.id}`,
      headers,
      payload: { isPublic: false, description: "hidden again" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().data.isPublic).toBe(false);
    expect(patched.json().data.description).toBe("hidden again");

    const after = await app.inject({ method: "GET", url: "/v1/coupons" });
    expect(after.json().data).toEqual([]);
  });
});
