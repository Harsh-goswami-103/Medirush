import { expect, test, type APIRequestContext } from "@playwright/test";
import { API_URL, DEMO_CUSTOMER_TOKEN, OPS_URL } from "./stack";

/**
 * Golden path — the money-critical customer journey (§22.1), driven through
 * real dev-mode UIs against the seeded catalog:
 *
 *  1. customer: dev login → browse catalog → open a non-Rx product → add to
 *     cart → COD checkout → order confirmation shows an MR-… number, PLACED;
 *  2. ops: pharmacist dev login → the same order number is on the order board.
 *
 * Serial on purpose: test 2 asserts on the order test 1 placed. A retry reruns
 * the whole group, so each attempt places (and then observes) a fresh order.
 */

/** Seeded non-Rx product (backend/api/prisma/seed.ts) — at ₹148 a single unit
 * clears the ₹99 minimum order and stays well under the ₹1500 COD limit. */
const PRODUCT = { name: "Vicks VapoRub 50ml", slug: "vicks-vaporub-50ml" };

const ORDER_NO_RE = /^MR-\d{6}-\d{4}$/;

test.describe.configure({ mode: "serial" });

/** Order number handed from the customer test to the ops test. */
let orderNo = "";

/**
 * The demo customer's cart is server-side and survives dev sessions — empty it
 * so the run always starts from a clean cart. (`auth/sync` first: on a freshly
 * seeded DB it's a no-op, but it also makes the cleanup self-sufficient.)
 */
async function resetDemoCart(request: APIRequestContext): Promise<void> {
  const headers = { authorization: `Bearer ${DEMO_CUSTOMER_TOKEN}` };
  await request.post(`${API_URL}/v1/auth/sync`, { headers, data: {} });
  const res = await request.get(`${API_URL}/v1/cart`, { headers });
  expect(res.ok(), `GET /v1/cart failed: ${res.status()}`).toBeTruthy();
  const cart = (await res.json()) as { data: { items: Array<{ productId: string }> } };
  for (const item of cart.data.items) {
    await request.delete(`${API_URL}/v1/cart/items/${item.productId}`, { headers });
  }
}

test("customer places a COD order for a non-Rx product (golden path)", async ({
  page,
  request,
}) => {
  await resetDemoCart(request);

  // Dev login as the seeded demo customer (Firebase unconfigured → dev build
  // shows the one-tap button; production builds tree-shake it away).
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue as demo customer" }).click();
  await page.waitForURL("**/account");

  // Browse the seeded catalog and open the product.
  await page.goto("/");
  const productCard = page.getByRole("link", { name: new RegExp(PRODUCT.name, "i") });
  await expect(productCard).toBeVisible();
  await productCard.click();
  await page.waitForURL(`**/p/${PRODUCT.slug}`);

  // Non-Rx product detail → add to cart → cart.
  //
  // Historical note: this click once failed in real browsers because the CORS
  // preflight rejected cross-origin PUT/PATCH/DELETE (found by this suite,
  // 2026-07-13). Fixed since — app.ts passes `methods` to @fastify/cors and
  // backend/api/test/cors-preflight.test.ts pins it — so a red run here is a
  // real regression, not that known blocker.
  await expect(page.getByRole("heading", { name: PRODUCT.name }).first()).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("link", { name: "Go to cart" }).click();
  await page.waitForURL("**/cart");

  // Cart shows the line → proceed to checkout.
  await expect(page.getByRole("link", { name: PRODUCT.name }).first()).toBeVisible();
  await page.getByRole("button", { name: "Proceed to checkout" }).click();
  await page.waitForURL("**/checkout");

  // The seeded default address is auto-selected; wait for the serviceability
  // check to come back green before the CTA can enable.
  await expect(page.getByText(/^Deliverable/)).toBeVisible();

  // Pay by COD and place the order.
  await page.getByRole("radio", { name: /cash on delivery/i }).check();
  const placeOrder = page.getByRole("button", { name: /^Place order/ });
  await expect(placeOrder).toBeEnabled();
  await placeOrder.click();

  // Confirmation = the order detail page: MR-… number in the title, PLACED
  // status, COD payment summary.
  await page.waitForURL(/\/orders\/[^/]+$/);
  const title = page.getByRole("heading", { name: ORDER_NO_RE });
  await expect(title).toBeVisible();
  orderNo = ((await title.textContent()) ?? "").trim();
  expect(orderNo).toMatch(ORDER_NO_RE);
  await expect(page.getByText("PLACED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Cash on delivery")).toBeVisible();
});

test("ops pharmacist sees the new order on the board", async ({ page }) => {
  expect(orderNo, "the customer test must have produced an order number").toMatch(ORDER_NO_RE);

  // Dev quick sign-in as the seeded pharmacist (INVENTORY role).
  await page.goto(`${OPS_URL}/login`);
  await page.getByRole("button", { name: /inventory \(pharmacist\)/i }).click();
  await page.waitForURL("**/orders");

  // The board's default filter is "New" (status PLACED) — the fresh COD order
  // must be listed with its status and payment method.
  const row = page.getByRole("row").filter({ hasText: orderNo });
  await expect(page.getByRole("link", { name: orderNo })).toBeVisible();
  await expect(row).toContainText("PLACED");
  await expect(row).toContainText("COD");
});
