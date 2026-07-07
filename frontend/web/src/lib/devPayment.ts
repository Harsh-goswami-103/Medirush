import { API_BASE_URL } from "./env";
import { FIREBASE_ENABLED } from "./env";

/**
 * Dev-only prepaid simulation. With no real Razorpay keys there is no Checkout
 * sheet and no real webhook, so this HMAC-signs a `payment.captured` event with
 * the dev webhook secret (exactly what the P2 tests do) and POSTs it to the
 * public webhook — exercising the real capture → PLACED path locally.
 *
 * `razorpayConfigured` tells the checkout whether to use Checkout.js (real) or
 * this dev fallback.
 */

const DEV_WEBHOOK_SECRET = "dev-webhook-secret";

/** True when the real Razorpay client key is configured (use Checkout.js then). */
export const razorpayConfigured = Boolean(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) || FIREBASE_ENABLED;

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Simulate a successful capture for a stub Razorpay order (dev only). */
export async function devSimulatePayment(rzpOrderId: string, amountPaise: number): Promise<void> {
  const eventId = `evt_dev_${rzpOrderId}`;
  const body = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_dev_${rzpOrderId}`,
          order_id: rzpOrderId,
          amount: amountPaise,
          status: "captured",
        },
      },
    },
  });
  const signature = await hmacHex(DEV_WEBHOOK_SECRET, body);
  const res = await fetch(`${API_BASE_URL}/v1/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    body,
  });
  if (!res.ok) throw new Error(`Dev payment simulation failed (${res.status})`);
}
