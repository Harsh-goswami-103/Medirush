import type { OrderDetail, RazorpayCheckout } from "@medrush/contracts";
import { api, ApiError } from "./api";
import { devSimulatePayment, razorpayConfigured } from "./devPayment";

/**
 * Shared prepaid-collection flow, used by BOTH the checkout submit and the
 * order-detail "Complete payment" retry (GET /v1/orders/:id/payment) so the
 * sheet-opening logic exists exactly once. Real keys → Razorpay Checkout.js;
 * dev stub → HMAC-signed webhook simulation (see lib/devPayment.ts).
 */

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { contact?: string };
  handler: () => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
}

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { Razorpay?: unknown };
    if (w.Razorpay) return resolve();
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new ApiError("INTERNAL", "Could not load the payment SDK", 0));
    document.body.appendChild(script);
  });
}

/** Open the real Razorpay Checkout sheet; resolves on capture, rejects on dismiss. */
async function openRazorpay(
  rzp: RazorpayCheckout,
  opts: { name: string; contact?: string },
): Promise<void> {
  await loadRazorpayScript();
  return new Promise<void>((resolve, reject) => {
    const Ctor = (window as unknown as { Razorpay?: new (o: RazorpayOptions) => { open: () => void } }).Razorpay;
    if (!Ctor) {
      reject(new ApiError("INTERNAL", "Payment SDK unavailable", 0));
      return;
    }
    let settled = false;
    const rz = new Ctor({
      key: rzp.rzpKeyId,
      order_id: rzp.rzpOrderId,
      amount: rzp.amountPaise,
      currency: rzp.currency,
      name: opts.name,
      description: "Order payment",
      ...(opts.contact ? { prefill: { contact: opts.contact } } : {}),
      handler: () => {
        settled = true;
        resolve();
      },
      modal: {
        ondismiss: () => {
          if (!settled) reject(new ApiError("INTERNAL", "Payment cancelled", 0));
        },
      },
      theme: { color: "#0d9488" },
    });
    rz.open();
  });
}

/**
 * Collect a prepaid payment for an existing Razorpay order: the real Checkout
 * sheet when keys are configured, the dev webhook simulation otherwise (keeps
 * the local capture → PLACED path working with no Razorpay account).
 */
export async function collectPayment(
  rzp: RazorpayCheckout,
  opts: { name: string; contact?: string },
): Promise<void> {
  if (razorpayConfigured) {
    await openRazorpay(rzp, opts);
  } else {
    await devSimulatePayment(rzp.rzpOrderId, rzp.amountPaise);
  }
}

/**
 * Poll the order until payment clears the webhook (best-effort; ~10s cap).
 * Resolves `true` once the order is observed out of PENDING_PAYMENT, `false`
 * when the cap elapses first — callers must NOT claim success on `false`
 * (show a "confirming" state and keep watching the order instead).
 */
export async function pollUntilPaid(orderId: string, token?: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const { data } = await api.get<OrderDetail>(
        `/v1/orders/${orderId}`,
        token !== undefined ? { token } : undefined,
      );
      if (data.status !== "PENDING_PAYMENT") return true;
    } catch {
      /* transient — keep polling */
    }
  }
  return false;
}
