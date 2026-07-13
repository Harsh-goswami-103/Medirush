import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proxy-trust + rate-limit key derivation (Phase 7 §10 hardening).
 *
 * With `trustProxy: true` a client controls `request.ip` by prefixing its own
 * X-Forwarded-For entries — a free bypass of every per-IP rate limit. With
 * TRUST_PROXY_HOPS=1 only the single edge proxy is trusted: the derived ip is
 * the entry the PROXY appended (the real client), never the client's own
 * prefix. No DB required — routes here are injected test routes.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
process.env.TRUST_PROXY_HOPS = "1";
delete process.env.RATE_LIMIT_TRUST_CF_HEADER;
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp, rateLimitKeyFor } = await import("../src/app");
const { loadConfig, resetConfigForTests } = await import("../src/core/config");

type App = Awaited<ReturnType<typeof buildApp>>;

/** Direct peer (the edge proxy in production; the injecting test here). */
const PROXY_ADDR = "203.0.113.9";
/** The real client address, appended to XFF by the trusted proxy. */
const REAL_CLIENT = "198.51.100.7";
/** Attacker-chosen XFF prefix — must never become request.ip. */
const SPOOFED = "6.6.6.6";

function addTestRoutes(app: App): void {
  app.get("/__test/ip", { config: { public: true, rateLimit: false } }, async (request) => ({
    data: { ip: request.ip, ips: request.ips ?? null },
  }));
  app.get(
    "/__test/limited",
    { config: { public: true, rateLimit: { max: 2, timeWindow: 60_000 } } },
    async () => ({ data: { ok: true } }),
  );
}

/* -------------------------------------------- hops-based proxy trust */

describe("TRUST_PROXY_HOPS=1 — spoofed XFF prefixes cannot move request.ip", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildApp();
    addTestRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("derives request.ip from the trusted hop's XFF entry, not the client's prefix", async () => {
    // The attacker sent `X-Forwarded-For: 6.6.6.6`; the (trusted) edge proxy
    // appended the real client → "6.6.6.6, 198.51.100.7".
    const res = await app.inject({
      method: "GET",
      url: "/__test/ip",
      remoteAddress: PROXY_ADDR,
      headers: { "x-forwarded-for": `${SPOOFED}, ${REAL_CLIENT}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { ip, ips } = res.json().data as { ip: string; ips: string[] };
    expect(ip).toBe(REAL_CLIENT);
    expect(ip).not.toBe(SPOOFED);
    // The walk stops after the trusted hop — the spoofed prefix is never reached.
    expect(ips).toEqual([PROXY_ADDR, REAL_CLIENT]);
  });

  it("falls back to the socket address when no XFF header is present", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__test/ip",
      remoteAddress: PROXY_ADDR,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.ip).toBe(PROXY_ADDR);
  });

  it("rate-limit key ignores CF-Connecting-IP while RATE_LIMIT_TRUST_CF_HEADER is off", async () => {
    const shoot = (cf: string) =>
      app.inject({
        method: "GET",
        url: "/__test/limited",
        remoteAddress: PROXY_ADDR,
        headers: { "cf-connecting-ip": cf },
      });

    expect((await shoot("9.9.9.9")).statusCode).toBe(200);
    expect((await shoot("9.9.9.9")).statusCode).toBe(200);
    // Rotating the untrusted header must NOT mint a fresh bucket.
    const third = await shoot("8.8.8.8");
    expect(third.statusCode, third.body).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
  });
});

/* ------------------------------------------------ CF-header keyed mode */

describe("RATE_LIMIT_TRUST_CF_HEADER=true — CF-Connecting-IP becomes the key", () => {
  let app: App;

  beforeAll(async () => {
    resetConfigForTests();
    process.env.RATE_LIMIT_TRUST_CF_HEADER = "true";
    delete process.env.TRUST_PROXY_HOPS; // dev/test default trust stays `true`
    app = await buildApp();
    addTestRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.RATE_LIMIT_TRUST_CF_HEADER;
    resetConfigForTests();
  });

  it("buckets by CF-Connecting-IP: same header throttles, different header does not", async () => {
    const shoot = (cf: string) =>
      app.inject({
        method: "GET",
        url: "/__test/limited",
        remoteAddress: PROXY_ADDR,
        headers: { "cf-connecting-ip": cf },
      });

    expect((await shoot("1.1.1.1")).statusCode).toBe(200);
    expect((await shoot("1.1.1.1")).statusCode).toBe(200);
    expect((await shoot("1.1.1.1")).statusCode).toBe(429);
    // Same socket address, different CF header → separate bucket (CF is the
    // perimeter; the socket address is just Cloudflare's egress).
    expect((await shoot("2.2.2.2")).statusCode).toBe(200);
  });
});

/* ------------------------------------------------------- key derivation */

describe("proxy-trust config keys (unit)", () => {
  const DB_URL = "postgresql://medrush:medrush@localhost:5432/medrush";

  it("both keys are optional; RATE_LIMIT_TRUST_CF_HEADER defaults false", () => {
    const config = loadConfig({ DATABASE_URL: DB_URL });
    expect(config.TRUST_PROXY_HOPS).toBeUndefined();
    expect(config.RATE_LIMIT_TRUST_CF_HEADER).toBe(false);
  });

  it("parses TRUST_PROXY_HOPS as an int and the CF flag as a boolean string", () => {
    const config = loadConfig({
      DATABASE_URL: DB_URL,
      TRUST_PROXY_HOPS: "2",
      RATE_LIMIT_TRUST_CF_HEADER: "true",
    });
    expect(config.TRUST_PROXY_HOPS).toBe(2);
    expect(config.RATE_LIMIT_TRUST_CF_HEADER).toBe(true);
  });

  it("rejects a non-integer hop count", () => {
    expect(() => loadConfig({ DATABASE_URL: DB_URL, TRUST_PROXY_HOPS: "1.5" })).toThrowError(
      /TRUST_PROXY_HOPS/,
    );
  });
});

describe("rateLimitKeyFor (unit)", () => {
  it("prefers CF-Connecting-IP only when trusted, else request.ip", () => {
    const withCf = { ip: "10.0.0.1", headers: { "cf-connecting-ip": "9.9.9.9" } };
    expect(rateLimitKeyFor(withCf, true)).toBe("9.9.9.9");
    expect(rateLimitKeyFor(withCf, false)).toBe("10.0.0.1");
  });

  it("ignores missing, empty and array-valued headers", () => {
    expect(rateLimitKeyFor({ ip: "10.0.0.1", headers: {} }, true)).toBe("10.0.0.1");
    expect(rateLimitKeyFor({ ip: "10.0.0.1", headers: { "cf-connecting-ip": "" } }, true)).toBe(
      "10.0.0.1",
    );
    expect(
      rateLimitKeyFor({ ip: "10.0.0.1", headers: { "cf-connecting-ip": ["9.9.9.9"] } }, true),
    ).toBe("10.0.0.1");
  });
});
