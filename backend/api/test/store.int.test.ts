import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Env must be set BEFORE the app is imported (config parses eagerly on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { StoreInfoSchema } = await import("@medrush/contracts");
const { buildApp } = await import("../src/app");
const { disconnectPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { devToken } = await import("./helpers/auth");
const { storeConfig } = await import("./helpers/factories");

type App = Awaited<ReturnType<typeof buildApp>>;

// Store pinned at a known point (Bangalore) with a 5km radius.
const STORE = { lat: 12.9716, lng: 77.5946, serviceRadiusM: 5000, deliveryBasePaise: 2000 };
// ~1.1 km from the store → inside the radius.
const NEAR = { lat: 12.98, lng: 77.6 };
// ~14.3 km due north → far outside the radius.
const FAR = { lat: 13.1, lng: 77.5946 };

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("store", () => {
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
    // In-process 60s caches must not leak DB state across truncations.
    clearAuthCaches();
    bustStoreConfigCache();
    bustFlagCache();
  });

  describe("GET /v1/store (public)", () => {
    it("returns the contract StoreInfo shape with flags and the §12 cache header", async () => {
      await storeConfig({ ...STORE });

      const res = await app.inject({ method: "GET", url: "/v1/store" }); // no auth header
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, s-maxage=60, stale-while-revalidate=300");

      const data = (res.json() as { data: unknown }).data;
      const parsed = StoreInfoSchema.safeParse(data);
      expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.lat).toBe(STORE.lat);
      expect(parsed.data.lng).toBe(STORE.lng);
      expect(parsed.data.serviceRadiusM).toBe(STORE.serviceRadiusM);
      expect(parsed.data.deliveryBasePaise).toBe(STORE.deliveryBasePaise);
      expect(typeof parsed.data.featureFlags.codEnabled).toBe("boolean");
      expect(parsed.data.minDriverAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(parsed.data.minCustomerAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("POST /v1/serviceability", () => {
    async function syncCustomer(): Promise<Record<string, string>> {
      const token = devToken("uid-serviceability", "+919812345678");
      const sync = await app.inject({
        method: "POST",
        url: "/v1/auth/sync",
        headers: bearer(token),
        payload: {},
      });
      expect(sync.statusCode).toBe(200);
      return bearer(token);
    }

    it("requires auth → 401 without a token", async () => {
      await storeConfig({ ...STORE });
      const res = await app.inject({ method: "POST", url: "/v1/serviceability", payload: NEAR });
      expect(res.statusCode).toBe(401);
    });

    it("point inside the radius → serviceable with the base fee", async () => {
      await storeConfig({ ...STORE });
      const headers = await syncCustomer();

      const res = await app.inject({
        method: "POST",
        url: "/v1/serviceability",
        headers,
        payload: NEAR,
      });
      expect(res.statusCode).toBe(200);
      const data = (res.json() as {
        data: { serviceable: boolean; distanceM: number; deliveryPaise: number | null };
      }).data;

      expect(data.serviceable).toBe(true);
      expect(data.deliveryPaise).toBe(STORE.deliveryBasePaise);
      // Haversine sanity: NEAR is ~1.1km out (well inside 5km).
      expect(data.distanceM).toBeGreaterThan(800);
      expect(data.distanceM).toBeLessThan(1500);
      expect(Number.isInteger(data.distanceM)).toBe(true);
    });

    it("point outside the radius → not serviceable, null fee", async () => {
      await storeConfig({ ...STORE });
      const headers = await syncCustomer();

      const res = await app.inject({
        method: "POST",
        url: "/v1/serviceability",
        headers,
        payload: FAR,
      });
      expect(res.statusCode).toBe(200);
      const data = (res.json() as {
        data: { serviceable: boolean; distanceM: number; deliveryPaise: number | null };
      }).data;

      expect(data.serviceable).toBe(false);
      expect(data.deliveryPaise).toBeNull();
      // FAR is ~14.3km due north — far beyond the 5km radius.
      expect(data.distanceM).toBeGreaterThan(STORE.serviceRadiusM);
    });

    it("rejects an out-of-range body → 400 VALIDATION_ERROR", async () => {
      await storeConfig({ ...STORE });
      const headers = await syncCustomer();

      const res = await app.inject({
        method: "POST",
        url: "/v1/serviceability",
        headers,
        payload: { lat: 123, lng: 77.6 },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    });
  });
});
