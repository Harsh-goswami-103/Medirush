import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Refill reminders (Batch 3, §17 v1.1): owner-scoped CRUD over
 * /v1/refills plus the daily sweep that nudges + rolls the schedule forward.
 * Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c5_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");
const { runRefillReminderSweep, advanceDueDate, REFILL_NOTIFICATION_TYPE } = await import(
  "../src/jobs/refillReminder"
);

type App = Awaited<ReturnType<typeof buildApp>>;

const DAY_MS = 86_400_000;
const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);

const prisma = getPrisma();
let app: App;

function postRefill(headers: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/refills", headers, payload });
}

/** Seed a reminder row directly (the sweep's input state). */
async function reminder(
  userId: string,
  productId: string,
  overrides: { intervalDays?: number; nextDueAt?: Date; isActive?: boolean } = {},
) {
  return prisma.refillReminder.create({
    data: {
      userId,
      productId,
      intervalDays: overrides.intervalDays ?? 30,
      nextDueAt: overrides.nextDueAt ?? daysFromNow(-1),
      ...(overrides.isActive === undefined ? {} : { isActive: overrides.isActive }),
    },
  });
}

beforeAll(async () => {
  // refillRoutes is registered by modules/v1.ts — registering it again here
  // would trip FST_ERR_DUPLICATED_ROUTE.
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

describe("POST /v1/refills", () => {
  it("creates a reminder due intervalDays after startFrom, with the product summary", async () => {
    const customer = await user("CUSTOMER");
    const p = await product({ name: "Metformin 500" });
    const startFrom = new Date("2026-07-01T00:00:00.000Z");

    const res = await postRefill(authHeaders(customer), {
      productId: p.id,
      intervalDays: 30,
      startFrom: startFrom.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);

    const data = res.json().data;
    expect(data.intervalDays).toBe(30);
    expect(data.isActive).toBe(true);
    expect(data.lastNotifiedAt).toBeNull();
    expect(data.nextDueAt).toBe(new Date(startFrom.getTime() + 30 * DAY_MS).toISOString());
    expect(data.product.id).toBe(p.id);
    expect(data.product.name).toBe("Metformin 500");
    expect(data.product.inStock).toBe(true);
    // Customer-safe summary only — raw stock never leaks.
    expect(data.product).not.toHaveProperty("stockQty");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("defaults startFrom to now", async () => {
    const customer = await user("CUSTOMER");
    const p = await product();
    const before = Date.now();

    const res = await postRefill(authHeaders(customer), { productId: p.id, intervalDays: 7 });
    expect(res.statusCode, res.body).toBe(200);

    const due = new Date(res.json().data.nextDueAt).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(due).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
  });

  it("upserts by (user, product) and re-arms a paused reminder", async () => {
    const customer = await user("CUSTOMER");
    const p = await product();
    const existing = await reminder(customer.id, p.id, { intervalDays: 30, isActive: false });

    const res = await postRefill(authHeaders(customer), { productId: p.id, intervalDays: 14 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.id).toBe(existing.id);
    expect(res.json().data.intervalDays).toBe(14);
    expect(res.json().data.isActive).toBe(true);

    expect(await prisma.refillReminder.count({ where: { userId: customer.id } })).toBe(1);
  });

  it("two users may both have a reminder for the same product", async () => {
    const [a, b] = [await user("CUSTOMER"), await user("CUSTOMER")];
    const p = await product();

    expect((await postRefill(authHeaders(a), { productId: p.id, intervalDays: 30 })).statusCode).toBe(200);
    expect((await postRefill(authHeaders(b), { productId: p.id, intervalDays: 30 })).statusCode).toBe(200);
    expect(await prisma.refillReminder.count({ where: { productId: p.id } })).toBe(2);
  });

  it("unknown or inactive product → 404 NOT_FOUND", async () => {
    const customer = await user("CUSTOMER");
    const inactive = await product({ isActive: false });

    const unknown = await postRefill(authHeaders(customer), {
      productId: "no-such-product",
      intervalDays: 30,
    });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(unknown.json().error.code).toBe("NOT_FOUND");

    const off = await postRefill(authHeaders(customer), {
      productId: inactive.id,
      intervalDays: 30,
    });
    expect(off.statusCode, off.body).toBe(404);
    expect(await prisma.refillReminder.count()).toBe(0);
  });

  it("rejects out-of-range intervals and a missing productId → 400", async () => {
    const customer = await user("CUSTOMER");
    const p = await product();
    const headers = authHeaders(customer);

    expect((await postRefill(headers, { productId: p.id, intervalDays: 3 })).statusCode).toBe(400);
    expect((await postRefill(headers, { productId: p.id, intervalDays: 365 })).statusCode).toBe(400);
    expect((await postRefill(headers, { productId: p.id, intervalDays: 30.5 })).statusCode).toBe(400);
    expect((await postRefill(headers, { intervalDays: 30 })).statusCode).toBe(400);
    expect(
      (await postRefill(headers, { productId: p.id, intervalDays: 30, startFrom: "tomorrow" }))
        .statusCode,
    ).toBe(400);
  });

  it("requires customer auth → 401 without a token", async () => {
    const p = await product();
    const res = await app.inject({
      method: "POST",
      url: "/v1/refills",
      payload: { productId: p.id, intervalDays: 30 },
    });
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("GET /v1/refills", () => {
  it("lists only own reminders, soonest-due first", async () => {
    const [a, b] = [await user("CUSTOMER"), await user("CUSTOMER")];
    const [p1, p2, p3] = [await product(), await product(), await product()];
    const later = await reminder(a.id, p1.id, { nextDueAt: daysFromNow(20) });
    const sooner = await reminder(a.id, p2.id, { nextDueAt: daysFromNow(5) });
    await reminder(b.id, p3.id, { nextDueAt: daysFromNow(1) });

    const res = await app.inject({ method: "GET", url: "/v1/refills", headers: authHeaders(a) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((r: { id: string }) => r.id)).toEqual([sooner.id, later.id]);

    const other = await app.inject({ method: "GET", url: "/v1/refills", headers: authHeaders(b) });
    expect(other.json().data).toHaveLength(1);
    expect(other.json().data[0].id).not.toBe(later.id);
  });

  it("empty for a user with no reminders; 401 anonymous", async () => {
    const customer = await user("CUSTOMER");
    const mine = await app.inject({
      method: "GET",
      url: "/v1/refills",
      headers: authHeaders(customer),
    });
    expect(mine.json().data).toEqual([]);

    const anon = await app.inject({ method: "GET", url: "/v1/refills" });
    expect(anon.statusCode, anon.body).toBe(401);
  });
});

describe("DELETE /v1/refills/:id", () => {
  it("deletes an own reminder; a second delete is 404", async () => {
    const customer = await user("CUSTOMER");
    const row = await reminder(customer.id, (await product()).id);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/refills/${row.id}`,
      headers: authHeaders(customer),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
    expect(await prisma.refillReminder.count()).toBe(0);

    const again = await app.inject({
      method: "DELETE",
      url: `/v1/refills/${row.id}`,
      headers: authHeaders(customer),
    });
    expect(again.statusCode, again.body).toBe(404);
  });

  it("another user's reminder → 404 and the row survives", async () => {
    const [a, b] = [await user("CUSTOMER"), await user("CUSTOMER")];
    const row = await reminder(a.id, (await product()).id);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/refills/${row.id}`,
      headers: authHeaders(b),
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(await prisma.refillReminder.count({ where: { id: row.id } })).toBe(1);
  });

  it("401 anonymous", async () => {
    const customer = await user("CUSTOMER");
    const row = await reminder(customer.id, (await product()).id);
    const res = await app.inject({ method: "DELETE", url: `/v1/refills/${row.id}` });
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("advanceDueDate", () => {
  it("always lands strictly in the future, collapsing missed periods", () => {
    const now = new Date("2026-07-22T09:00:00.000Z");
    const justDue = new Date(now.getTime() - 1);
    expect(advanceDueDate(justDue, 30, now).getTime()).toBe(justDue.getTime() + 30 * DAY_MS);

    const exactlyNow = new Date(now);
    expect(advanceDueDate(exactlyNow, 7, now).getTime()).toBe(now.getTime() + 7 * DAY_MS);

    // Down for 3 full periods → one nudge, next slot still in the future.
    const stale = new Date(now.getTime() - 3 * 7 * DAY_MS);
    const next = advanceDueDate(stale, 7, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime()).toBe(stale.getTime() + 4 * 7 * DAY_MS);
  });
});

describe("refill-reminder sweep", () => {
  it("notifies the owner and rolls nextDueAt forward by the interval", async () => {
    const customer = await user("CUSTOMER");
    const p = await product({ name: "Telmisartan 40" });
    const dueAt = daysFromNow(-1);
    const row = await reminder(customer.id, p.id, { intervalDays: 30, nextDueAt: dueAt });

    const result = await runRefillReminderSweep();
    expect(result).toEqual({ due: 1, notified: 1, skipped: 0, failed: 0 });

    const notes = await prisma.notification.findMany({ where: { userId: customer.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe(REFILL_NOTIFICATION_TYPE);
    expect(notes[0]?.body).toContain("Telmisartan 40");
    expect(notes[0]?.data).toEqual({ productId: p.id, slug: p.slug });

    const after = await prisma.refillReminder.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.nextDueAt.getTime()).toBe(dueAt.getTime() + 30 * DAY_MS);
    expect(after.lastNotifiedAt).not.toBeNull();
    expect(after.isActive).toBe(true);
  });

  it("a second run the same day does not double-notify", async () => {
    const customer = await user("CUSTOMER");
    const row = await reminder(customer.id, (await product()).id, {
      intervalDays: 7,
      nextDueAt: daysFromNow(-1),
    });

    await runRefillReminderSweep();
    const first = await prisma.refillReminder.findUniqueOrThrow({ where: { id: row.id } });

    const second = await runRefillReminderSweep();
    expect(second).toEqual({ due: 0, notified: 0, skipped: 0, failed: 0 });
    expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(1);

    const unchanged = await prisma.refillReminder.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.nextDueAt.getTime()).toBe(first.nextDueAt.getTime());
  });

  it("leaves not-yet-due and inactive reminders untouched", async () => {
    const customer = await user("CUSTOMER");
    const future = await reminder(customer.id, (await product()).id, {
      nextDueAt: daysFromNow(5),
    });
    const paused = await reminder(customer.id, (await product()).id, {
      nextDueAt: daysFromNow(-2),
      isActive: false,
    });

    const result = await runRefillReminderSweep();
    expect(result).toEqual({ due: 0, notified: 0, skipped: 0, failed: 0 });
    expect(await prisma.notification.count()).toBe(0);

    for (const row of [future, paused]) {
      const after = await prisma.refillReminder.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.nextDueAt.getTime()).toBe(row.nextDueAt.getTime());
      expect(after.lastNotifiedAt).toBeNull();
    }
  });

  it("skips the nudge for a delisted product but still rolls the schedule", async () => {
    const customer = await user("CUSTOMER");
    const p = await product({ isActive: false });
    const dueAt = daysFromNow(-1);
    const row = await reminder(customer.id, p.id, { intervalDays: 30, nextDueAt: dueAt });

    const result = await runRefillReminderSweep();
    expect(result).toEqual({ due: 1, notified: 0, skipped: 1, failed: 0 });
    expect(await prisma.notification.count()).toBe(0);

    const after = await prisma.refillReminder.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.nextDueAt.getTime()).toBe(dueAt.getTime() + 30 * DAY_MS);
    expect(after.lastNotifiedAt).toBeNull();
  });

  it("honours a refillReminders opt-out, and still nudges consenting users", async () => {
    const optedOut = await user("CUSTOMER");
    const consenting = await user("CUSTOMER");
    await prisma.notificationPreference.create({
      data: { userId: optedOut.id, refillReminders: false },
    });
    await reminder(optedOut.id, (await product()).id, { nextDueAt: daysFromNow(-1) });
    await reminder(consenting.id, (await product()).id, { nextDueAt: daysFromNow(-1) });

    const result = await runRefillReminderSweep();
    expect(result).toEqual({ due: 2, notified: 1, skipped: 1, failed: 0 });
    expect(await prisma.notification.count({ where: { userId: optedOut.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: consenting.id } })).toBe(1);
  });

  it("respects the injected `now` cutoff and collapses a long outage into one nudge", async () => {
    const customer = await user("CUSTOMER");
    const dueAt = daysFromNow(-40);
    const row = await reminder(customer.id, (await product()).id, {
      intervalDays: 7,
      nextDueAt: dueAt,
    });

    const now = new Date();
    const result = await runRefillReminderSweep(now);
    expect(result.notified).toBe(1);
    expect(await prisma.notification.count()).toBe(1);

    const after = await prisma.refillReminder.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.nextDueAt.getTime()).toBeGreaterThan(now.getTime());
    // Whole periods only — the schedule stays anchored to the original cadence.
    expect((after.nextDueAt.getTime() - dueAt.getTime()) % (7 * DAY_MS)).toBe(0);
  });

  it("sweeps many due reminders across pages without missing any", async () => {
    const customer = await user("CUSTOMER");
    const p = await product();
    const others = await Promise.all(
      Array.from({ length: 5 }, () => user("CUSTOMER")),
    );
    for (const u of [customer, ...others]) {
      await reminder(u.id, p.id, { intervalDays: 30, nextDueAt: daysFromNow(-3) });
    }

    const result = await runRefillReminderSweep();
    expect(result.due).toBe(6);
    expect(result.notified).toBe(6);
    expect(await prisma.notification.count()).toBe(6);
    expect(await prisma.refillReminder.count({ where: { nextDueAt: { lte: new Date() } } })).toBe(0);
  });
});
