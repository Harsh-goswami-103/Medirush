import { describe, expect, it } from "vitest";

/**
 * THE ledger sign convention (§9.6) — pinned for every TxnType value so the
 * in-TX invariant (assertLedgerInvariant) and the nightly drift audit
 * (jobs/driftAudit.ts) can never diverge again: before `signOf` the audit
 * signed every non-CREDIT type negative, so the first ADJUSTMENT row would
 * have false-flagged a drift.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

const { TxnType } = await import("@medrush/contracts");
const { signOf } = await import("../src/modules/wallet/ledger");

describe("signOf", () => {
  it("pins the documented sign for all four TxnType values", () => {
    expect(signOf(TxnType.CREDIT)).toBe(1);
    expect(signOf(TxnType.ADJUSTMENT)).toBe(1);
    expect(signOf(TxnType.DEBIT)).toBe(-1);
    expect(signOf(TxnType.PAYOUT)).toBe(-1);
  });

  it("covers the whole enum (a new TxnType must get an explicit sign)", () => {
    for (const type of Object.values(TxnType)) {
      expect([1, -1]).toContain(signOf(type));
    }
  });
});
