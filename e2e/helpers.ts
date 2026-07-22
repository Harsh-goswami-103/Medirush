import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { API_URL, DEMO_CUSTOMER_TOKEN } from "./stack";

/** MR-YYMMDD-NNNN order numbers minted by the API. */
export const ORDER_NO_RE = /^MR-\d{6}-\d{4}$/;

/** Backend dev bearer shape — `dev:<firebaseUid>:<phoneE164>`. */
const DEV_TOKEN_RE = /dev:[^:\s"]+:\+?\d{6,}/;

/**
 * Security regression guard: no bearer may reach Web Storage in either app.
 * Both stores are scanned by VALUE shape rather than by the single key older
 * builds used, so a rename or a new mirror is caught too.
 */
export async function expectNoStoredBearer(page: Page): Promise<void> {
  const leaked = await page.evaluate((source) => {
    const re = new RegExp(source);
    const hits: string[] = [];
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) ?? "";
        const value = store.getItem(key) ?? "";
        if (re.test(key) || re.test(value)) hits.push(key);
      }
    }
    return hits;
  }, DEV_TOKEN_RE.source);
  expect(leaked, "bearer token found in localStorage/sessionStorage").toEqual([]);
}

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
