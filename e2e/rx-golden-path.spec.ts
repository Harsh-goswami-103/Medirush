import { expect, test } from "@playwright/test";
import { ORDER_NO_RE, resetDemoCart } from "./helpers";
import { OPS_URL } from "./stack";

/**
 * Rx golden path — the prescription journey the plain golden path can't cover
 * (§22.1), driven through real dev-mode UIs against the seeded catalog:
 *
 *  1. customer: dev login → open a Schedule-H product → add to cart → COD
 *     checkout (lands in RX_REVIEW, no payment sheet) → upload a prescription;
 *  2. ops: pharmacist dev login → Rx review queue → approve → start packing →
 *     mark ready, asserting FEFO picked the earliest-expiry batch on the way.
 *
 * Serial on purpose: test 2 adjudicates the prescription test 1 uploaded. A
 * retry reruns the whole group, so each attempt places a fresh order. Checkout
 * enforces 3 orders/hour/account (orders/service.ts assertVelocity): a clean
 * full run places 2 (golden path + this), so only a run where BOTH serial
 * groups retry can trip it — and global-setup deletes previous runs' orders
 * (sql/reset-demo-orders.sql), so local re-runs don't accumulate to the cap.
 */

/** Seeded Schedule-H antibiotic (backend/api/prisma/seed.ts) — at ₹119 one
 * unit clears the ₹99 minimum order and stays far under the ₹1500 COD limit. */
const PRODUCT = { name: "Azithral 500 Tablet", slug: "azithral-500-tablet" };

/**
 * Azithral is PRODUCTS[8] in seed.ts, so its batches are numbered
 * B09{1,2,3}{YYMM} and batch 1 always carries the earliest expiry — FEFO must
 * pick B091…. (The YYMM tail tracks the seed run date; match the stable
 * prefix only. On a long-lived dev DB, reseed if batch B091… ever drains.)
 */
const FEFO_PICK_RE = /FEFO: B091\d{4}×1/;
const PACKED_BATCH_RE = /Batches: B091\d{4}×1/;

/** A genuine 1×1 PNG — the API sniffs magic bytes AND re-encodes images
 * through sharp, so the fixture must actually decode, not just look right. */
const RX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.describe.configure({ mode: "serial" });

/** Order number handed from the customer test to the ops test. */
let orderNo = "";

test("customer places a COD order for an Rx product and uploads a prescription", async ({
  page,
  request,
}) => {
  await resetDemoCart(request);

  // Dev login as the seeded demo customer (Firebase unconfigured → dev build
  // shows the one-tap button; production builds tree-shake it away).
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue as demo customer" }).click();
  await page.waitForURL("**/account");

  // Straight to the Schedule-H product — storefront browsing is already
  // covered by golden-path.spec.ts; here the Rx marking is what matters.
  await page.goto(`/p/${PRODUCT.slug}`);
  await expect(page.getByRole("heading", { name: PRODUCT.name }).first()).toBeVisible();
  await expect(page.getByText("Rx", { exact: true }).first()).toBeVisible();
  // Scoped to the sticky action bar — the substitutes/similar rails render
  // their own per-card "Add" buttons on the PDP.
  await page.getByTestId("pdp-action-bar").getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("link", { name: "Go to cart" }).click();
  await page.waitForURL("**/cart");

  // The cart flags the prescription requirement but must not block checkout —
  // upload happens after placing the order.
  await expect(page.getByText(/needs a prescription/)).toBeVisible();
  await page.getByRole("button", { name: "Proceed to checkout" }).click();
  await page.waitForURL("**/checkout");

  // Seeded default address auto-selected; wait for serviceability, confirm the
  // Rx notice, then place a COD order — for Rx the client never opens a
  // payment sheet and routes straight to the order page.
  await expect(page.getByText(/^Deliverable/)).toBeVisible();
  await expect(page.getByText(/contains prescription items/)).toBeVisible();
  await page.getByRole("radio", { name: /cash on delivery/i }).check();
  const placeOrder = page.getByRole("button", { name: /^Place order/ });
  await expect(placeOrder).toBeEnabled();
  await placeOrder.click();

  // An Rx COD order lands in RX_REVIEW (not PLACED), prescription pending.
  await page.waitForURL(/\/orders\/[^/]+$/);
  const title = page.getByRole("heading", { name: ORDER_NO_RE });
  await expect(title).toBeVisible();
  orderNo = ((await title.textContent()) ?? "").trim();
  expect(orderNo).toMatch(ORDER_NO_RE);
  await expect(page.getByText("RX REVIEW", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Rx pending")).toBeVisible();

  // Upload a prescription image through the hidden file input.
  await expect(page.getByRole("heading", { name: "Prescription", exact: true })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "rx.png",
    mimeType: "image/png",
    buffer: RX_PNG,
  });

  // Durable proof (outlives the "Prescription uploaded" toast): the upload
  // list entry appears with its own "Rx pending" badge next to the header one.
  await expect(page.getByText("Rx pending")).toHaveCount(2);
});

test("pharmacist approves the Rx, packs FEFO and marks the order ready", async ({ page }) => {
  expect(orderNo, "the customer test must have produced an order number").toMatch(ORDER_NO_RE);

  // Dev quick sign-in as the seeded pharmacist (INVENTORY role).
  await page.goto(`${OPS_URL}/login`);
  await page.getByRole("button", { name: /inventory \(pharmacist\)/i }).click();
  await page.waitForURL("**/orders");

  // The board's default pill is "New" (PLACED) — Rx orders queue under
  // "Rx review". Open the fresh order from there.
  await page.getByRole("button", { name: "Rx review", exact: true }).click();
  await page.getByRole("link", { name: orderNo }).click();
  await page.waitForURL(/\/orders\/[^/]+$/);
  await expect(page.getByRole("heading", { name: orderNo })).toBeVisible();
  await expect(page.getByText("Rx pending").first()).toBeVisible();

  // Review panel: record the register names and approve. No confirmation
  // dialog — each ops mutation refetches the order on success.
  await expect(page.getByText("Prescription review")).toBeVisible();
  await page.getByPlaceholder("Patient name (H1)").fill("Ananya Sharma");
  await page.getByPlaceholder("Doctor name (H1)").fill("Meera Nair");
  await page.getByRole("button", { name: "Approve", exact: true }).click();

  // Approval flips rxStatus only — the order stays in RX_REVIEW until packing
  // starts (opsService.ts). The captured names render on the prescription card.
  await expect(page.getByText("Rx approved").first()).toBeVisible();
  await expect(page.getByText("Patient: Ananya Sharma")).toBeVisible();

  // Pack: the server's FEFO pre-fill must pick the earliest-expiry batch.
  await page.getByRole("button", { name: "Start packing" }).click();
  await expect(page.getByText("PACKING", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(FEFO_PICK_RE)).toBeVisible();

  const markReady = page.getByRole("button", { name: "Mark ready (FEFO)" });
  await expect(markReady).toBeEnabled();
  await markReady.click();

  // READY: the allocation snapshot pins the same earliest-expiry batch.
  await expect(page.getByText("READY", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(PACKED_BATCH_RE)).toBeVisible();
});
