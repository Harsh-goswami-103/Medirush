import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Admin fleet + users integration tests (Phase 3, §7.2/§8/§9.6). Real Postgres.
 * Covers: driver verify/block, user list/block(+cache bust)/set-role, and the
 * payout money flow (approve debits under the ledger invariant, insufficient
 * balance → 409, double-approve → 409, reject compensating-credits, mark-paid
 * records the UTR).
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { assertLedgerInvariant, creditWallet } = await import("../src/modules/wallet/ledger");
const { setupTestDb } = await import("./helpers/db");
const factories = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

/* ------------------------------------------------------------------ helpers */

async function makeAdmin() {
  const admin = await factories.user("ADMIN");
  return { admin, headers: authHeaders(admin) };
}

async function makeDriver(opts: { verified?: boolean; online?: boolean } = {}) {
  const driverUser = await factories.user("DRIVER");
  const profile = await prisma.driverProfile.create({
    data: {
      userId: driverUser.id,
      isVerified: opts.verified ?? false,
      isOnline: opts.online ?? false,
    },
  });
  return { driverUser, profile, headers: authHeaders(driverUser) };
}

/** Seed a driver wallet to `amountPaise` via a real CREDIT (keeps the invariant green). */
async function seedWallet(driverProfileId: string, amountPaise: number) {
  await prisma.$transaction((tx) =>
    creditWallet(tx, driverProfileId, amountPaise, { type: "ORDER", id: randomUUID() }, "seed"),
  );
  return prisma.wallet.findUniqueOrThrow({ where: { driverId: driverProfileId } });
}

function createPayout(
  driverProfileId: string,
  amountPaise: number,
  status = "REQUESTED",
  requestedAt?: Date,
) {
  return prisma.payout.create({
    data: {
      driverId: driverProfileId,
      amountPaise,
      status: status as "REQUESTED" | "APPROVED" | "PAID" | "REJECTED",
      upiOrAcct: "driver@upi",
      ...(requestedAt ? { requestedAt } : {}),
    },
  });
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
  await factories.storeConfig();
  await factories.appSettings();
});

/* -------------------------------------------------------------------- drivers */

describe("admin drivers", () => {
  it("rejects a non-admin token with 403", async () => {
    const customer = await factories.user("CUSTOMER");
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/drivers",
      headers: authHeaders(customer),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("verify flips isVerified and writes an audit row", async () => {
    const { headers } = await makeAdmin();
    const { profile } = await makeDriver({ verified: false });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/drivers/${profile.id}/verify`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().data.isVerified).toBe(true);

    const dbProfile = await prisma.driverProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(dbProfile.isVerified).toBe(true);

    const audit = await prisma.auditLog.findMany({
      where: { action: "DRIVER_VERIFIED", entityId: profile.id },
    });
    expect(audit).toHaveLength(1);
  });

  it("block sets the driver's User.isBlocked + audit", async () => {
    const { headers } = await makeAdmin();
    const { driverUser, profile } = await makeDriver({ verified: true });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/drivers/${profile.id}/block`,
      headers,
      payload: { blocked: true, reason: "fraud watch" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.isBlocked).toBe(true);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: driverUser.id } });
    expect(dbUser.isBlocked).toBe(true);
    expect(
      await prisma.auditLog.count({ where: { action: "DRIVER_BLOCKED", entityId: driverUser.id } }),
    ).toBe(1);
  });

  it("roster reports wallet balance, delivered count, and null last-location", async () => {
    const { headers } = await makeAdmin();
    const { driverUser, profile } = await makeDriver({ verified: true, online: true });
    await seedWallet(profile.id, 7_500);

    // One DELIVERED delivery so totalDeliveries counts it.
    const customer = await factories.user("CUSTOMER");
    const order = await prisma.order.create({
      data: {
        orderNo: `MR-TEST-${Date.now()}`,
        userId: customer.id,
        status: "DELIVERED",
        paymentMethod: "COD",
        paymentStatus: "COD_COLLECTED",
        addressSnapshot: {},
        distanceM: 1_000,
        itemsPaise: 1_000,
        deliveryPaise: 0,
        totalPaise: 1_000,
      },
    });
    await prisma.delivery.create({
      data: { orderId: order.id, driverId: profile.id, distanceM: 1_000, deliveredAt: new Date() },
    });

    const res = await app.inject({ method: "GET", url: "/v1/admin/drivers", headers });
    expect(res.statusCode, res.body).toBe(200);
    const drivers = res.json().data as Array<Record<string, unknown>>;
    const row = drivers.find((d) => d.id === profile.id);
    expect(row).toBeDefined();
    expect(row?.userId).toBe(driverUser.id);
    expect(row?.walletBalancePaise).toBe(7_500);
    expect(row?.totalDeliveries).toBe(1);
    expect(row?.cancelCount).toBe(0);
    expect(row?.lastLocation).toBeNull();
    expect(row?.isOnline).toBe(true);
  });
});

/* ---------------------------------------------------------------------- users */

describe("admin users", () => {
  it("lists with search + role/blocked filters", async () => {
    const { headers } = await makeAdmin();
    await factories.user("CUSTOMER", { name: "Zebra Patient" });
    const blocked = await factories.user("CUSTOMER", { name: "Blocked Person", isBlocked: true });
    await makeDriver({ verified: true });

    const search = await app.inject({ method: "GET", url: "/v1/admin/users?search=Zebra", headers });
    expect(search.statusCode, search.body).toBe(200);
    const names = (search.json().data as Array<{ name: string }>).map((u) => u.name);
    expect(names).toContain("Zebra Patient");
    expect(names).not.toContain("Blocked Person");

    const drivers = await app.inject({ method: "GET", url: "/v1/admin/users?role=DRIVER", headers });
    expect((drivers.json().data as Array<{ role: string }>).every((u) => u.role === "DRIVER")).toBe(
      true,
    );

    const blockedOnly = await app.inject({
      method: "GET",
      url: "/v1/admin/users?blocked=true",
      headers,
    });
    const blockedIds = (blockedOnly.json().data as Array<{ id: string }>).map((u) => u.id);
    expect(blockedIds).toEqual([blocked.id]);
  });

  it("block sets isBlocked and busts the auth cache (blocked mid-session)", async () => {
    const { headers } = await makeAdmin();
    // An INVENTORY user can reach the ops board; use that as the 200→403 probe.
    const staff = await factories.user("INVENTORY");
    const staffHeaders = authHeaders(staff);

    const before = await app.inject({ method: "GET", url: "/v1/ops/orders", headers: staffHeaders });
    expect(before.statusCode, before.body).toBe(200); // caches user as not-blocked

    const blockRes = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${staff.id}/block`,
      headers,
      payload: { blocked: true },
    });
    expect(blockRes.statusCode, blockRes.body).toBe(200);
    expect(blockRes.json().data.isBlocked).toBe(true);

    // Cache was invalidated → the next request re-reads the blocked row → 403.
    const after = await app.inject({ method: "GET", url: "/v1/ops/orders", headers: staffHeaders });
    expect(after.statusCode, after.body).toBe(403);
    expect(after.json().error.code).toBe("FORBIDDEN");
  });

  it("set-role changes the PG role + audit", async () => {
    const { headers } = await makeAdmin();
    const target = await factories.user("CUSTOMER");

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${target.id}/role`,
      headers,
      payload: { role: "INVENTORY" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.role).toBe("INVENTORY");

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(dbUser.role).toBe("INVENTORY");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "USER_ROLE_CHANGED", entityId: target.id },
    });
    expect((audit.meta as { from: string; to: string }).from).toBe("CUSTOMER");
    expect((audit.meta as { from: string; to: string }).to).toBe("INVENTORY");
  });

  it("refuses to let an admin block their own account (§23 lockout guard)", async () => {
    const { admin, headers } = await makeAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${admin.id}/block`,
      headers,
      payload: { blocked: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    // Unchanged.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).isBlocked).toBe(false);
  });

  it("refuses to let an admin demote their own role (last-admin guard)", async () => {
    const { admin, headers } = await makeAdmin();
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${admin.id}/role`,
      headers,
      payload: { role: "INVENTORY" },
    });
    expect(res.statusCode).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe("ADMIN");
  });
});

/* -------------------------------------------------------------------- payouts */

describe("admin payouts", () => {
  it("approve debits the wallet under the ledger invariant + audit", async () => {
    const { headers } = await makeAdmin();
    const { profile, driverUser } = await makeDriver({ verified: true });
    const wallet = await seedWallet(profile.id, 100_000);
    const payout = await createPayout(profile.id, 60_000);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/approve`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("APPROVED");
    expect(data.driverId).toBe(profile.id);
    expect(data.driverPhone).toBe(driverUser.phone);

    const dbWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(dbWallet.balancePaise).toBe(40_000);

    const debit = await prisma.walletTxn.findFirstOrThrow({
      where: { walletId: wallet.id, type: "PAYOUT" },
    });
    expect(debit.amountPaise).toBe(60_000);
    expect(debit.balanceAfterPaise).toBe(40_000);
    expect(debit.refType).toBe("PAYOUT");
    expect(debit.refId).toBe(payout.id);

    await assertLedgerInvariant(wallet.id);
    expect(
      await prisma.auditLog.count({ where: { action: "PAYOUT_APPROVED", entityId: payout.id } }),
    ).toBe(1);
  });

  it("refuses to approve when the wallet balance is short (409, no debit)", async () => {
    const { headers } = await makeAdmin();
    const { profile } = await makeDriver({ verified: true });
    const wallet = await seedWallet(profile.id, 5_000);
    const payout = await createPayout(profile.id, 60_000);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/approve`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");

    // Status flip rolled back with the failed debit; no PAYOUT txn written.
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe(
      "REQUESTED",
    );
    expect(await prisma.walletTxn.count({ where: { walletId: wallet.id, type: "PAYOUT" } })).toBe(0);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balancePaise).toBe(
      5_000,
    );
  });

  it("double-approve is idempotent-guarded (second → 409, single debit)", async () => {
    const { headers } = await makeAdmin();
    const { profile } = await makeDriver({ verified: true });
    const wallet = await seedWallet(profile.id, 100_000);
    const payout = await createPayout(profile.id, 60_000);

    const first = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/approve`,
      headers,
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/approve`,
      headers,
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe("CONFLICT");

    expect(await prisma.walletTxn.count({ where: { walletId: wallet.id, type: "PAYOUT" } })).toBe(1);
    await assertLedgerInvariant(wallet.id);
  });

  it("reject after approve writes a compensating CREDIT and restores the balance", async () => {
    const { headers } = await makeAdmin();
    const { profile } = await makeDriver({ verified: true });
    const wallet = await seedWallet(profile.id, 100_000);
    const payout = await createPayout(profile.id, 60_000);

    await app.inject({ method: "POST", url: `/v1/admin/payouts/${payout.id}/approve`, headers });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/reject`,
      headers,
      payload: { reason: "wrong UPI on file" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe("REJECTED");

    const dbWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(dbWallet.balancePaise).toBe(100_000);

    const payoutTxns = await prisma.walletTxn.findMany({
      where: { walletId: wallet.id, refType: "PAYOUT" },
      orderBy: { createdAt: "asc" },
    });
    // One DEBIT (PAYOUT) + one compensating CREDIT.
    expect(payoutTxns.map((t) => t.type).sort()).toEqual(["CREDIT", "PAYOUT"]);
    await assertLedgerInvariant(wallet.id);
  });

  it("reject a REQUESTED payout makes no ledger move", async () => {
    const { headers } = await makeAdmin();
    const { profile } = await makeDriver({ verified: true });
    const wallet = await seedWallet(profile.id, 100_000);
    const payout = await createPayout(profile.id, 60_000);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/reject`,
      headers,
      payload: { reason: "duplicate request" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe("REJECTED");

    expect(await prisma.walletTxn.count({ where: { walletId: wallet.id, refType: "PAYOUT" } })).toBe(
      0,
    );
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balancePaise).toBe(
      100_000,
    );
  });

  it("mark-paid records the UTR and processor (APPROVED → PAID)", async () => {
    const { admin, headers } = await makeAdmin();
    const { profile } = await makeDriver({ verified: true });
    await seedWallet(profile.id, 100_000);
    const payout = await createPayout(profile.id, 60_000);

    await app.inject({ method: "POST", url: `/v1/admin/payouts/${payout.id}/approve`, headers });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${payout.id}/mark-paid`,
      headers,
      payload: { utr: "UTR1234567890" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe("PAID");
    expect(data.utr).toBe("UTR1234567890");
    expect(data.processedAt).not.toBeNull();

    const dbPayout = await prisma.payout.findUniqueOrThrow({ where: { id: payout.id } });
    expect(dbPayout.processedBy).toBe(admin.id);
  });

  it("lists payouts newest-first with driver join + status filter", async () => {
    const { headers } = await makeAdmin();
    const { profile, driverUser } = await makeDriver({ verified: true });
    await seedWallet(profile.id, 100_000);
    // Distinct requestedAt so the newest-first ordering is deterministic.
    const older = await createPayout(profile.id, 60_000, "REQUESTED", new Date(Date.now() - 60_000));
    const newer = await createPayout(profile.id, 70_000, "REQUESTED", new Date());
    // Reject the older one so the status filter has two states to sift.
    await app.inject({
      method: "POST",
      url: `/v1/admin/payouts/${older.id}/reject`,
      headers,
      payload: { reason: "test" },
    });

    const all = await app.inject({ method: "GET", url: "/v1/admin/payouts", headers });
    expect(all.statusCode, all.body).toBe(200);
    const rows = all.json().data as Array<{ id: string; driverPhone: string }>;
    expect(rows[0]?.id).toBe(newer.id); // newest first
    expect(rows.every((r) => r.driverPhone === driverUser.phone)).toBe(true);

    const requested = await app.inject({
      method: "GET",
      url: "/v1/admin/payouts?status=REQUESTED",
      headers,
    });
    const requestedIds = (requested.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(requestedIds).toEqual([newer.id]);
  });
});
