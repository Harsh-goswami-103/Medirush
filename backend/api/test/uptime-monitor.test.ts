import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uptime self-check (§24 observability): the config gate (dev/CI never alert),
 * the default local `/readyz` target, the failure → webhook + no-throw path,
 * and the alert-fatigue rule (page on entering failure, then every 6th
 * consecutive failure, plus one recovery line). Outbound HTTP is stubbed —
 * nothing here touches the network.
 */

// Env must be set BEFORE src modules load (config parses eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
process.env.UPTIME_ALERT_WEBHOOK_URL = "https://hooks.example.invalid/services/xyz";
delete process.env.UPTIME_CHECK_URL;

const { loadConfig, resetConfigForTests } = await import("../src/core/config");
const {
  isUptimeMonitorConfigured,
  resetUptimeStateForTests,
  runUptimeCheck,
  uptimeCheckUrl,
} = await import("../src/jobs/uptimeMonitor");

const base = { DATABASE_URL: "postgresql://postgres@localhost:5433/medrush_test" };
const WEBHOOK = "https://hooks.example.invalid/services/xyz";

const okFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn().mockResolvedValue(new Response("ready", { status: 200 }));

/** Stub that fails the check GET but accepts the alert POST. */
const downFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return new Response("ok", { status: 200 });
    throw new Error("ECONNREFUSED");
  });

const alertPosts = (fetchMock: ReturnType<typeof vi.fn>): unknown[] =>
  fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST");

describe("uptime-monitor gating", () => {
  it("is unconfigured without an alert webhook", () => {
    expect(isUptimeMonitorConfigured(loadConfig(base))).toBe(false);
    expect(isUptimeMonitorConfigured(loadConfig({ ...base, UPTIME_ALERT_WEBHOOK_URL: WEBHOOK }))).toBe(
      true,
    );
  });

  it("defaults the check target to the local readiness probe", () => {
    expect(uptimeCheckUrl(loadConfig({ ...base, PORT: "4100" }))).toBe("http://127.0.0.1:4100/readyz");
    expect(
      uptimeCheckUrl(loadConfig({ ...base, UPTIME_CHECK_URL: "https://api.example.invalid/readyz" })),
    ).toBe("https://api.example.invalid/readyz");
  });

  it("runUptimeCheck is a silent no-op when unconfigured (no request at all)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.UPTIME_ALERT_WEBHOOK_URL;
    resetConfigForTests();
    try {
      const result = await runUptimeCheck();
      expect(result.skipped).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.UPTIME_ALERT_WEBHOOK_URL = WEBHOOK;
      resetConfigForTests();
      vi.unstubAllGlobals();
    }
  });
});

describe("uptime-monitor checks", () => {
  beforeEach(() => {
    resetUptimeStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetUptimeStateForTests();
  });

  it("a healthy check records the timing and alerts nobody", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runUptimeCheck();
    expect(result).toMatchObject({ skipped: false, ok: true, status: 200, alerted: false });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    // Only the check GET — bounded by an outbound deadline, no webhook POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/readyz",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("a failing check POSTs the webhook and never throws", async () => {
    const fetchMock = downFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runUptimeCheck();
    expect(result).toMatchObject({ ok: false, consecutiveFailures: 1, alerted: true });

    const posts = alertPosts(fetchMock);
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(JSON.parse(String(init.body))).toEqual({ text: expect.stringContaining("ECONNREFUSED") });
  });

  it("a non-2xx readiness response counts as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return new Response("ok", { status: 200 });
        return new Response("not ready", { status: 503 });
      }),
    );

    const result = await runUptimeCheck();
    expect(result).toMatchObject({ ok: false, status: 503, alerted: true });
  });

  it("a dead alert webhook is swallowed (the monitor must not crash)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("EHOSTUNREACH")));
    await expect(runUptimeCheck()).resolves.toMatchObject({ ok: false, alerted: true });
  });
});

describe("uptime-monitor alert fatigue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetUptimeStateForTests();
  });

  it("pages on entering failure, then only every 6th consecutive failure", async () => {
    resetUptimeStateForTests();
    const fetchMock = downFetch();
    vi.stubGlobal("fetch", fetchMock);

    const alerted: boolean[] = [];
    for (let i = 0; i < 13; i += 1) {
      alerted.push((await runUptimeCheck()).alerted === true);
    }
    // failures 1, 6 and 12 page (~ now, +30 min, +60 min); the rest are logs only.
    expect(alerted).toEqual([
      true, false, false, false, false, true, false, false, false, false, false, true, false,
    ]);
    expect(alertPosts(fetchMock)).toHaveLength(3);
  });

  it("sends one recovery line after an outage, and nothing on a steady green", async () => {
    resetUptimeStateForTests();
    const fetchMock = downFetch();
    vi.stubGlobal("fetch", fetchMock);
    await runUptimeCheck();
    expect(alertPosts(fetchMock)).toHaveLength(1);

    const healthy = okFetch();
    vi.stubGlobal("fetch", healthy);
    const recovery = await runUptimeCheck();
    expect(recovery).toMatchObject({ ok: true, consecutiveFailures: 0, alerted: true });
    const posts = alertPosts(healthy);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0] as [string, RequestInit])[1].body))).toEqual({
      text: expect.stringContaining("recovered"),
    });

    // Next healthy pass is quiet again.
    const steady = okFetch();
    vi.stubGlobal("fetch", steady);
    expect((await runUptimeCheck()).alerted).toBe(false);
    expect(alertPosts(steady)).toHaveLength(0);
  });
});
