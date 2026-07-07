"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Address,
  CreateAddressBody,
  CreateOrderBody,
  CreateOrderResult,
  ErrorCode,
  OrderDetail,
  PaymentMethod,
  RazorpayCheckout,
  ServiceabilityResult,
  ValidateCartResult,
} from "@medrush/contracts";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";
import { api, ApiError, type Envelope } from "@/lib/api";
import { API_BASE_URL } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { useStore } from "@/lib/store";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { devSimulatePayment, razorpayConfigured } from "@/lib/devPayment";
import { Button, Card, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { Field, TextInput } from "@/components/kit";
import { TopBar } from "@/components/AppShell";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

/* -------------------------------------------------------- order create helper
 * POST /v1/orders needs an `Idempotency-Key` header, which the shared api client
 * does not set — so this one call goes through a direct fetch that adds the
 * header (+ bearer + json), then parses the §7.1 envelope and throws ApiError. */
async function createOrder(
  body: CreateOrderBody,
  token: string,
  idempotencyKey: string,
): Promise<CreateOrderResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/v1/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError("NETWORK", "Could not reach the server", 0, err);
  }
  const json = (await res.json().catch(() => null)) as
    | (Envelope<CreateOrderResult> & { error?: { code: ErrorCode; message: string } })
    | null;
  if (!res.ok || !json) {
    const error = json?.error;
    throw new ApiError(
      error?.code ?? "INTERNAL",
      error?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return json.data;
}

/* --------------------------------------------------------------- Razorpay */

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
async function openRazorpay(rzp: RazorpayCheckout, opts: { name: string; contact?: string }): Promise<void> {
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

/** Poll the order until payment clears the webhook (best-effort; ~10s cap). */
async function pollUntilPaid(orderId: string, token: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const { data } = await api.get<OrderDetail>(`/v1/orders/${orderId}`, { token });
      if (data.status !== "PENDING_PAYMENT") return;
    } catch {
      /* transient — keep polling */
    }
  }
}

/* ================================================================ page */

const EMPTY_FORM = { label: "", line1: "", line2: "", landmark: "", pincode: "", lat: "", lng: "" };

export default function CheckoutPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, token, loading: authLoading } = useAuth();
  const { store } = useStore();
  const { itemCount } = useCart();

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [coupon, setCoupon] = useState("");
  // One idempotency key per checkout session — a manual retry replays (never
  // double-creates); a fresh checkout (new mount after navigation) gets a new key.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("PREPAID");
  const [showAddrForm, setShowAddrForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [locating, setLocating] = useState(false);

  // Auth guard — browsing is public, checkout is not.
  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  /* ------------------------------------------------------------ queries */

  const validateQuery = useQuery({
    queryKey: ["cart-validate"],
    queryFn: () => api.post<ValidateCartResult>("/v1/cart/validate"),
    enabled: Boolean(user),
  });
  const validate = validateQuery.data?.data;
  const totals = validate?.totals;
  const issues = validate?.issues ?? [];
  const requiresRx = Boolean(validate?.cart.requiresRx);

  const addressesQuery = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<Address[]>("/v1/addresses"),
    enabled: Boolean(user),
  });
  const addresses = addressesQuery.data?.data ?? [];
  const selectedAddress = addresses.find((a) => a.id === selectedAddressId);

  // Auto-pick the default (or first) address once the book loads.
  useEffect(() => {
    if (selectedAddressId || addresses.length === 0) return;
    const def = addresses.find((a) => a.isDefault) ?? addresses[0];
    if (def) setSelectedAddressId(def.id);
  }, [addresses, selectedAddressId]);

  const svcQuery = useQuery({
    queryKey: ["serviceability", selectedAddress?.lat, selectedAddress?.lng],
    queryFn: () =>
      api.post<ServiceabilityResult>("/v1/serviceability", {
        lat: selectedAddress!.lat,
        lng: selectedAddress!.lng,
      }),
    enabled: Boolean(selectedAddress),
  });
  const serviceability = svcQuery.data?.data;

  /* --------------------------------------------------------- COD gating */

  const codAllowed =
    Boolean(store?.featureFlags.codEnabled) &&
    Boolean(totals) &&
    Boolean(store) &&
    totals!.totalPaise <= store!.codLimitPaise;

  // If COD becomes unavailable (flag off / over limit), fall back to PREPAID.
  useEffect(() => {
    if (paymentMethod === "COD" && !codAllowed) setPaymentMethod("PREPAID");
  }, [codAllowed, paymentMethod]);

  /* ------------------------------------------------------- mutations */

  const createAddress = useMutation({
    mutationFn: (body: CreateAddressBody) => api.post<Address>("/v1/addresses", body),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["addresses"] });
      setSelectedAddressId(res.data.id);
      setShowAddrForm(false);
      setForm(EMPTY_FORM);
      toast.push({ type: "success", message: "Address added" });
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: err instanceof ApiError ? err.message : "Could not save address",
      }),
  });

  const placeOrder = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!token) throw new ApiError("INTERNAL", "You are not signed in", 401);
      if (!selectedAddressId) throw new ApiError("INTERNAL", "Select a delivery address", 400);
      const body: CreateOrderBody = {
        addressId: selectedAddressId,
        paymentMethod,
        ...(coupon.trim() ? { couponCode: coupon.trim().toUpperCase() } : {}),
      };
      const result = await createOrder(body, token, idempotencyKey);
      const orderId = result.order.id;

      // Rx orders need pharmacist review before payment — the detail screen owns
      // the Rx upload (and any later payment), so route there straight away.
      if (result.order.requiresRx) return orderId;
      if (paymentMethod === "COD") return orderId;

      // PREPAID, non-Rx → collect payment now.
      const rzp = result.razorpay;
      if (!rzp) return orderId; // defensive: server should always attach it
      if (razorpayConfigured) {
        await openRazorpay(rzp, { name: store?.name ?? "MedRush", contact: user?.phone });
      } else {
        await devSimulatePayment(rzp.rzpOrderId, rzp.amountPaise);
      }
      await pollUntilPaid(orderId, token);
      return orderId;
    },
    onSuccess: (orderId) => {
      void qc.invalidateQueries({ queryKey: ["cart"] });
      void qc.invalidateQueries({ queryKey: ["cart-validate"] });
      router.push(`/orders/${orderId}`);
    },
    onError: (err) =>
      toast.push({
        type: "error",
        message: err instanceof ApiError ? err.message : "Could not place the order",
      }),
  });

  /* --------------------------------------------------- address form */

  function captureLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.push({ type: "error", message: "Location is not available on this device" });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
        }));
        setLocating(false);
        toast.push({ type: "success", message: "Location captured" });
      },
      (err) => {
        setLocating(false);
        toast.push({ type: "error", message: err.message || "Could not read your location" });
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  function submitAddress(e: React.FormEvent) {
    e.preventDefault();
    if (!form.line1.trim()) {
      toast.push({ type: "error", message: "Address line 1 is required" });
      return;
    }
    if (!/^[1-9]\d{5}$/.test(form.pincode)) {
      toast.push({ type: "error", message: "Enter a valid 6-digit pincode" });
      return;
    }
    const lat = Number(form.lat);
    const lng = Number(form.lng);
    const geoOk =
      form.lat !== "" &&
      form.lng !== "" &&
      Number.isFinite(lat) &&
      lat >= -90 &&
      lat <= 90 &&
      Number.isFinite(lng) &&
      lng >= -180 &&
      lng <= 180;
    if (!geoOk) {
      toast.push({ type: "error", message: "Set a location (use my location or enter lat/lng)" });
      return;
    }
    const body: CreateAddressBody = {
      line1: form.line1.trim(),
      pincode: form.pincode,
      lat,
      lng,
      ...(form.label.trim() ? { label: form.label.trim() } : {}),
      ...(form.line2.trim() ? { line2: form.line2.trim() } : {}),
      ...(form.landmark.trim() ? { landmark: form.landmark.trim() } : {}),
    };
    createAddress.mutate(body);
  }

  /* ---------------------------------------------------- block reasoning */

  let blockReason: string | null = null;
  if (!validate) blockReason = "Loading…";
  else if (!validate.valid) blockReason = "Resolve the cart issues above";
  else if (!totals?.minOrderMet)
    blockReason = `Minimum order is ${formatPaise(totals?.minOrderPaise ?? 0)}`;
  else if (!selectedAddressId) blockReason = "Select a delivery address";
  else if (!serviceability)
    blockReason = svcQuery.isError ? "Could not check the delivery area" : "Checking serviceability…";
  else if (!serviceability.serviceable) blockReason = "This address is outside our delivery area";
  else if (store && !store.isOpen) blockReason = "The store is currently closed";

  const canPlace = blockReason === null && !placeOrder.isPending;
  const payLabel = requiresRx || paymentMethod === "COD" ? "Place order" : "Pay & place order";

  /* ------------------------------------------------------------ render */

  if (authLoading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <div>
      <TopBar title="Checkout" back />

      {validateQuery.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : validateQuery.isError ? (
        <div className="p-4">
          <ErrorState
            message={(validateQuery.error as Error).message}
            onRetry={() => validateQuery.refetch()}
          />
        </div>
      ) : !validate || validate.cart.items.length === 0 ? (
        <div className="p-4">
          <EmptyState title="Your cart is empty" hint="Add items before checking out." />
          <Link href="/" className="mt-4 block">
            <Button variant="secondary" className="w-full">
              Browse products
            </Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-4 px-4 py-4 pb-44">
          {/* store closed banner */}
          {store && !store.isOpen && (
            <Card className="border-warning/30 bg-warning/10 p-3">
              <p className="text-sm font-medium text-warning">
                The store is currently closed — orders can’t be placed right now.
              </p>
            </Card>
          )}

          {/* cart issues */}
          {issues.length > 0 && (
            <Card className="border-warning/30 bg-warning/5 p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-warning">Please review your cart</p>
                <button
                  onClick={() => validateQuery.refetch()}
                  className="text-xs font-medium text-primary-700"
                >
                  Re-check
                </button>
              </div>
              <ul className="space-y-1.5">
                {issues.map((issue) => (
                  <li key={`${issue.productId}-${issue.kind}`} className="text-sm text-ink-600">
                    • {issue.message}
                    {issue.availableQty !== undefined && (
                      <span className="text-ink-400"> (only {issue.availableQty} left)</span>
                    )}
                  </li>
                ))}
              </ul>
              <Link href="/cart" className="mt-3 block">
                <Button variant="secondary" className="w-full">
                  Edit cart
                </Button>
              </Link>
            </Card>
          )}

          {/* -------------------------------------------------- address */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-900">Delivery address</h2>
              <button
                onClick={() => setShowAddrForm(true)}
                className="text-sm font-medium text-primary-700"
              >
                + Add new
              </button>
            </div>

            {addressesQuery.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner className="h-5 w-5 text-primary-600" />
              </div>
            ) : addresses.length === 0 ? (
              <Card className="p-4">
                <p className="text-sm text-ink-600">
                  No saved addresses yet. Add one to continue.
                </p>
                <Button className="mt-3 w-full" onClick={() => setShowAddrForm(true)}>
                  Add address
                </Button>
              </Card>
            ) : (
              <div className="space-y-2">
                {addresses.map((addr) => {
                  const active = addr.id === selectedAddressId;
                  return (
                    <label
                      key={addr.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-card border bg-surface p-3",
                        active ? "border-primary-600 ring-1 ring-primary-600" : "border-line",
                      )}
                    >
                      <input
                        type="radio"
                        name="address"
                        className="mt-1 h-4 w-4 accent-primary-600"
                        checked={active}
                        onChange={() => setSelectedAddressId(addr.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink-900">
                          {addr.label}
                          {addr.isDefault && (
                            <span className="ml-2 text-xs font-normal text-ink-400">Default</span>
                          )}
                        </p>
                        <p className="text-sm text-ink-600">
                          {addr.line1}
                          {addr.line2 ? `, ${addr.line2}` : ""}
                        </p>
                        {addr.landmark && (
                          <p className="text-xs text-ink-400">Near {addr.landmark}</p>
                        )}
                        <p className="text-xs text-ink-400">PIN {addr.pincode}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {/* serviceability for the selected address */}
            {selectedAddress && (
              <div className="mt-2 text-sm">
                {svcQuery.isLoading ? (
                  <p className="text-ink-400">Checking serviceability…</p>
                ) : svcQuery.isError ? (
                  <p className="text-danger">Could not check the delivery area.</p>
                ) : serviceability && !serviceability.serviceable ? (
                  <p className="font-medium text-danger">
                    Outside our delivery area
                    {serviceability.distanceM
                      ? ` (${(serviceability.distanceM / 1000).toFixed(1)} km away)`
                      : ""}
                    .
                  </p>
                ) : serviceability ? (
                  <p className="font-medium text-success">
                    Deliverable
                    {serviceability.deliveryPaise !== null
                      ? ` · fee ${formatPaise(serviceability.deliveryPaise)}`
                      : ""}
                    {serviceability.distanceM
                      ? ` · ${(serviceability.distanceM / 1000).toFixed(1)} km`
                      : ""}
                  </p>
                ) : null}
              </div>
            )}
          </section>

          {/* -------------------------------------------------- coupon */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-ink-900">Coupon</h2>
            <TextInput
              placeholder="Coupon code (optional)"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value.toUpperCase())}
              autoCapitalize="characters"
            />
            <p className="mt-1 text-xs text-ink-400">Discount is applied when the order is placed.</p>
          </section>

          {/* -------------------------------------------------- payment */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-ink-900">Payment method</h2>
            <div className="space-y-2">
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-card border bg-surface p-3",
                  paymentMethod === "PREPAID"
                    ? "border-primary-600 ring-1 ring-primary-600"
                    : "border-line",
                )}
              >
                <input
                  type="radio"
                  name="pay"
                  className="h-4 w-4 accent-primary-600"
                  checked={paymentMethod === "PREPAID"}
                  onChange={() => setPaymentMethod("PREPAID")}
                />
                <div>
                  <p className="text-sm font-medium text-ink-900">Pay online</p>
                  <p className="text-xs text-ink-400">UPI, cards & netbanking via Razorpay</p>
                </div>
              </label>

              <label
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-card border bg-surface p-3",
                  !codAllowed && "opacity-60",
                  paymentMethod === "COD"
                    ? "border-primary-600 ring-1 ring-primary-600"
                    : "border-line",
                )}
              >
                <input
                  type="radio"
                  name="pay"
                  className="h-4 w-4 accent-primary-600"
                  checked={paymentMethod === "COD"}
                  disabled={!codAllowed}
                  onChange={() => setPaymentMethod("COD")}
                />
                <div>
                  <p className="text-sm font-medium text-ink-900">Cash on delivery</p>
                  <p className="text-xs text-ink-400">
                    {!store?.featureFlags.codEnabled
                      ? "Currently unavailable"
                      : totals && store && totals.totalPaise > store.codLimitPaise
                        ? `Not available above ${formatPaise(store.codLimitPaise)}`
                        : "Pay the driver on delivery"}
                  </p>
                </div>
              </label>
            </div>
          </section>

          {/* Rx note */}
          {requiresRx && (
            <Card className="border-rx/30 bg-rx/5 p-3">
              <p className="text-sm text-rx">
                This order contains prescription items. You’ll be asked to upload a valid
                prescription on the next screen — it goes for pharmacist review before dispatch.
              </p>
            </Card>
          )}

          {/* -------------------------------------------------- bill */}
          {totals && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-900">Bill details</h2>
              <Card className="p-4">
                <BillRow label={`Items (${itemCount})`} value={formatPaise(totals.itemsPaise)} />
                <BillRow
                  label="Delivery fee"
                  value={
                    totals.deliveryPaise === 0 ? "FREE" : formatPaise(totals.deliveryPaise)
                  }
                />
                <div className="my-2 border-t border-line" />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink-900">To pay</span>
                  <span className="text-base font-semibold tabular-nums text-ink-900">
                    {formatPaise(totals.totalPaise)}
                  </span>
                </div>
                {coupon.trim() !== "" && (
                  <p className="mt-1 text-xs text-ink-400">
                    Any coupon discount is applied when the order is placed — the final total may be
                    lower.
                  </p>
                )}
                {!totals.minOrderMet && (
                  <p className="mt-2 text-xs font-medium text-warning">
                    Add {formatPaise(Math.max(0, totals.minOrderPaise - totals.itemsPaise))} more to
                    reach the {formatPaise(totals.minOrderPaise)} minimum.
                  </p>
                )}
              </Card>
            </section>
          )}
        </div>
      )}

      {/* --------------------------------------------------- sticky CTA */}
      {validate && validate.cart.items.length > 0 && (
        <div className="fixed bottom-16 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-line bg-surface px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
          {blockReason && blockReason !== "Loading…" && (
            <p className="mb-2 text-center text-xs font-medium text-warning">{blockReason}</p>
          )}
          <Button
            className="w-full"
            loading={placeOrder.isPending}
            disabled={!canPlace}
            onClick={() => placeOrder.mutate()}
          >
            {payLabel} · {formatPaise(totals?.totalPaise ?? 0)}
          </Button>
        </div>
      )}

      {/* --------------------------------------------------- add address */}
      <Modal
        open={showAddrForm}
        onClose={() => setShowAddrForm(false)}
        title="Add address"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowAddrForm(false)}>
              Cancel
            </Button>
            <Button loading={createAddress.isPending} onClick={submitAddress}>
              Save address
            </Button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={submitAddress}>
          <Field label="Label" hint="e.g. Home, Work (optional)">
            <TextInput
              placeholder="Home"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </Field>
          <Field label="Address line 1">
            <TextInput
              placeholder="House / flat, street"
              value={form.line1}
              onChange={(e) => setForm((f) => ({ ...f, line1: e.target.value }))}
            />
          </Field>
          <Field label="Address line 2" hint="Optional">
            <TextInput
              placeholder="Area, locality"
              value={form.line2}
              onChange={(e) => setForm((f) => ({ ...f, line2: e.target.value }))}
            />
          </Field>
          <Field label="Landmark" hint="Optional">
            <TextInput
              placeholder="Near…"
              value={form.landmark}
              onChange={(e) => setForm((f) => ({ ...f, landmark: e.target.value }))}
            />
          </Field>
          <Field label="Pincode">
            <TextInput
              inputMode="numeric"
              maxLength={6}
              placeholder="560001"
              value={form.pincode}
              onChange={(e) =>
                setForm((f) => ({ ...f, pincode: e.target.value.replace(/\D/g, "").slice(0, 6) }))
              }
            />
          </Field>

          <div>
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              loading={locating}
              onClick={captureLocation}
            >
              Use my location
            </Button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="Latitude">
                <TextInput
                  inputMode="decimal"
                  placeholder="12.971600"
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                />
              </Field>
              <Field label="Longitude">
                <TextInput
                  inputMode="decimal"
                  placeholder="77.594600"
                  value={form.lng}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                />
              </Field>
            </div>
          </div>
          {/* native submit so Enter works; footer button also submits */}
          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Modal>
    </div>
  );
}

function BillRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-sm">
      <span className="text-ink-600">{label}</span>
      <span className="tabular-nums text-ink-900">{value}</span>
    </div>
  );
}
