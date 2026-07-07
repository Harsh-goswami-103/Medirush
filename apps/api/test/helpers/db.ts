import { getPrisma } from "../../src/core/db";

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
  "AuditLog",
  "Notification",
  "DeviceToken",
  "TempLog",
  "AppSetting",
  "StoreConfig",
  "CouponRedemption",
  "Coupon",
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
  const tableList = VOLATILE_TABLES.map((t) => `"${t}"`).join(", ");
  await getPrisma().$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);
}
