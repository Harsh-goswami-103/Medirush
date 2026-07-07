import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Admin marketing (Module D) integration tests (§7.2 admin rows): coupons CRUD
 * with contract validation + 409 dedupe + soft-deactivate, and store/flags
 * settings GET/PUT with cache-busting and per-change AuditLog. Real Postgres,
 * same P1 harness (env set before importing app).
 *
 * NOTE (see contractMismatches): the phase-3 brief says the coupon superRefine
 * failures surface as 422, but request-schema (zod) validation failures are
 * mapped to 400 VALIDATION_ERROR by the global error handler — identical to
 * store.int.test.ts and rx-review.int.test.ts. The tests assert the real 400.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache, getFlag } = await import("../src/core/flags");
const { bustStoreConfigCache, getStoreConfig } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY_MS = 86_400_000;

const prisma = getPrisma();
let app: App;

/** A valid CreateCouponBody (contract-clean); override per case. */
function couponBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    code: "SAVE10",
    kind: "PERCENT",
    valuePaiseOrPct: 10,
    minOrderPaise: 10_000,
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 7 * DAY_MS).toISOString(),
    ...overrides,
  };
}

async function admin() {
  const row = await user("ADMIN");
  return { row, headers: authHeaders(row) };
}

/** POST a coupon over HTTP, asserting 201, and return the created entity. */
async function createViaApi(headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/admin/coupons", headers, payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data as { id: string; code: string; redemptionCount: number; isActive: boolean };
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

describe("admin coupons", () => {
  it("creates a coupon (code uppercased, redemptionCount 0) and audit-logs it", async () => {
    const { row, headers } = await admin();

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/coupons",
      headers,
      payload: couponBody({ code: "WELCOME5", kind: "FLAT", valuePaiseOrPct: 5_000 }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    expect(data.code).toBe("WELCOME5");
    expect(data.kind).toBe("FLAT");
    expect(data.valuePaiseOrPct).toBe(5_000);
    expect(data.redemptionCount).toBe(0);
    expect(data.isActive).toBe(true);

    const dbCoupon = await prisma.coupon.findUniqueOrThrow({ where: { code: "WELCOME5" } });
    expect(dbCoupon.id).toBe(data.id);

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Coupon", entityId: data.id, action: "COUPON_CREATE", actorId: row.id },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a PERCENT coupon over 100 → 400 VALIDATION_ERROR (contract superRefine)", async () => {
    const { headers } = await admin();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/coupons",
      headers,
      payload: couponBody({ code: "BADPCT", kind: "PERCENT", valuePaiseOrPct: 150 }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.coupon.count()).toBe(0);
  });

  it("rejects endsAt ≤ startsAt → 400 VALIDATION_ERROR (contract superRefine)", async () => {
    const { headers } = await admin();
    const now = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/coupons",
      headers,
      payload: couponBody({
        code: "BADWIN",
        startsAt: new Date(now + DAY_MS).toISOString(),
        endsAt: new Date(now).toISOString(),
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.coupon.count()).toBe(0);
  });

  it("rejects a duplicate code → 409 CONFLICT", async () => {
    const { headers } = await admin();
    await createViaApi(headers, couponBody({ code: "DUPE10" }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/coupons",
      headers,
      payload: couponBody({ code: "DUPE10", kind: "FLAT", valuePaiseOrPct: 2_000 }),
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(await prisma.coupon.count()).toBe(1);
  });

  it("PATCH updates fields and audit-logs the change", async () => {
    const { row, headers } = await admin();
    const created = await createViaApi(headers, couponBody({ code: "EDIT10" }));

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/coupons/${created.id}`,
      headers,
      payload: { valuePaiseOrPct: 25, minOrderPaise: 20_000, isActive: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.valuePaiseOrPct).toBe(25);
    expect(data.minOrderPaise).toBe(20_000);
    expect(data.isActive).toBe(false);

    const dbCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: created.id } });
    expect(dbCoupon.valuePaiseOrPct).toBe(25);
    expect(dbCoupon.isActive).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Coupon", entityId: created.id, action: "COUPON_UPDATE", actorId: row.id },
    });
    expect(audit).not.toBeNull();
  });

  it("PATCH re-checks PERCENT ≤ 100 on the merged row → 422", async () => {
    const { headers } = await admin();
    const created = await createViaApi(headers, couponBody({ code: "PCT10", valuePaiseOrPct: 10 }));

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/admin/coupons/${created.id}`,
      headers,
      payload: { valuePaiseOrPct: 150 },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    // Unchanged.
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: created.id } })).valuePaiseOrPct,
    ).toBe(10);
  });

  it("PATCH on a missing coupon → 404", async () => {
    const { headers } = await admin();
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/admin/coupons/does-not-exist",
      headers,
      payload: { minOrderPaise: 5_000 },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("DELETE deactivates the coupon but preserves redemption history + audit-logs", async () => {
    const { row, headers } = await admin();
    const created = await createViaApi(headers, couponBody({ code: "KEEPME1" }));
    await prisma.couponRedemption.create({
      data: { couponId: created.id, userId: "cust-1", orderId: "order-1" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/admin/coupons/${created.id}`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.ok).toBe(true);

    const dbCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: created.id } });
    expect(dbCoupon.isActive).toBe(false);
    // Redemption history survives the soft-delete.
    expect(await prisma.couponRedemption.count({ where: { couponId: created.id } })).toBe(1);

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Coupon", entityId: created.id, action: "COUPON_DEACTIVATE", actorId: row.id },
    });
    expect(audit).not.toBeNull();
  });

  it("lists coupons newest-first, filters by active, and reports redemptionCount", async () => {
    const { headers } = await admin();
    const first = await createViaApi(headers, couponBody({ code: "ALPHA1" }));
    await createViaApi(headers, couponBody({ code: "BRAVO2" }));
    const third = await createViaApi(headers, couponBody({ code: "CHARLIE3" }));

    // One redemption against ALPHA1.
    await prisma.couponRedemption.create({
      data: { couponId: first.id, userId: "cust-9", orderId: "order-9" },
    });
    // Deactivate CHARLIE3 so the active filter has something to exclude.
    await app.inject({ method: "DELETE", url: `/v1/admin/coupons/${third.id}`, headers });

    const all = await app.inject({ method: "GET", url: "/v1/admin/coupons", headers });
    expect(all.statusCode, all.body).toBe(200);
    const allBody = all.json();
    expect(allBody.data).toHaveLength(3);
    expect(allBody.meta.nextCursor).toBeNull();
    const alpha = allBody.data.find((c: { code: string }) => c.code === "ALPHA1");
    expect(alpha.redemptionCount).toBe(1);

    const activeOnly = await app.inject({
      method: "GET",
      url: "/v1/admin/coupons?active=true",
      headers,
    });
    expect(activeOnly.statusCode, activeOnly.body).toBe(200);
    const activeCodes = activeOnly.json().data.map((c: { code: string }) => c.code);
    expect(activeCodes).toHaveLength(2);
    expect(activeCodes).not.toContain("CHARLIE3");

    const inactiveOnly = await app.inject({
      method: "GET",
      url: "/v1/admin/coupons?active=false",
      headers,
    });
    expect(inactiveOnly.json().data).toHaveLength(1);
    expect(inactiveOnly.json().data[0].code).toBe("CHARLIE3");
  });

  it("cursor-paginates the coupon list", async () => {
    const { headers } = await admin();
    await createViaApi(headers, couponBody({ code: "PAGE001" }));
    await createViaApi(headers, couponBody({ code: "PAGE002" }));
    await createViaApi(headers, couponBody({ code: "PAGE003" }));

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/admin/coupons?limit=2",
      headers,
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().data).toHaveLength(2);
    const cursor = firstPage.json().meta.nextCursor;
    expect(cursor).not.toBeNull();

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/admin/coupons?limit=2&cursor=${cursor}`,
      headers,
    });
    expect(secondPage.json().data).toHaveLength(1);
    expect(secondPage.json().meta.nextCursor).toBeNull();

    // No overlap across pages.
    const firstIds = firstPage.json().data.map((c: { id: string }) => c.id);
    expect(firstIds).not.toContain(secondPage.json().data[0].id);
  });

  it("sets a no-store cache header on coupon reads", async () => {
    const { headers } = await admin();
    const res = await app.inject({ method: "GET", url: "/v1/admin/coupons", headers });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("admin settings", () => {
  it("GET returns store settings + feature flags", async () => {
    const { headers } = await admin();
    const res = await app.inject({ method: "GET", url: "/v1/admin/settings", headers });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;

    // Store half mirrors the seeded StoreConfig; the internal id is not leaked.
    expect(data.store.name).toBe("MedRush Test Store");
    expect(data.store.minOrderPaise).toBe(9_900);
    expect(data.store.isOpen).toBe(true);
    expect(data.store).not.toHaveProperty("id");

    // Flags half mirrors the seeded AppSetting rows (scalar values).
    expect(data.flags.cod_enabled).toBe(true);
    expect(data.flags.new_account_cod_cap).toBe(50_000);
  });

  it("PUT partially updates store + flags, busts caches, and audit-logs each change", async () => {
    const { row, headers } = await admin();

    // Prime the in-process caches with the seeded values.
    expect((await getStoreConfig()).minOrderPaise).toBe(9_900);
    expect(await getFlag("cod_enabled", false)).toBe(true);

    const res = await app.inject({
      method: "PUT",
      url: "/v1/admin/settings",
      headers,
      payload: {
        store: { minOrderPaise: 15_000, supportPhone: "+918888888888" },
        flags: { cod_enabled: false, new_account_cod_cap: 25_000 },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.store.minOrderPaise).toBe(15_000);
    expect(data.store.supportPhone).toBe("+918888888888");
    // Untouched store field is preserved.
    expect(data.store.name).toBe("MedRush Test Store");
    expect(data.flags.cod_enabled).toBe(false);
    expect(data.flags.new_account_cod_cap).toBe(25_000);

    // Persisted to Postgres.
    const dbConfig = await prisma.storeConfig.findUniqueOrThrow({ where: { id: "store" } });
    expect(dbConfig.minOrderPaise).toBe(15_000);
    const flagRow = await prisma.appSetting.findUniqueOrThrow({ where: { key: "cod_enabled" } });
    expect(flagRow.value).toBe(false);
    expect(flagRow.updatedBy).toBe(row.id);

    // Caches were busted → cache-backed reads observe the new values at once.
    expect((await getStoreConfig()).minOrderPaise).toBe(15_000);
    expect(await getFlag("cod_enabled", true)).toBe(false);

    // One AuditLog per change: store + 2 flags.
    const audits = await prisma.auditLog.findMany({ where: { actorId: row.id } });
    expect(audits.filter((a) => a.action === "SETTINGS_STORE_UPDATE")).toHaveLength(1);
    expect(audits.filter((a) => a.action === "SETTINGS_FLAG_UPDATE")).toHaveLength(2);
  });

  it("PUT with only flags leaves the store untouched", async () => {
    const { headers } = await admin();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/admin/settings",
      headers,
      payload: { flags: { maintenance_banner: true } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.flags.maintenance_banner).toBe(true);
    // Store unchanged.
    expect(res.json().data.store.minOrderPaise).toBe(9_900);
    expect(
      await prisma.auditLog.count({ where: { action: "SETTINGS_STORE_UPDATE" } }),
    ).toBe(0);
  });
});

describe("admin marketing RBAC", () => {
  it("rejects a CUSTOMER on coupons with 403", async () => {
    const customer = await user("CUSTOMER");
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/coupons",
      headers: authHeaders(customer),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects an INVENTORY (ops) user on settings with 403 — ADMIN only", async () => {
    const ops = await user("INVENTORY");
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/settings",
      headers: authHeaders(ops),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
