import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig, type Config } from "./config";

/**
 * Razorpay client (BLUEPRINT §9.3, §14) — the real SDK in production, a
 * deterministic local STUB in dev/test. Same code path, config-selected (Phase 2
 * overriding principle: every third-party integration has a LOCAL STUB MODE).
 *
 * - REAL when `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` are both set: the
 *   `razorpay` SDK creates orders/refunds against the live API.
 * - STUB otherwise: `createRazorpayOrder` returns `{ id: "order_"+rand, … }` and
 *   `createRazorpayRefund` returns `{ id: "rfnd_"+rand, status: "processed" }` —
 *   no network, no keys, fully exercisable offline.
 *
 * The webhook signature path is IDENTICAL in both modes: HMAC-SHA256 over the
 * raw request body keyed by `RAZORPAY_WEBHOOK_SECRET ?? "dev-webhook-secret"`.
 * So tests locally sign a payload and exercise the real verification code.
 *
 * External I/O — every function here is called OUTSIDE any DB transaction (§14).
 *
 * Pinned cross-agent surface (payments/service, payments/webhook, orders/service):
 *   createRazorpayOrder(amountPaise, receipt): Promise<{ id; amount; currency:"INR" }>
 *   createRazorpayRefund(paymentId, amountPaise): Promise<{ id; status }>
 *   verifyWebhookSignature(rawBody, signature): boolean
 *   razorpayKeyId(): string
 */

/** Fallback webhook secret in dev/test so signing works with no real key (§9.3). */
const DEV_WEBHOOK_SECRET = "dev-webhook-secret";
/** Public key id surfaced to the client in stub mode (opens Checkout.js in a mock). */
const STUB_KEY_ID = "rzp_test_stub";

/** Real Razorpay is selected only when both key parts are present. */
function isRealRazorpay(config: Config): boolean {
  return Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);
}

/** `order_`/`rfnd_`-prefixed opaque id, shaped like Razorpay's own ids. */
function stubId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

/**
 * Lazily-built real SDK handle: the `razorpay` package is imported only when
 * real credentials are configured, so stub-mode runs (dev/test) never load it.
 */
interface RazorpayHandle {
  createOrder(amountPaise: number, receipt: string): Promise<{ id: string; amount: number }>;
  createRefund(paymentId: string, amountPaise: number): Promise<{ id: string; status: string }>;
}

let sdkPromise: Promise<RazorpayHandle> | null = null;

async function getSdk(config: Config): Promise<RazorpayHandle> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const { default: Razorpay } = await import("razorpay");
      const client = new Razorpay({
        key_id: config.RAZORPAY_KEY_ID as string,
        key_secret: config.RAZORPAY_KEY_SECRET as string,
      });
      return {
        async createOrder(amountPaise, receipt) {
          const order = await client.orders.create({
            amount: amountPaise,
            currency: "INR",
            receipt,
          });
          return { id: order.id, amount: Number(order.amount) };
        },
        async createRefund(paymentId, amountPaise) {
          const refund = await client.payments.refund(paymentId, { amount: amountPaise });
          return { id: refund.id, status: String(refund.status) };
        },
      };
    })();
  }
  return sdkPromise;
}

/** Create a Razorpay order for a PREPAID checkout. Amount is integer paise. */
export async function createRazorpayOrder(
  amountPaise: number,
  receipt: string,
): Promise<{ id: string; amount: number; currency: "INR" }> {
  const config = getConfig();
  if (isRealRazorpay(config)) {
    const sdk = await getSdk(config);
    const order = await sdk.createOrder(amountPaise, receipt);
    return { id: order.id, amount: order.amount, currency: "INR" };
  }
  return { id: stubId("order_"), amount: amountPaise, currency: "INR" };
}

/** Refund a captured payment (full or partial). Amount is integer paise. */
export async function createRazorpayRefund(
  paymentId: string,
  amountPaise: number,
): Promise<{ id: string; status: string }> {
  const config = getConfig();
  if (isRealRazorpay(config)) {
    const sdk = await getSdk(config);
    return sdk.createRefund(paymentId, amountPaise);
  }
  return { id: stubId("rfnd_"), status: "processed" };
}

/** The webhook signing secret — real key in prod, deterministic fallback in dev/test. */
function webhookSecret(): string {
  return getConfig().RAZORPAY_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET;
}

/** Deterministic HMAC-SHA256 hex signature for `rawBody` — used by tests to sign. */
export function signWebhookBody(rawBody: string): string {
  return createHmac("sha256", webhookSecret()).update(rawBody).digest("hex");
}

/**
 * Verify the `x-razorpay-signature` header against an HMAC-SHA256 of the raw body
 * (§10.1 payment tampering). Constant-time compare; identical code in both modes.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const expected = signWebhookBody(rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on length mismatch — guard so a wrong-length sig is
  // simply "invalid", not an exception.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Public Razorpay key id handed to the client for Checkout.js. Stub id in dev/test. */
export function razorpayKeyId(): string {
  const config = getConfig();
  return isRealRazorpay(config) ? (config.RAZORPAY_KEY_ID as string) : STUB_KEY_ID;
}

/** Test-only: drop the memoised SDK handle (config changes between suites). */
export function resetRazorpayForTests(): void {
  sdkPromise = null;
}
