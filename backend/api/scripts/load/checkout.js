/**
 * k6 load sanity for the COD checkout path (Blueprint §21.3 / §23 Phase 7):
 * "50 concurrent checkouts". Drives browse → add-to-cart → create COD order over
 * real HTTP and asserts latency/error thresholds. Run against a LOAD/STAGING env
 * (never prod) with a seeded catalog + open store.
 *
 * TWO MODES
 * ---------
 * 1) POOL MODE (`-e LOAD_USERS=<n>`, what CI uses — .github/workflows/load-test.yml).
 *    Every ITERATION authenticates as its own disposable account, provisioned by
 *    `scripts/load/seed-load-users.ts`. This is not a nicety; three server rules
 *    make a shared account impossible to load-test:
 *      - `Cart` is unique per user and `POST /v1/orders` deletes the cart lines
 *        in-transaction, so concurrent VUs on one account drain each other's
 *        carts → 422 "Your cart is empty" (and the successes measure a
 *        non-deterministic basket);
 *      - velocity rule §10.3 caps one account at MAX_ORDERS_PER_HOUR = 3 → 429;
 *      - the new-account COD cap applies to each account's first order.
 *    Identity is derived arithmetically from the global iteration number, so it
 *    costs no extra request:
 *      dev:load-<i>:+9155<i padded to 8>   /   addressId  load-addr-<i>
 *    KEEP IN SYNC WITH `loadIdentity()` in scripts/load/seed-load-users.ts.
 *
 * 2) SINGLE-TOKEN MODE (default — no LOAD_USERS). Everything runs as one
 *    account and the address is resolved from `GET /v1/addresses`, exactly as
 *    before, so a manual smoke run against an ordinary seed still works:
 *
 *      k6 run -e BASE_URL=https://staging-api.medrush.in \
 *             -e TOKEN='dev:seed-firebase-customer:+919876543210' \
 *             backend/api/scripts/load/checkout.js
 *
 *    Expect 429s past the 3rd order per hour in this mode — it is a smoke run,
 *    not a benchmark.
 *
 * NOTE: each iteration places a real order (reserves stock). Point it at a
 * disposable DB with generous stock, or lower the iteration count.
 */
/* global __ENV -- injected by the k6 runtime, not Node */
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep, fail } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const TOKEN = __ENV.TOKEN || "dev:seed-firebase-customer:+919876543210";

/** Size of the disposable-account pool seeded by seed-load-users.ts. 0 = single-token mode. */
const LOAD_USERS = Number(__ENV.LOAD_USERS || 0);

/**
 * New-account COD cap (§10.3 `new_account_cod_cap`, NEW_ACCOUNT_COD_CAP_PAISE in
 * packages/contracts/src/domain.ts). It is a server-side flag with no public
 * endpoint, so the basket builder below has to be told what it is. In pool mode
 * EVERY order is the account's first, so this — not codLimitPaise — is the real
 * ceiling. Override if the target deployment has moved the flag.
 */
const FIRST_ORDER_COD_CAP_PAISE = Number(__ENV.FIRST_ORDER_COD_CAP_PAISE || 50000);

/**
 * Thresholds. The two ERROR-rate gates are the regression signal this job
 * exists for and are meant to stay at these values; the LATENCY gates are
 * overridable because the same script has to be defensible both on a shared
 * 4-vCPU GitHub runner (API + Postgres + k6 all on one box) and against real
 * staging hardware. Defaults here are the production-intent numbers; the CI job
 * loosens the two latency ones explicitly and says so in its own comments.
 */
const MAX_HTTP_FAIL_RATE = Number(__ENV.MAX_HTTP_FAIL_RATE || 0.01);
const MAX_ORDER_ERROR_RATE = Number(__ENV.MAX_ORDER_ERROR_RATE || 0.02);
const P95_CHECKOUT_MS = Number(__ENV.P95_CHECKOUT_MS || 1500);
const P95_REQUEST_MS = Number(__ENV.P95_REQUEST_MS || 800);

const orderErrors = new Rate("order_errors");
const checkoutDuration = new Trend("checkout_duration", true);

export const options = {
  scenarios: {
    // Ramp to 50 concurrent virtual users placing COD orders.
    // 2,750 VU·seconds; `sleep(1)` floors an iteration at 1s, so the run can
    // never exceed 2,750 iterations — which is what sizes the account pool.
    checkouts: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 50 },
        { duration: "40s", target: 50 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: [`rate<${MAX_HTTP_FAIL_RATE}`], // transport failures + any 4xx/5xx
    order_errors: [`rate<${MAX_ORDER_ERROR_RATE}`], // failed checkouts
    checkout_duration: [`p(95)<${P95_CHECKOUT_MS}`], // create-order latency
    http_req_duration: [`p(95)<${P95_REQUEST_MS}`], // all requests
  },
};

/**
 * Deterministic identity for pool member `index` (0-based).
 * MIRRORED IN `loadIdentity()` in scripts/load/seed-load-users.ts — change both.
 */
function loadIdentity(index) {
  const n = String(index).padStart(8, "0");
  return {
    token: `dev:load-${index}:+9155${n}`,
    addressId: `load-addr-${index}`,
  };
}

function headers(token, extra) {
  return Object.assign(
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    extra || {},
  );
}

/**
 * Pick `{ p1 (qty 2), p2 (qty 1) }` whose items total lands inside the window
 * the server will accept, so the job never goes red for a fixture reason:
 *
 *   itemsPaise >= StoreConfig.minOrderPaise          (else 422 MIN_ORDER_NOT_MET)
 *   itemsPaise + deliveryBasePaise <= ceiling        (else 422 COD_LIMIT_EXCEEDED)
 *   ceiling = min(codLimitPaise, first-order COD cap)
 *
 * The default catalog listing is ordered by cuid, so "the first two in-stock
 * products" is effectively random per seed — with the demo seed it can easily be
 * 2×₹20 + ₹22, which is below the ₹99 minimum and fails 100% of checkouts.
 * Choosing the most expensive affordable pair is deterministic and keeps the
 * basket a realistic 2 lines / 3 units. Delivery is charged pessimistically
 * (the free-delivery threshold can only make the total smaller).
 */
function pickBasket(products, minOrderPaise, deliveryBasePaise, ceiling) {
  const budget = ceiling - deliveryBasePaise;
  const candidates = products
    .filter((p) => !p.requiresRx && p.inStock && p.maxPerOrder >= 2)
    // Price desc, id asc — total ordering, so the choice is reproducible.
    .sort((a, b) => b.pricePaise - a.pricePaise || (a.id < b.id ? -1 : 1));

  let best = null;
  for (const a of candidates) {
    if (a.pricePaise * 2 > budget) continue;
    for (const b of candidates) {
      if (b.id === a.id) continue;
      const total = a.pricePaise * 2 + b.pricePaise;
      if (total > budget || total < minOrderPaise) continue;
      if (best === null || total > best.itemsPaise) {
        best = { p1: a.id, p2: b.id, itemsPaise: total };
      }
    }
  }
  return best;
}

export function setup() {
  // Single-token mode still uses TOKEN for setup; pool mode borrows member 0,
  // which exists whenever LOAD_USERS >= 1.
  const setupToken = LOAD_USERS > 0 ? loadIdentity(0).token : TOKEN;

  const store = http.get(`${BASE_URL}/v1/store`, { headers: headers(setupToken) });
  if (store.status !== 200) fail(`GET /v1/store returned ${store.status} (is the API up?)`);
  const storeConfig = store.json("data") || {};
  const minOrderPaise = storeConfig.minOrderPaise || 0;
  const deliveryBasePaise = storeConfig.deliveryBasePaise || 0;
  const codLimitPaise = storeConfig.codLimitPaise || FIRST_ORDER_COD_CAP_PAISE;
  const ceiling = Math.min(codLimitPaise, FIRST_ORDER_COD_CAP_PAISE);

  if (storeConfig.isOpen !== true) {
    fail("store is marked closed — checkout will 422 STORE_CLOSED for every iteration");
  }

  // 50 is the server-side max for `limit` (CursorQuerySchema).
  const products = http.get(`${BASE_URL}/v1/products?limit=50`, { headers: headers(setupToken) });
  check(products, { "catalog 200": (r) => r.status === 200 });
  const basket = pickBasket(
    products.json("data") || [],
    minOrderPaise,
    deliveryBasePaise,
    ceiling,
  );
  if (basket === null) {
    fail(
      `no 2-product basket fits [${minOrderPaise}, ${ceiling - deliveryBasePaise}] paise — ` +
        "seed the target DB with in-stock non-Rx products in that price band",
    );
  }

  // Pool mode derives the address id; single-token mode resolves it once.
  let addressId = null;
  if (LOAD_USERS === 0) {
    const addresses = http.get(`${BASE_URL}/v1/addresses`, { headers: headers(setupToken) });
    const address = (addresses.json("data") || [])[0];
    if (!address) fail("customer has no address on the target DB");
    addressId = address.id;
  }

  return { p1: basket.p1, p2: basket.p2, addressId };
}

export default function (data) {
  // `iterationInTest` is unique across every VU in the scenario, so in pool mode
  // no two in-flight iterations can ever share a cart or an account.
  const iteration = exec.scenario.iterationInTest;

  let token = TOKEN;
  let addressId = data.addressId;
  if (LOAD_USERS > 0) {
    if (iteration >= LOAD_USERS) {
      // Loud rather than silent: reusing a pool member would reintroduce the
      // shared-cart and velocity failures this design exists to avoid.
      orderErrors.add(true);
      fail(`account pool exhausted at iteration ${iteration} — raise LOAD_USERS (${LOAD_USERS})`);
    }
    const identity = loadIdentity(iteration);
    token = identity.token;
    addressId = identity.addressId;
  }

  // Browse (read path).
  const list = http.get(`${BASE_URL}/v1/products?limit=50`, { headers: headers(token) });
  check(list, { "browse 200": (r) => r.status === 200 });

  // Add two items to the server cart.
  http.put(`${BASE_URL}/v1/cart/items`, JSON.stringify({ productId: data.p1, qty: 2 }), {
    headers: headers(token),
  });
  http.put(`${BASE_URL}/v1/cart/items`, JSON.stringify({ productId: data.p2, qty: 1 }), {
    headers: headers(token),
  });

  // Create a COD order. IdempotencyKey.key is globally unique (not per-user), so
  // the key is keyed on the globally unique iteration number.
  const idem = `load-${iteration}-${Date.now()}`;
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/v1/orders`,
    JSON.stringify({ addressId, paymentMethod: "COD" }),
    { headers: headers(token, { "Idempotency-Key": idem }) },
  );
  checkoutDuration.add(Date.now() - start);

  const ok = check(res, {
    "order created": (r) => r.status === 200 || r.status === 201,
    "order PLACED": (r) => (r.json("data.order.status") || "") === "PLACED",
  });
  orderErrors.add(!ok);

  sleep(1);
}
