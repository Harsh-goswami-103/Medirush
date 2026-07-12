import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertKind } from "@medrush/contracts";

/**
 * Durable ops alerts (Phase 7 §24): every `emitOpsAlert` also persists an
 * OpsAlert row (a socket emit to an empty ops room vanishes — the 02:30 IST
 * drift audit must survive to morning review) and money/data-critical kinds
 * page through Sentry. Plus the INVENTORY/ADMIN read/ack endpoints over real
 * HTTP against real Postgres.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  close: vi.fn().mockResolvedValue(true),
}));

const Sentry = await import("@sentry/node");
const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { CRITICAL_ALERT_KINDS, emitOpsAlert, flushOpsAlertWrites } = await import(
  "../src/core/realtime"
);
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;
const prisma = getPrisma();
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
  clearAuthCaches();
  vi.mocked(Sentry.captureMessage).mockClear();
});

/* ------------------------------------------------------------- durability */

describe("emitOpsAlert durability", () => {
  it("persists an OpsAlert row even with no ops socket connected", async () => {
    emitOpsAlert(AlertKind.WALLET_DRIFT, "Wallet w1 drift: ₹99.99 vs ₹0.00", "wallet-1", {
      deltaPaise: 9999,
    });

    // The write is fire-and-forget (callers may be sync) — drain, then assert.
    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where: { kind: AlertKind.WALLET_DRIFT } })).toBe(1);

    const row = await prisma.opsAlert.findFirstOrThrow({
      where: { kind: AlertKind.WALLET_DRIFT },
    });
    expect(row.message).toBe("Wallet w1 drift: ₹99.99 vs ₹0.00");
    expect(row.refId).toBe("wallet-1");
    expect(row.meta).toEqual({ deltaPaise: 9999 });
    expect(row.acknowledgedAt).toBeNull();
  });

  it("pages critical kinds through Sentry captureMessage (level error)", async () => {
    emitOpsAlert(AlertKind.DB_BACKUP_FAILED, "Nightly DB backup failed: gpg exited 2");

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Nightly DB backup failed: gpg exited 2",
      expect.objectContaining({
        level: "error",
        tags: { alertKind: AlertKind.DB_BACKUP_FAILED },
      }),
    );

    // The durable row lands too — same message, no ack yet.
    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where: { kind: AlertKind.DB_BACKUP_FAILED } })).toBe(1);
  });

  it("does NOT page non-critical kinds (row only)", async () => {
    emitOpsAlert(AlertKind.GENERIC, "Customer requested cancellation for order o1", "o1");

    await flushOpsAlertWrites();
    expect(await prisma.opsAlert.count({ where: { kind: AlertKind.GENERIC } })).toBe(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("covers every money/data-critical kind in CRITICAL_ALERT_KINDS", () => {
    for (const kind of [
      AlertKind.WALLET_DRIFT,
      AlertKind.DB_BACKUP_FAILED,
      AlertKind.STUCK_ORDER,
      AlertKind.MANUAL_REFUND_REQUIRED,
      AlertKind.UNASSIGNED_ORDER,
      AlertKind.FRAUD_VELOCITY,
    ]) {
      expect(CRITICAL_ALERT_KINDS.has(kind), kind).toBe(true);
    }
    expect(CRITICAL_ALERT_KINDS.has(AlertKind.GENERIC)).toBe(false);
  });
});

/* -------------------------------------------------------------- endpoints */

/** Insert an alert row directly (deterministic — no fire-and-forget race). */
async function alertRow(kind: string, message: string, createdAt: Date, acknowledgedAt?: Date) {
  return prisma.opsAlert.create({
    data: { kind, message, createdAt, ...(acknowledgedAt ? { acknowledgedAt } : {}) },
  });
}

describe("ops alert endpoints", () => {
  it("lists unacked alerts newest-first by default; includeAcked widens", async () => {
    const inv = await user("INVENTORY");
    const t0 = new Date("2026-07-10T10:00:00.000Z");
    const t1 = new Date("2026-07-10T11:00:00.000Z");
    const t2 = new Date("2026-07-10T12:00:00.000Z");
    await alertRow(AlertKind.STUCK_ORDER, "old unacked", t0);
    await alertRow(AlertKind.WALLET_DRIFT, "acked", t1, new Date());
    await alertRow(AlertKind.GENERIC, "new unacked", t2);

    const res = await app.inject({ method: "GET", url: "/v1/ops/alerts", headers: authHeaders(inv) });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().data as Array<{ message: string; acknowledgedAt: string | null }>;
    expect(items.map((a) => a.message)).toEqual(["new unacked", "old unacked"]);
    expect(items.every((a) => a.acknowledgedAt === null)).toBe(true);

    const all = await app.inject({
      method: "GET",
      url: "/v1/ops/alerts?includeAcked=true",
      headers: authHeaders(inv),
    });
    expect(all.json().data).toHaveLength(3);
    expect((all.json().data as Array<{ message: string }>).map((a) => a.message)).toEqual([
      "new unacked",
      "acked",
      "old unacked",
    ]);
  });

  it("paginates with a cursor", async () => {
    const admin = await user("ADMIN");
    for (let i = 0; i < 3; i += 1) {
      await alertRow(AlertKind.GENERIC, `alert ${i}`, new Date(Date.now() - i * 60_000));
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/v1/ops/alerts?limit=2",
      headers: authHeaders(admin),
    });
    expect(page1.statusCode, page1.body).toBe(200);
    expect(page1.json().data).toHaveLength(2);
    const cursor = page1.json().meta.nextCursor as string;
    expect(cursor).toBeTruthy();

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/ops/alerts?limit=2&cursor=${cursor}`,
      headers: authHeaders(admin),
    });
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().meta.nextCursor).toBeNull();
  });

  it("acks idempotently — the first acknowledgedAt sticks; unknown id → 404", async () => {
    const inv = await user("INVENTORY");
    const row = await alertRow(AlertKind.STUCK_ORDER, "ack me", new Date());

    const first = await app.inject({
      method: "POST",
      url: `/v1/ops/alerts/${row.id}/ack`,
      headers: authHeaders(inv),
    });
    expect(first.statusCode, first.body).toBe(200);
    const ackedAt = first.json().data.acknowledgedAt as string;
    expect(ackedAt).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: `/v1/ops/alerts/${row.id}/ack`,
      headers: authHeaders(inv),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.acknowledgedAt).toBe(ackedAt);

    const missing = await app.inject({
      method: "POST",
      url: "/v1/ops/alerts/nope/ack",
      headers: authHeaders(inv),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  it("is INVENTORY/ADMIN only — a CUSTOMER gets 403", async () => {
    const customer = await user("CUSTOMER");
    const row = await alertRow(AlertKind.GENERIC, "hidden", new Date());

    const list = await app.inject({
      method: "GET",
      url: "/v1/ops/alerts",
      headers: authHeaders(customer),
    });
    expect(list.statusCode).toBe(403);

    const ack = await app.inject({
      method: "POST",
      url: `/v1/ops/alerts/${row.id}/ack`,
      headers: authHeaders(customer),
    });
    expect(ack.statusCode).toBe(403);
    const untouched = await prisma.opsAlert.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.acknowledgedAt).toBeNull();
  });
});
