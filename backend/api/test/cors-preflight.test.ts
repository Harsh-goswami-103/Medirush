import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * CORS preflight regression (found by the e2e golden path, 2026-07-13).
 *
 * @fastify/cors v11 defaults Access-Control-Allow-Methods to GET,HEAD,POST,
 * which browser-blocks every cross-origin PUT/PATCH/DELETE — add-to-cart
 * (PUT /v1/cart/items), profile PATCH, address DELETE, ops mutations — while
 * every route-level integration test stays green (they never preflight).
 * These tests speak the browser's actual preflight protocol.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { loadConfig } = await import("../src/core/config");

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
const config = loadConfig();

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function preflight(method: string, origin: string) {
  return app.inject({
    method: "OPTIONS",
    url: "/v1/cart/items",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "authorization,content-type",
    },
  });
}

describe("CORS preflight", () => {
  it.each(["PUT", "PATCH", "DELETE", "POST", "GET"])(
    "allows %s from an allowlisted origin",
    async (method) => {
      const res = await preflight(method, config.WEB_ORIGIN);
      expect(res.statusCode).toBe(204);
      const allowed = String(res.headers["access-control-allow-methods"]);
      expect(allowed).toContain(method);
      expect(res.headers["access-control-allow-origin"]).toBe(config.WEB_ORIGIN);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    },
  );

  it("rejects a preflight from a non-allowlisted origin", async () => {
    const res = await preflight("PUT", "https://evil.example");
    expect(res.statusCode).toBe(403);
  });

  it("exposes x-request-id on actual cross-origin responses (support-code toasts)", async () => {
    // Non-OPTIONS request: without Access-Control-Expose-Headers a browser
    // hides every non-safelisted response header from cross-origin JS, so the
    // web apps' "Support code: <x-request-id>" toasts would render empty.
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: config.WEB_ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(config.WEB_ORIGIN);
    expect(String(res.headers["access-control-expose-headers"])).toContain("x-request-id");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
