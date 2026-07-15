import { expect, type APIRequestContext } from "@playwright/test";
import { API_URL, DEMO_CUSTOMER_TOKEN } from "./stack";

/** MR-YYMMDD-NNNN order numbers minted by the API. */
export const ORDER_NO_RE = /^MR-\d{6}-\d{4}$/;

/**
 * The demo customer's cart is server-side and survives dev sessions — empty it
 * so the run always starts from a clean cart. (`auth/sync` first: on a freshly
 * seeded DB it's a no-op, but it also makes the cleanup self-sufficient.)
 */
export async function resetDemoCart(request: APIRequestContext): Promise<void> {
  const headers = { authorization: `Bearer ${DEMO_CUSTOMER_TOKEN}` };
  await request.post(`${API_URL}/v1/auth/sync`, { headers, data: {} });
  const res = await request.get(`${API_URL}/v1/cart`, { headers });
  expect(res.ok(), `GET /v1/cart failed: ${res.status()}`).toBeTruthy();
  const cart = (await res.json()) as { data: { items: Array<{ productId: string }> } };
  for (const item of cart.data.items) {
    await request.delete(`${API_URL}/v1/cart/items/${item.productId}`, { headers });
  }
}
