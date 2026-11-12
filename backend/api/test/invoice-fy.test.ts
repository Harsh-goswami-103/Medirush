import { describe, expect, it } from "vitest";

/**
 * Unit tests for Indian financial-year derivation and the FY component of the
 * GST invoice number (BLUEPRINT §9.7, §13). No DB — `financialYear()` is pure
 * and `nextInvoiceNo()` only needs a `Prisma.TransactionClient`-shaped stub, so
 * the compliance-sensitive boundary is covered without Postgres.
 *
 * WHY these exact instants: the FY rolls over at 00:00 IST on 1 April, i.e.
 * 18:30 UTC on 31 March. Because IST is UTC+5:30 (never behind UTC), there is a
 * 5.5-hour window each year in which a naive UTC implementation still reports
 * the OLD financial year while the statutory (IST) answer is already the NEW
 * one. Every assertion inside that window is a genuine discriminator; anything
 * outside it is only a sanity check.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.R2_ACCOUNT_ID;

const { financialYear, nextInvoiceNo } = await import("../src/modules/invoices/service");

/**
 * Minimal stand-in for `Prisma.TransactionClient`: records the `fy` bound into
 * the seeding INSERT and hands back a fixed sequence, so the test asserts the
 * formatting/FY of the minted number rather than counter mechanics (those are
 * covered against real Postgres in `invoice.int.test.ts`).
 */
function fakeTx(seq = 1) {
  const seen: string[] = [];
  const tx = {
    $executeRaw: (_s: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(String(values[0]));
      return Promise.resolve(1);
    },
    $queryRaw: (_s: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(String(values[0]));
      return Promise.resolve([{ seq }]);
    },
  };
  // The stub only implements the two raw helpers `nextInvoiceNo` actually uses.
  return { tx: tx as unknown as Parameters<typeof nextInvoiceNo>[0], seen };
}

describe("financialYear() — IST boundary", () => {
  it("last instant of the FY in IST stays in the old FY", () => {
    // 2026-03-31T18:29:59Z === 23:59:59 IST on 31 Mar 2026 → FY 2025-26.
    expect(financialYear(new Date("2026-03-31T18:29:59Z"))).toBe("25-26");
  });

  it("first instant of the next FY in IST rolls over", () => {
    // 2026-03-31T18:30:01Z === 00:00:01 IST on 1 Apr 2026 → FY 2026-27.
    expect(financialYear(new Date("2026-03-31T18:30:01Z"))).toBe("26-27");
  });

  it("exactly 18:30:00Z on 31 Mar is already the new FY (midnight IST)", () => {
    expect(financialYear(new Date("2026-03-31T18:30:00Z"))).toBe("26-27");
  });

  it("discriminates IST from UTC deep inside the 5.5-hour window", () => {
    // 03:30 IST on 1 Apr 2025 — unambiguously the new FY 2025-26 for GST, but a
    // naive `getUTCMonth()` implementation sees 22:00 UTC on 31 Mar 2025 (month
    // 3 < 4) and would answer "24-25". This assertion fails on UTC, passes on IST.
    expect(financialYear(new Date("2025-03-31T22:00:00Z"))).toBe("25-26");
  });

  it("orders placed in the window on either side of the FY line differ", () => {
    // Two orders 3 minutes apart across midnight IST must not share an FY.
    const before = financialYear(new Date("2026-03-31T18:28:00Z"));
    const after = financialYear(new Date("2026-03-31T18:31:00Z"));
    expect(before).toBe("25-26");
    expect(after).toBe("26-27");
    expect(before).not.toBe(after);
  });

  it("the whole IST 1-April window belongs to the new FY", () => {
    // Every minute-ish sample between 18:30Z (31 Mar) and 00:00Z (1 Apr) is
    // 1 April in IST; a UTC implementation gets all of them wrong.
    for (const iso of [
      "2026-03-31T18:30:00Z",
      "2026-03-31T19:45:00Z",
      "2026-03-31T21:00:00Z",
      "2026-03-31T23:59:59Z",
    ]) {
      expect(financialYear(new Date(iso))).toBe("26-27");
    }
  });
});

describe("financialYear() — mid-year sanity", () => {
  it("a month after the FY start is the FY that just began", () => {
    expect(financialYear(new Date("2025-06-15T09:00:00Z"))).toBe("25-26");
  });

  it("a month before the FY start is still the FY that began last April", () => {
    expect(financialYear(new Date("2026-01-15T09:00:00Z"))).toBe("25-26");
    expect(financialYear(new Date("2025-12-31T18:31:00Z"))).toBe("25-26");
  });

  it("31 March mid-day IST is the old FY; 1 April mid-day IST is the new one", () => {
    expect(financialYear(new Date("2026-03-31T06:30:00Z"))).toBe("25-26"); // 12:00 IST 31 Mar
    expect(financialYear(new Date("2026-04-01T06:30:00Z"))).toBe("26-27"); // 12:00 IST 1 Apr
  });

  it("labels are always two zero-padded two-digit years", () => {
    for (const iso of ["2005-04-01T00:00:00Z", "2009-12-01T00:00:00Z", "2026-07-01T00:00:00Z"]) {
      expect(financialYear(new Date(iso))).toMatch(/^\d{2}-\d{2}$/);
    }
    // The 2009-10 FY must render as "09-10", not "9-10".
    expect(financialYear(new Date("2009-12-01T00:00:00Z"))).toBe("09-10");
  });
});

describe("nextInvoiceNo() — FY component of the number", () => {
  it("formats MR/{fy}/{seq padded to 6}", async () => {
    const { tx } = fakeTx(123);
    expect(await nextInvoiceNo(tx, new Date("2025-06-15T09:00:00Z"))).toBe("MR/25-26/000123");
  });

  it("the number's FY flips across the IST boundary and keys the counter row", async () => {
    const before = fakeTx(9);
    const after = fakeTx(1);
    const last = await nextInvoiceNo(before.tx, new Date("2026-03-31T18:29:59Z"));
    const first = await nextInvoiceNo(after.tx, new Date("2026-03-31T18:30:01Z"));

    expect(last).toBe("MR/25-26/000009");
    expect(first).toBe("MR/26-27/000001");

    // The counter is looked up by the IST FY, so the new year starts a fresh row
    // (and therefore a fresh sequence) rather than continuing the old one.
    expect(before.seen).toEqual(["25-26", "25-26"]);
    expect(after.seen).toEqual(["26-27", "26-27"]);
  });

  it("mints under the IST FY, not the UTC one, inside the rollover window", async () => {
    // Same discriminating instant as above: 03:30 IST 1 Apr 2025. A UTC-based
    // helper would mint MR/24-25/… here — a wrong statutory invoice number.
    const { tx } = fakeTx(7);
    expect(await nextInvoiceNo(tx, new Date("2025-03-31T22:00:00Z"))).toBe("MR/25-26/000007");
  });
});
