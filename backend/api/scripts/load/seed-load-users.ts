/**
 * Load-test fixture seeder (BLUEPRINT §21.3 / §23 Phase 7 — "50 concurrent
 * checkouts"). Run AFTER `prisma/seed.ts`, against a THROWAWAY database only.
 *
 *   pnpm --filter @medrush/api exec tsx scripts/load/seed-load-users.ts
 *   LOAD_USERS=4000 pnpm --filter @medrush/api exec tsx scripts/load/seed-load-users.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/load/checkout.js` used to drive every k6 VU with ONE seeded account.
 * Three server-side rules make that unable to pass, no matter how fast the API is:
 *
 *  1. `Cart` is unique per user (`modules/cart/service.ts`) and `POST /v1/orders`
 *     deletes the cart lines inside its transaction (`modules/orders/service.ts`).
 *     Concurrent VUs sharing one account therefore drain each other's carts and
 *     get 422 "Your cart is empty" — and the runs that do succeed are checking
 *     out someone else's items, so the latency figure means nothing.
 *  2. Velocity rule §10.3 (`MAX_ORDERS_PER_HOUR = 3`, a constant in
 *     `packages/contracts/src/domain.ts`, NOT a runtime flag): the 4th order from
 *     one account inside an hour is a hard 429. A 70s run places thousands.
 *  3. New-account COD cap §10.3: the first non-cancelled order on an account is
 *     capped (`new_account_cod_cap`, ₹500 in the demo seed).
 *
 * (1) and (2) are only satisfiable by giving each *iteration* its own account —
 * which is also the realistic model: production load is many distinct customers
 * placing one order each, not one customer placing 2,500. (3) is then satisfied
 * by the basket `checkout.js` builds, which stays under the cap on purpose.
 *
 * So this script provisions a pool of disposable CUSTOMER accounts with
 * DETERMINISTIC ids, so k6 can derive its identity arithmetically from the
 * global iteration number with no extra round-trip:
 *
 *     firebaseUid  load-<i>                 → dev token `dev:load-<i>:<phone>`
 *     phone        +9155<i zero-padded to 8>
 *     Address.id   load-addr-<i>            → sent straight as `addressId`
 *
 * KEEP THIS FORMAT IN SYNC WITH `loadIdentity()` in scripts/load/checkout.js.
 *
 * It also raises stock: every iteration places a REAL order, and the demo seed's
 * 180 units/product would be exhausted in seconds — after which checkouts fail
 * on STOCK_INSUFFICIENT, i.e. the job would go red for a fixture reason rather
 * than a performance regression. The stock ledger is deliberately NOT reconciled
 * (Batch totals are set to match Product.stockQty); this database is disposable.
 *
 * Idempotent: deterministic ids + `skipDuplicates`, so re-running is a no-op.
 * Refuses to run with NODE_ENV=production — it fabricates thousands of users and
 * rewrites the stock of every product.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Default pool size. Upper bound on iterations for the scenario declared in
 * checkout.js: stages 0→50 over 20s, 50 for 40s, 50→0 over 10s = 2,750 VU·s,
 * and each iteration ends with `sleep(1)`, so no VU can exceed 1 iteration/s →
 * at most 2,750 iterations. 4,000 is a ~45% margin over that hard ceiling.
 */
const DEFAULT_USERS = 4000;

/** Prisma createMany batch size — keeps the parameter count per statement sane. */
const CHUNK = 1000;

/** Per-product stock for the run. 4,000 iterations × 3 units = 12,000 max. */
const STOCK_QTY = 1_000_000;

/**
 * Deterministic identity for pool member `index` (0-based).
 * MIRRORED IN `loadIdentity()` in scripts/load/checkout.js — change both.
 */
export function loadIdentity(index: number): {
  userId: string;
  firebaseUid: string;
  phone: string;
  addressId: string;
} {
  const n = String(index).padStart(8, "0");
  return {
    userId: `load-user-${index}`,
    firebaseUid: `load-${index}`,
    // E.164 (PhoneSchema: /^\+[1-9]\d{7,14}$/). The 55 block cannot collide with
    // the demo seed's +91987654321x accounts.
    phone: `+9155${n}`,
    addressId: `load-addr-${index}`,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`LOAD_USERS must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "refusing to run with NODE_ENV=production — this seeder fabricates thousands of " +
        "CUSTOMER accounts and overwrites the stock of every product. Point it at a " +
        "throwaway load database only.",
    );
  }

  const count = positiveInt(process.env.LOAD_USERS, DEFAULT_USERS);

  // The addresses must sit inside the delivery radius or every checkout 422s
  // with OUT_OF_SERVICE_AREA (orders/service.ts step 2), so derive them from the
  // live StoreConfig rather than hard-coding Bengaluru coordinates.
  const store = await prisma.storeConfig.findUnique({ where: { id: "store" } });
  if (store === null) {
    throw new Error(
      'no StoreConfig row "store" — run `pnpm --filter @medrush/api db:seed` before this script',
    );
  }
  // ~100 m due north of the store: inside any sane service radius, and non-zero
  // so the order's `distanceM` is not a degenerate 0.
  const lat = store.lat + 0.0009;
  const lng = store.lng;

  const identities = Array.from({ length: count }, (_, i) => loadIdentity(i));

  let usersCreated = 0;
  for (let offset = 0; offset < identities.length; offset += CHUNK) {
    const slice = identities.slice(offset, offset + CHUNK);
    const { count: created } = await prisma.user.createMany({
      data: slice.map((id) => ({
        id: id.userId,
        firebaseUid: id.firebaseUid,
        phone: id.phone,
        name: `Load VU ${id.firebaseUid}`,
        role: "CUSTOMER" as const,
      })),
      skipDuplicates: true,
    });
    usersCreated += created;
  }

  let addressesCreated = 0;
  for (let offset = 0; offset < identities.length; offset += CHUNK) {
    const slice = identities.slice(offset, offset + CHUNK);
    const { count: created } = await prisma.address.createMany({
      data: slice.map((id) => ({
        id: id.addressId,
        userId: id.userId,
        label: "Home",
        line1: "1, Load Test Lane",
        pincode: "560095",
        lat,
        lng,
        isDefault: true,
      })),
      skipDuplicates: true,
    });
    addressesCreated += created;
  }

  // Stock: `POST /v1/orders` decrements Product.stockQty under a conditional
  // UPDATE; Batch rows are only consumed later in the pipeline, but leaving them
  // at 180 while stockQty says a million is needlessly confusing, so move both.
  const products = await prisma.product.updateMany({ data: { stockQty: STOCK_QTY } });
  const batches = await prisma.batch.updateMany({
    data: { qtyAvailable: STOCK_QTY, qtyReceived: STOCK_QTY },
  });

  const first = loadIdentity(0);
  console.log(
    [
      `load fixture ready: pool=${count}`,
      `users +${usersCreated} (rest already present)`,
      `addresses +${addressesCreated}`,
      `stock set to ${STOCK_QTY} on ${products.count} products / ${batches.count} batches`,
      `first token: dev:${first.firebaseUid}:${first.phone}`,
    ].join("\n  "),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
