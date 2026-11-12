import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Concurrent invoice numbering (BLUEPRINT §9.7, §13). Real Postgres — the whole
 * point is row locking, so this cannot be faked.
 *
 * `invoice.int.test.ts` already proves the counter increments across two
 * invoices, but it awaits them SEQUENTIALLY: two transactions are never in
 * flight at once, so it cannot fail on the race it appears to cover. The risky
 * line is the seeding `INSERT … ON CONFLICT ("fy") DO NOTHING` in
 * `nextInvoiceNo()` — under two simultaneous first-invoices-of-a-new-FY, one
 * inserter wins, the other must still fall through to the `UPDATE … RETURNING`
 * and take a distinct number rather than erroring or reusing 1.
 *
 * A duplicate invoice number is a statutory defect, not a cosmetic one, which is
 * why this is worth a dedicated file.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.R2_ACCOUNT_ID;

const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { financialYear, nextInvoiceNo } = await import("../src/modules/invoices/service");
const { setupTestDb } = await import("./helpers/db");

const prisma = getPrisma();

/** Mint `n` numbers for `now` in genuinely overlapping transactions. */
async function mintConcurrently(n: number, now: Date): Promise<string[]> {
  return Promise.all(
    Array.from({ length: n }, () => prisma.$transaction((tx) => nextInvoiceNo(tx, now))),
  );
}

/**
 * Hold the BEFORE INSERT trigger on InvoiceCounter until every contender is
 * waiting on the same transaction-scoped advisory lock. This proves both
 * transactions reached the fresh-row insert before either can commit.
 */
async function waitForInvoiceCounterInsertWaiters(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT COUNT(*)::int AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = 2147::oid
        AND objid = 733::oid
        AND objsubid = 2
        AND granted = false
    `;
    if (Number(rows[0]?.waiting ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} invoice-counter insert contenders`);
}

describe("nextInvoiceNo — concurrent minting", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await disconnectPrisma();
  });

  it("two simultaneous minters on a FRESH FY never collide", async () => {
    const now = new Date("2098-06-15T09:00:00Z");

    // The test-only trigger makes both INSERT statements wait at the same
    // advisory lock. We release it only after pg_locks confirms two waiters,
    // so pool scheduling cannot accidentally serialize the seed operation.
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "test_invoice_counter_insert_barrier" ON "InvoiceCounter"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS "test_invoice_counter_insert_barrier"()`,
    );
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "test_invoice_counter_insert_barrier"()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(2147, 733);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "test_invoice_counter_insert_barrier"
      BEFORE INSERT ON "InvoiceCounter"
      FOR EACH ROW
      WHEN (NEW."fy" = '98-99')
      EXECUTE FUNCTION "test_invoice_counter_insert_barrier"()
    `);

    let releaseGate!: () => void;
    let signalGateReady!: () => void;
    const gateReady = new Promise<void>((resolve) => {
      signalGateReady = resolve;
    });
    const holdGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gate = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(2147, 733)`;
      signalGateReady();
      await holdGate;
    });

    await gateReady;
    const minting = mintConcurrently(2, now);
    let barrierError: unknown;
    try {
      await waitForInvoiceCounterInsertWaiters(2);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseGate();
    }

    try {
      await gate;
      const numbers = await minting;
      expect(new Set(numbers).size).toBe(2);
      for (const no of numbers) expect(no).toMatch(/^MR\/98-99\/\d{6}$/);
      expect(numbers.map((no) => no.slice(-6)).sort()).toEqual(["000001", "000002"]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "test_invoice_counter_insert_barrier" ON "InvoiceCounter"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "test_invoice_counter_insert_barrier"()`,
      );
    }

    if (barrierError) throw barrierError;
  });

  it("many simultaneous minters produce a dense, gap-free, duplicate-free run", async () => {
    const now = new Date("2025-06-15T09:00:00Z");
    const numbers = await mintConcurrently(12, now);

    expect(new Set(numbers).size).toBe(numbers.length);
    // Dense and gap-free: a lost update would show up as a repeat, a skipped
    // sequence as a hole. Both are invisible if you only assert uniqueness.
    const seqs = numbers.map((no) => Number(no.slice(-6))).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    const counter = await prisma.$queryRaw<Array<{ next: number }>>`
      SELECT "next" FROM "InvoiceCounter" WHERE "fy" = ${financialYear(now)}
    `;
    expect(Number(counter[0]?.next)).toBe(13);
  });

  it("concurrent minters either side of the IST FY boundary use separate counters", async () => {
    // 2026-03-31T18:29:59Z is 23:59:59 IST 31 Mar (FY 25-26);
    // 2026-03-31T18:30:01Z is 00:00:01 IST  1 Apr (FY 26-27).
    // Racing them proves the two FYs seed independent rows rather than one
    // sequence bleeding into the next year's statutory numbering.
    const [oldFy, newFy] = await Promise.all([
      prisma.$transaction((tx) => nextInvoiceNo(tx, new Date("2026-03-31T18:29:59Z"))),
      prisma.$transaction((tx) => nextInvoiceNo(tx, new Date("2026-03-31T18:30:01Z"))),
    ]);

    expect(oldFy).toBe("MR/25-26/000001");
    expect(newFy).toBe("MR/26-27/000001");

    const rows = await prisma.$queryRaw<Array<{ fy: string; next: number }>>`
      SELECT "fy", "next" FROM "InvoiceCounter" ORDER BY "fy"
    `;
    expect(rows.map((r) => r.fy)).toEqual(["25-26", "26-27"]);
    expect(rows.every((r) => Number(r.next) === 2)).toBe(true);
  });
});
