import { getPrisma } from "../../src/core/db";
import { flushOpsAlertWrites } from "../../src/core/realtime";

/**
 * Integration-test database harness (phase-1 brief). Uses a REAL Postgres —
 * the local portable instance by default; CI overrides `DATABASE_URL`.
 *
 * `setupTestDb()` primes the default URL, refuses to run against anything whose
 * database name does not end in `_test` (so a real DB is never wiped), then
 * truncates every volatile table. Call it in `beforeEach`.
 */

const DEFAULT_DATABASE_URL = "postgresql://postgres@localhost:5433/medrush_test";

/** Every application table (PascalCase to match Prisma's default table names). */
const VOLATILE_TABLES = [
  "OpsAlert",
  "AuditLog",
  "Notification",
  "DeviceToken",
  "StockAlert",
  "TempLog",
  "AppSetting",
  "StoreConfig",
  "CouponRedemption",
  "Coupon",
  "InvoiceCounter",
  "IdempotencyKey",
  "PaymentEvent",
  "Payment",
  "Payout",
  "WalletTxn",
  "Wallet",
  "Delivery",
  "DeliveryOffer",
  "DriverProfile",
  "Prescription",
  "OrderEvent",
  "ItemBatchAlloc",
  "OrderItem",
  "Order",
  "CartItem",
  "Cart",
  "StockAdjustment",
  "Batch",
  "Product",
  "Category",
  "Address",
  "User",
] as const;

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    // Fall back to a manual parse for URLs `new URL` cannot handle.
    const match = /\/([^/?]+)(?:\?|$)/.exec(url);
    return match?.[1] ?? "";
  }
}

/** Prime the default URL + assert we are pointed at a `_test` database. */
export function assertTestDatabase(): string {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  const url = process.env.DATABASE_URL;
  const name = databaseName(url);
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to truncate: DATABASE_URL database "${name}" does not end in _test. ` +
        `Point tests at a disposable database (default ${DEFAULT_DATABASE_URL}).`,
    );
  }
  return url;
}

/** Truncate every volatile table (single statement, CASCADE + RESTART IDENTITY). */
export async function setupTestDb(): Promise<void> {
  assertTestDatabase();
  // Drain fire-and-forget OpsAlert persists (core/realtime.ts) first — a write
  // landing mid-TRUNCATE can deadlock against the multi-table lock sweep.
  await flushOpsAlertWrites();
  const tableList = VOLATILE_TABLES.map((t) => `"${t}"`).join(", ");
  const sql = `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`;
  // 40P01 (deadlock) is transient — the victim is rolled back cleanly, so a
  // short retry keeps a rare lock-order collision from failing the whole file.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await getPrisma().$executeRawUnsafe(sql);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !message.includes("40P01")) throw error;
    }
  }
}
