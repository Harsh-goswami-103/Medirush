/**
 * k6 load sanity for the COD checkout path (Blueprint §21.3 / §23 Phase 7):
 * "50 concurrent checkouts". Drives browse → add-to-cart → create COD order over
 * real HTTP and asserts latency/error thresholds. Run against a LOAD/STAGING env
 * (never prod) with a seeded catalog + open store.
 *
 *   k6 run -e BASE_URL=https://staging-api.medrush.in \
 *          -e TOKEN='dev:seed-firebase-customer:+919876543210' \
 *          backend/api/scripts/load/checkout.js
 *
 * NOTE: each iteration places a real order (reserves stock). Point it at a
 * disposable DB with generous stock, or lower the iteration count. It is NOT run
 * in CI (needs the k6 binary + a running target).
 */
/* global __ENV, __VU, __ITER -- injected by the k6 runtime, not Node */
import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const TOKEN = __ENV.TOKEN || "dev:seed-firebase-customer:+919876543210";

const orderErrors = new Rate("order_errors");
const checkoutDuration = new Trend("checkout_duration", true);

export const options = {
  scenarios: {
    // Ramp to 50 concurrent virtual users placing COD orders.
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
    http_req_failed: ["rate<0.01"], // < 1% transport failures
    order_errors: ["rate<0.02"], // < 2% failed checkouts
    checkout_duration: ["p(95)<1500"], // p95 create-order < 1.5s
    http_req_duration: ["p(95)<800"], // p95 all requests < 800ms
  },
};

function headers(extra) {
  return Object.assign(
    { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    extra || {},
  );
}

export function setup() {
  // Resolve two in-stock, non-Rx products + the customer's address once.
  const products = http.get(`${BASE_URL}/v1/products?limit=50`, { headers: headers() });
  check(products, { "catalog 200": (r) => r.status === 200 });
  const inStock = (products.json("data") || []).filter((p) => !p.requiresRx && p.inStock);
  if (inStock.length < 2) fail("need >= 2 in-stock non-Rx products (seed the target DB)");

  const addresses = http.get(`${BASE_URL}/v1/addresses`, { headers: headers() });
  const address = (addresses.json("data") || [])[0];
  if (!address) fail("customer has no address on the target DB");

  return { p1: inStock[0].id, p2: inStock[1].id, addressId: address.id };
}

export default function (data) {
  // Browse (read path).
  const list = http.get(`${BASE_URL}/v1/products?limit=50`, { headers: headers() });
  check(list, { "browse 200": (r) => r.status === 200 });

  // Add two items to the server cart.
  http.put(
    `${BASE_URL}/v1/cart/items`,
    JSON.stringify({ productId: data.p1, qty: 2 }),
    { headers: headers() },
  );
  http.put(
    `${BASE_URL}/v1/cart/items`,
    JSON.stringify({ productId: data.p2, qty: 1 }),
    { headers: headers() },
  );

  // Create a COD order (unique Idempotency-Key per attempt).
  const idem = `${__VU}-${__ITER}-${Date.now()}`;
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/v1/orders`,
    JSON.stringify({ addressId: data.addressId, paymentMethod: "COD" }),
    { headers: headers({ "Idempotency-Key": idem }) },
  );
  checkoutDuration.add(Date.now() - start);

  const ok = check(res, {
    "order created": (r) => r.status === 200 || r.status === 201,
    "order PLACED": (r) => (r.json("data.order.status") || "") === "PLACED",
  });
  orderErrors.add(!ok);

  sleep(1);
}
