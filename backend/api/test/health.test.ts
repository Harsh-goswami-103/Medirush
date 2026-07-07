import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Env must be set BEFORE the app (config/logger parse eagerly on import).
// The DATABASE_URL points at a closed local port — no running Postgres needed;
// /readyz's SELECT 1 fails fast with ECONNREFUSED. Plain assignment (not ??=):
// CI injects a live DATABASE_URL for integration tests, and this suite's
// no-database readiness path must stay deterministic regardless.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://medrush:medrush@127.0.0.1:5499/medrush_test";

const { buildApp } = await import("../src/app");
const { disconnectPrisma } = await import("../src/core/db");

type App = Awaited<ReturnType<typeof buildApp>>;

describe("system endpoints", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnectPrisma();
  });

  it("GET /healthz → 200 with success envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { status: "ok" } });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("unknown route → 404 with NOT_FOUND error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/definitely-not-a-route" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });

  it("GET /readyz without a database → 503 with error envelope naming the check", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      error: { code: string; message: string; details: { failed: string[] } };
    };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toContain("database");
    expect(body.error.details.failed).toContain("database_unreachable");
    // pg-boss is intentionally not started in tests either
    expect(body.error.details.failed).toContain("jobs_not_started");
  });
});
