import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AlertKind } from "@medrush/contracts";

/**
 * Daily stale-row prune (Phase 7 §24): IdempotencyKey > 7d, READ Notification
 * > 90d and ACKNOWLEDGED OpsAlert > 30d are deleted; unread notifications,
 * unacked alerts (still open in the ops inbox + arming the watchdog dedupe)
 * and PaymentEvent (webhook idempotency gate) are NEVER touched. Real Postgres.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");
const { user } = await import("./helpers/factories");
const { runDataPrune } = await import("../src/jobs/prune");

const prisma = getPrisma();

const DAY_MS = 86_400_000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

afterAll(async () => {
  await disconnectPrisma();
});
beforeEach(async () => {
  await setupTestDb();
});

describe("data prune", () => {
  it("deletes IdempotencyKey rows older than 7 days, keeps fresh ones", async () => {
    const u = await user("CUSTOMER");
    await prisma.idempotencyKey.create({
      data: { key: "old-key", userId: u.id, response: {}, createdAt: daysAgo(8) },
    });
    await prisma.idempotencyKey.create({
      data: { key: "fresh-key", userId: u.id, response: {}, createdAt: daysAgo(1) },
    });

    const result = await runDataPrune();
    expect(result.idempotencyKeys).toBe(1);

    const remaining = await prisma.idempotencyKey.findMany();
    expect(remaining.map((k) => k.key)).toEqual(["fresh-key"]);
  });

  it("deletes READ notifications older than 90 days; unread and recent-read stay", async () => {
    const u = await user("CUSTOMER");
    const base = { userId: u.id, title: "t", body: "b", type: "ORDER_PLACED" };
    await prisma.notification.create({
      data: { ...base, createdAt: daysAgo(91), readAt: daysAgo(90) }, // old + read → pruned
    });
    const unreadOld = await prisma.notification.create({
      data: { ...base, createdAt: daysAgo(91) }, // old but UNREAD → kept
    });
    const readFresh = await prisma.notification.create({
      data: { ...base, createdAt: daysAgo(10), readAt: daysAgo(9) }, // read but fresh → kept
    });

    const result = await runDataPrune();
    expect(result.notifications).toBe(1);

    const remainingIds = (await prisma.notification.findMany()).map((n) => n.id).sort();
    expect(remainingIds).toEqual([unreadOld.id, readFresh.id].sort());
  });

  it("deletes ACKNOWLEDGED ops alerts older than 30 days; unacked and fresh-acked stay", async () => {
    await prisma.opsAlert.create({
      data: {
        kind: AlertKind.STUCK_ORDER,
        message: "old acked",
        createdAt: daysAgo(31),
        acknowledgedAt: daysAgo(30),
      }, // old + acked → pruned
    });
    const unackedOld = await prisma.opsAlert.create({
      data: { kind: AlertKind.STUCK_ORDER, message: "old unacked", createdAt: daysAgo(31) }, // old but UNACKED → kept
    });
    const ackedFresh = await prisma.opsAlert.create({
      data: {
        kind: AlertKind.WALLET_DRIFT,
        message: "fresh acked",
        createdAt: daysAgo(5),
        acknowledgedAt: daysAgo(4),
      }, // acked but fresh → kept
    });

    const result = await runDataPrune();
    expect(result.opsAlerts).toBe(1);

    const remainingIds = (await prisma.opsAlert.findMany()).map((a) => a.id).sort();
    expect(remainingIds).toEqual([unackedOld.id, ackedFresh.id].sort());
  });

  it("never touches PaymentEvent (webhook idempotency gate)", async () => {
    await prisma.paymentEvent.create({
      data: {
        eventId: "evt_ancient",
        type: "payment.captured",
        payload: {},
        processedAt: daysAgo(400),
      },
    });

    await runDataPrune();
    expect(await prisma.paymentEvent.count()).toBe(1);
  });
});
