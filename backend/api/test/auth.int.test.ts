import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Env must be set BEFORE the app is imported (config parses eagerly on first use).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
// Force the dev-token verification path (`dev:<uid>:<phone>`, non-production only).
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches, invalidateUserCache } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { devToken } = await import("./helpers/auth");
const { storeConfig } = await import("./helpers/factories");

type App = Awaited<ReturnType<typeof buildApp>>;

const PHONE = "+919876543210";

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("auth (dev-token flow)", () => {
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

  it("POST /v1/auth/sync creates the user (role CUSTOMER) and /v1/me round-trips", async () => {
    const token = devToken("uid-sync-1", PHONE);

    const sync = await app.inject({
      method: "POST",
      url: "/v1/auth/sync",
      headers: bearer(token),
      payload: { name: "Asha" },
    });
    expect(sync.statusCode).toBe(200);
    const created = (sync.json() as { data: Record<string, unknown> }).data;
    expect(created["phone"]).toBe(PHONE);
    expect(created["role"]).toBe("CUSTOMER");
    expect(created["name"]).toBe("Asha");
    expect(typeof created["id"]).toBe("string");

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { data: { id: string } }).data.id).toBe(created["id"]);

    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: bearer(token),
      payload: { name: "Asha G" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { data: { name: string } }).data.name).toBe("Asha G");

    // sync is an upsert — a second call must not create a second row.
    const again = await app.inject({
      method: "POST",
      url: "/v1/auth/sync",
      headers: bearer(token),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { data: { id: string } }).data.id).toBe(created["id"]);
    expect(await getPrisma().user.count()).toBe(1);
  });

  it("no token → 401 UNAUTHENTICATED", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("valid token but never synced → 401 on non-allowUnsynced routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(devToken("uid-never-synced", "+919812340001")),
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("malformed dev token (bad phone) → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/sync",
      headers: bearer("dev:uid-x:12345"),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("blocked user → 403 FORBIDDEN even with a valid token", async () => {
    const uid = "uid-blocked";
    const token = devToken(uid, "+919812340002");
    const sync = await app.inject({
      method: "POST",
      url: "/v1/auth/sync",
      headers: bearer(token),
      payload: {},
    });
    expect(sync.statusCode).toBe(200);

    await getPrisma().user.update({ where: { firebaseUid: uid }, data: { isBlocked: true } });
    invalidateUserCache(uid); // block must take effect immediately, not after the 60s TTL

    const res = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("RBAC: customer calling an ops route → 403 FORBIDDEN", async () => {
    const token = devToken("uid-customer-rbac", "+919812340003");
    const sync = await app.inject({
      method: "POST",
      url: "/v1/auth/sync",
      headers: bearer(token),
      payload: {},
    });
    expect(sync.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/v1/ops/orders", headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  describe("driver app version gate (426, §7.1)", () => {
    it("missing x-app-version on /v1/driver/* → 426 UPGRADE_REQUIRED", async () => {
      await storeConfig(); // minDriverAppVersion defaults to 1.0.0
      const res = await app.inject({ method: "GET", url: "/v1/driver/active" });
      expect(res.statusCode).toBe(426);
      expect((res.json() as { error: { code: string } }).error.code).toBe("UPGRADE_REQUIRED");
    });

    it("outdated version → 426; current version passes the gate (falls through to 401)", async () => {
      await storeConfig();

      const outdated = await app.inject({
        method: "GET",
        url: "/v1/driver/active",
        headers: { "x-app-version": "0.9.9" },
      });
      expect(outdated.statusCode).toBe(426);

      const current = await app.inject({
        method: "GET",
        url: "/v1/driver/active",
        headers: { "x-app-version": "1.0.0" },
      });
      // Gate passed — the request reaches auth and fails there instead.
      expect(current.statusCode).toBe(401);
    });

    it("gate only applies to /v1/driver/* — customer routes ignore the header", async () => {
      await storeConfig();
      const res = await app.inject({ method: "GET", url: "/v1/store" });
      expect(res.statusCode).toBe(200);
    });
  });
});
