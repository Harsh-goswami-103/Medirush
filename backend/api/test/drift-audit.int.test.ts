import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Wallet-ledger drift audit (§9.6/§24). The nightly cron recomputes each wallet's
 * balance from its append-only txns and alerts on any mismatch. Real Postgres.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { setupTestDb } = await import("./helpers/db");
const { user } = await import("./helpers/factories");
const { creditWallet } = await import("../src/modules/wallet/ledger");
const { runDriftAudit } = await import("../src/jobs/driftAudit");

const prisma = getPrisma();

/** A verified driver whose wallet has been credited `credits` (ledger-consistent). */
async function makeDriverWallet(credits: number[]): Promise<string> {
  const u = await user("DRIVER");
  const profile = await prisma.driverProfile.create({ data: { userId: u.id, isVerified: true } });
  for (const amt of credits) {
    await prisma.$transaction((tx) =>
      creditWallet(tx, profile.id, amt, { type: "ORDER", id: randomUUID() }, "seed"),
    );
  }
  return profile.id;
}

afterAll(async () => {
  await disconnectPrisma();
});
beforeEach(async () => {
  await setupTestDb();
});

describe("wallet drift audit", () => {
  it("passes when every wallet reconciles with its ledger", async () => {
    await makeDriverWallet([5000, 3000]);
    const result = await runDriftAudit();
    expect(result.wallets).toBe(1);
    expect(result.drifts).toHaveLength(0);
  });

  it("flags exactly the wallet whose balance diverges from its ledger", async () => {
    const clean = await makeDriverWallet([5000, 3000]); // balance 8000, consistent
    const drifted = await makeDriverWallet([4000]); // ledger says 4000…
    // …but corrupt the cached balance (simulate a drift bug the guards missed).
    await prisma.wallet.update({ where: { driverId: drifted }, data: { balancePaise: 9999 } });

    const result = await runDriftAudit();
    expect(result.wallets).toBe(2);
    expect(result.drifts).toHaveLength(1);
    const d = result.drifts[0]!;
    expect(d.driverId).toBe(drifted);
    expect(d.expectedPaise).toBe(4000);
    expect(d.actualPaise).toBe(9999);
    expect(d.deltaPaise).toBe(5999);
    expect(result.drifts.some((x) => x.driverId === clean)).toBe(false);
  });
});
