"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Address,
  AttachRxBody,
  CouponQuote,
  CreateAddressBody,
  CreateOrderBody,
  CreateOrderResult,
  CreatePatientBody,
  ErrorCode,
  LockerPrescription,
  Patient,
  PatientGender,
  PatientRelation,
  PaymentMethod,
  ServiceabilityResult,
  ValidateCartResult,
} from "@medrush/contracts";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";
import { api, ApiError, apiErrorMessage, qs, type Envelope } from "@/lib/api";
import { API_BASE_URL } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { useStore } from "@/lib/store";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { collectPayment, pollUntilPaid } from "@/lib/payment";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui";
import { Field, Select, TextInput } from "@/components/kit";
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
      undefined,
      res.headers.get("x-request-id") ?? undefined,
    );
  }
  return json.data;
}

/* Razorpay sheet / dev-stub collection + paid-polling live in lib/payment.ts —
 * shared with the order-detail "Complete payment" retry flow. */

/* ================================================================ page */

const EMPTY_FORM = { label: "", line1: "", line2: "", landmark: "", pincode: "", lat: "", lng: "" };
const EMPTY_PATIENT: { name: string; relation: PatientRelation; dob: string; gender: string } = {
  name: "",
  relation: "CHILD",
  dob: "",
  gender: "",
};

const RELATION_LABEL: Record<PatientRelation, string> = {
  SELF: "Self",
  SPOUSE: "Spouse",
  CHILD: "Child",
  PARENT: "Parent",
  OTHER: "Other",
};

/** Teal-gradient CTA. `disabled:bg-none` lets the Button's disabled colour win. */
const CTA =
  "press bg-gradient-to-r from-primary-600 to-primary-500 shadow-glow hover:from-primary-700 hover:to-primary-600 disabled:bg-none disabled:shadow-none";

export default function CheckoutPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, token, loading: authLoading } = useAuth();
  const { store } = useStore();
  const { itemCount } = useCart();

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [coupon, setCoupon] = useState("");
  /** Server-priced quote for the applied coupon; null = none applied. */
  const [quote, setQuote] = useState<CouponQuote | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [deliveryNote, setDeliveryNote] = useState("");
  const [contactless, setContactless] = useState(false);
  // One idempotency key per checkout session — a manual retry replays (never
  // double-creates); a fresh checkout (new mount after navigation) gets a new key.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("PREPAID");
  const [showAddrForm, setShowAddrForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [locating, setLocating] = useState(false);
  /** Dependent this order is for; null = the account holder ("Myself"). */
  const [patientId, setPatientId] = useState<string | null>(null);
  const [showPatientForm, setShowPatientForm] = useState(false);
  const [patientForm, setPatientForm] = useState(EMPTY_PATIENT);
  /** Locker prescription to attach right after the order is created. */
  const [rxId, setRxId] = useState<string | null>(null);
  // The order-create call is idempotent; the attach call is not, so a manual
  // retry after a payment failure must not re-attach.
  const rxAttached = useRef(false);

  // Auth guard — browsing is public, checkout is not.
  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  // One-shot coupon hand-off from /offers ("Use code"). Key literal mirrors
  // offers/page.tsx.
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("medrush.web.pendingCoupon");
      if (pending) {
        setCoupon(pending);
        sessionStorage.removeItem("medrush.web.pendingCoupon");
      }
    } catch {
      // Storage blocked — nothing to prefill.
    }
  }, []);

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

  // Dependent profiles ("who is this order for"). Optional by design — the
  // default sends no patientId, so an unavailable endpoint never blocks checkout.
  const patientsQuery = useQuery({
    queryKey: ["patients"],
    queryFn: () => api.get<Patient[]>("/v1/patients"),
    enabled: Boolean(user),
  });
  const patients = patientsQuery.data?.data ?? [];
  const selectedPatient = patients.find((p) => p.id === patientId) ?? null;

  // A profile deleted in another tab must not be sent with the order.
  useEffect(() => {
    if (patientId && patientsQuery.isSuccess && !patients.some((p) => p.id === patientId)) {
      setPatientId(null);
    }
  }, [patientId, patients, patientsQuery.isSuccess]);

  // Re-usable locker prescriptions, only when this cart actually needs one.
  const rxQuery = useQuery({
    queryKey: ["prescriptions", "unattached"],
    queryFn: () => api.get<LockerPrescription[]>(`/v1/prescriptions${qs({ unattached: true })}`),
    enabled: Boolean(user) && requiresRx,
  });
  // A rejected prescription can't be re-used — ops has already refused it.
  const lockerRx = (rxQuery.data?.data ?? []).filter((rx) => rx.status !== "REJECTED");

  // A prescription that got attached/deleted elsewhere must not be carried over.
  useEffect(() => {
    const list = rxQuery.data?.data;
    if (rxId && list && !list.some((rx) => rx.id === rxId)) setRxId(null);
  }, [rxId, rxQuery.data]);

  // Endpoints that this deployment simply doesn't serve yet return 404 — those
  // optional shelves stay quiet instead of crying error at the customer.
  const patientsFailed =
    patientsQuery.isError &&
    !(patientsQuery.error instanceof ApiError && patientsQuery.error.status === 404);
  const rxFailed =
    rxQuery.isError && !(rxQuery.error instanceof ApiError && rxQuery.error.status === 404);

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

  // Contactless needs no handover — impossible with cash collection.
  useEffect(() => {
    if (paymentMethod === "COD" && contactless) setContactless(false);
  }, [paymentMethod, contactless]);

  /* ------------------------------------------------------- mutations */

  // Coupon preview — POST /v1/coupons/validate prices the code against the
  // CURRENT server cart with the same rules order-create runs, so the customer
  // sees the discount before paying instead of applying a code blind.
  const applyCoupon = useMutation({
    mutationFn: (code: string) => api.post<CouponQuote>("/v1/coupons/validate", { code }),
    onSuccess: (res) => {
      setQuote(res.data);
      setCouponError(null);
    },
    onError: (err) => {
      setQuote(null);
      setCouponError(err instanceof ApiError ? err.message : "Could not check that code");
    },
  });

  // The quote was priced against a specific cart subtotal — if the cart has
  // changed since (edited in another tab), drop it so the bill never lies.
  useEffect(() => {
    if (quote && totals && quote.itemsPaise !== totals.itemsPaise) {
      setQuote(null);
      setCouponError("Cart changed — re-apply your coupon");
    }
  }, [quote, totals]);

  function clearCoupon() {
    setCoupon("");
    setQuote(null);
    setCouponError(null);
  }

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
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not save address") }),
  });

  const createPatient = useMutation({
    mutationFn: (body: CreatePatientBody) => api.post<Patient>("/v1/patients", body),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["patients"] });
      setPatientId(res.data.id);
      setShowPatientForm(false);
      setPatientForm(EMPTY_PATIENT);
      toast.push({ type: "success", message: `Profile added — ordering for ${res.data.name}` });
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not save that profile") }),
  });

  const placeOrder = useMutation({
    mutationFn: async (): Promise<{ orderId: string; confirming: boolean }> => {
      if (!token) throw new ApiError("INTERNAL", "You are not signed in", 401);
      if (!selectedAddressId) throw new ApiError("INTERNAL", "Select a delivery address", 400);
      const body: CreateOrderBody = {
        addressId: selectedAddressId,
        paymentMethod,
        ...(coupon.trim() ? { couponCode: coupon.trim().toUpperCase() } : {}),
        ...(deliveryNote.trim() ? { deliveryNote: deliveryNote.trim() } : {}),
        ...(contactless ? { contactless: true } : {}),
        ...(patientId ? { patientId } : {}),
      };
      const result = await createOrder(body, token, idempotencyKey);
      const orderId = result.order.id;

      // Locker re-use is a post-create step by contract. The order already
      // exists at this point, so a failed attach is reported and nothing else —
      // it must never surface as "the order failed".
      if (rxId && !rxAttached.current) {
        try {
          await api.post<LockerPrescription>(`/v1/orders/${orderId}/prescriptions/attach`, {
            prescriptionId: rxId,
          } satisfies AttachRxBody);
          rxAttached.current = true;
        } catch (err) {
          toast.push({
            type: "error",
            message: apiErrorMessage(
              err,
              "Order placed, but that prescription couldn’t be attached — add it from the order screen",
            ),
          });
        }
      }

      // Rx orders need pharmacist review before payment — the detail screen owns
      // the Rx upload (and any later payment), so route there straight away.
      if (result.order.requiresRx) return { orderId, confirming: false };
      if (paymentMethod === "COD") return { orderId, confirming: false };

      // PREPAID, non-Rx → collect payment now (shared with the retry flow).
      const rzp = result.razorpay;
      if (!rzp) return { orderId, confirming: false }; // defensive: server should always attach it
      await collectPayment(rzp, { name: store?.name ?? "MedRush", contact: user?.phone });
      // False when the ~10s poll never saw the webhook land — captured, but not
      // yet confirmed; the order page must not present it as pending.
      const paid = await pollUntilPaid(orderId, token);
      return { orderId, confirming: !paid };
    },
    onSuccess: ({ orderId, confirming }) => {
      void qc.invalidateQueries({ queryKey: ["cart"] });
      void qc.invalidateQueries({ queryKey: ["cart-validate"] });
      void qc.invalidateQueries({ queryKey: ["prescriptions"] });
      // `?confirming=1` → the order page shows its "Payment received —
      // confirming…" state instead of the retry card until the status flips.
      router.push(confirming ? `/orders/${orderId}?confirming=1` : `/orders/${orderId}`);
    },
    // PAYMENT_UNAVAILABLE (Razorpay outage, 503) gets a friendly retry message
    // and server-received failures carry a "Support code" (x-request-id).
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not place the order") }),
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

  /* --------------------------------------------------- patient form */

  function submitPatient(e: React.FormEvent) {
    e.preventDefault();
    const name = patientForm.name.trim();
    if (!name) {
      toast.push({ type: "error", message: "Enter the patient’s name" });
      return;
    }
    const body: CreatePatientBody = {
      name,
      relation: patientForm.relation,
      ...(patientForm.dob ? { dob: patientForm.dob } : {}),
      ...(patientForm.gender ? { gender: patientForm.gender as PatientGender } : {}),
    };
    createPatient.mutate(body);
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
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar title="Checkout" back />

      {validateQuery.isLoading ? (
        <div className="space-y-3 p-4" aria-hidden>
          <Skeleton className="h-24 rounded-xl2" />
          <Skeleton className="h-40 rounded-xl2" />
          <Skeleton className="h-28 rounded-xl2" />
          <Skeleton className="h-36 rounded-xl2" />
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
          <EmptyState
            title="Your cart is empty"
            hint="Add items before checking out."
            action={
              <Link href="/shop" className="block">
                <Button className={cn("w-full", CTA)}>Browse products</Button>
              </Link>
            }
          />
        </div>
      ) : (
        <div className="space-y-5 px-4 py-4 pb-44">
          {/* store closed banner */}
          {store && !store.isOpen && (
            <div className="rounded-xl2 border border-warning/30 bg-warning/10 p-3.5">
              <p className="text-sm font-semibold text-warning">
                The store is currently closed — orders can’t be placed right now.
              </p>
            </div>
          )}

          {/* cart issues */}
          {issues.length > 0 && (
            <div className="rounded-xl2 border border-warning/30 bg-warning/5 p-4 shadow-card2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-warning">Please review your cart</p>
                <button
                  onClick={() => validateQuery.refetch()}
                  className="press min-h-[44px] px-2 text-xs font-semibold text-primary-700"
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
                <Button variant="secondary" className="press w-full">
                  Edit cart
                </Button>
              </Link>
            </div>
          )}

          {/* -------------------------------------------------- address */}
          <Section
            title="Delivery address"
            action={
              <button
                onClick={() => setShowAddrForm(true)}
                className="press min-h-[44px] px-2 text-sm font-semibold text-primary-700"
              >
                + Add new
              </button>
            }
          >
            {addressesQuery.isLoading ? (
              <div className="space-y-2" aria-hidden>
                <Skeleton className="h-20 rounded-xl2" />
                <Skeleton className="h-20 rounded-xl2" />
              </div>
            ) : addressesQuery.isError ? (
              <ErrorState
                message="Couldn’t load your addresses."
                onRetry={() => addressesQuery.refetch()}
              />
            ) : addresses.length === 0 ? (
              <div className="glass rounded-xl2 p-4 shadow-card2">
                <p className="text-sm text-ink-600">No saved addresses yet. Add one to continue.</p>
                <Button className={cn("mt-3 w-full", CTA)} onClick={() => setShowAddrForm(true)}>
                  Add address
                </Button>
              </div>
            ) : (
              <div className="space-y-2" role="radiogroup" aria-label="Delivery address">
                {addresses.map((addr) => {
                  const active = addr.id === selectedAddressId;
                  return (
                    <label key={addr.id} className={optionCls(active)}>
                      <input
                        type="radio"
                        name="address"
                        className="mt-1 h-4 w-4 shrink-0 accent-primary-600"
                        checked={active}
                        onChange={() => setSelectedAddressId(addr.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink-900">
                          {addr.label}
                          {addr.isDefault && (
                            <span className="ml-2 text-xs font-normal text-ink-600">Default</span>
                          )}
                        </p>
                        <p className="text-sm text-ink-600">
                          {addr.line1}
                          {addr.line2 ? `, ${addr.line2}` : ""}
                        </p>
                        {addr.landmark && <p className="text-xs text-ink-600">Near {addr.landmark}</p>}
                        <p className="text-xs text-ink-600">PIN {addr.pincode}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {/* serviceability for the selected address */}
            {selectedAddress && (
              <div className="mt-2 text-sm" aria-live="polite">
                {svcQuery.isLoading ? (
                  <p className="text-ink-600">Checking serviceability…</p>
                ) : svcQuery.isError ? (
                  <p className="font-medium text-danger">Could not check the delivery area.</p>
                ) : serviceability && !serviceability.serviceable ? (
                  <p className="font-semibold text-danger">
                    Outside our delivery area
                    {serviceability.distanceM
                      ? ` (${(serviceability.distanceM / 1000).toFixed(1)} km away)`
                      : ""}
                    .
                  </p>
                ) : serviceability ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl2 border border-success/20 bg-success/5 px-3 py-2">
                    <span className="text-sm font-semibold text-success">
                      Deliverable
                      {serviceability.deliveryPaise !== null
                        ? ` · fee ${formatPaise(serviceability.deliveryPaise)}`
                        : ""}
                      {serviceability.distanceM
                        ? ` · ${(serviceability.distanceM / 1000).toFixed(1)} km`
                        : ""}
                    </span>
                    {/* ETA heuristic mirrors the tracking screen's model: ride
                        time at ~5 m/s (≈18 km/h city riding) + ~15 min for
                        pharmacist check & packing. The 40-min promise is the cap. */}
                    <span className="text-xs text-ink-600">
                      Est. delivery ~
                      {Math.min(40, Math.max(20, Math.round(serviceability.distanceM / 300) + 15))}{" "}
                      min after payment
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </Section>

          {/* ------------------------------------------- who is it for */}
          <Section
            title="Who is this order for?"
            action={
              <button
                onClick={() => setShowPatientForm(true)}
                className="press min-h-[44px] px-2 text-sm font-semibold text-primary-700"
              >
                + Add profile
              </button>
            }
          >
            {patientsQuery.isLoading ? (
              <div className="flex gap-2" aria-hidden>
                <Skeleton className="h-11 w-28 rounded-pill" />
                <Skeleton className="h-11 w-32 rounded-pill" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Patient">
                  <PatientChip
                    label="Myself"
                    sub={user.name ?? undefined}
                    active={patientId === null}
                    onSelect={() => setPatientId(null)}
                  />
                  {patients.map((p) => (
                    <PatientChip
                      key={p.id}
                      label={p.name}
                      sub={RELATION_LABEL[p.relation]}
                      active={patientId === p.id}
                      onSelect={() => setPatientId(p.id)}
                    />
                  ))}
                </div>
                {patientsFailed && (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-xs text-ink-600">Couldn’t load your saved profiles.</p>
                    <button
                      onClick={() => void patientsQuery.refetch()}
                      className="press min-h-[44px] px-2 text-xs font-semibold text-primary-700"
                    >
                      Retry
                    </button>
                  </div>
                )}
                <p className="mt-2 text-xs text-ink-600">
                  {selectedPatient
                    ? `This order will be dispensed for ${selectedPatient.name} (${RELATION_LABEL[selectedPatient.relation].toLowerCase()}).`
                    : "Ordering for yourself. Add a profile to order for a family member — it keeps the pharmacy record accurate."}
                </p>
              </>
            )}
          </Section>

          {/* -------------------------------------------- prescription */}
          {requiresRx && (
            <Section title="Prescription">
              <div className="rounded-xl2 border border-rx/25 bg-rx/5 p-3.5">
                <p className="text-sm text-rx">
                  This order contains prescription items. Attach a prescription from your locker
                  now, or upload one on the order screen — either way a pharmacist reviews it before
                  we dispatch.
                </p>
              </div>

              {rxQuery.isLoading ? (
                <div className="mt-2 space-y-2" aria-hidden>
                  <Skeleton className="h-16 rounded-xl2" />
                  <Skeleton className="h-16 rounded-xl2" />
                </div>
              ) : rxFailed ? (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-xl2 border border-line bg-surface px-3.5 py-3">
                  <p className="text-xs text-ink-600">Couldn’t load your prescription locker.</p>
                  <button
                    onClick={() => void rxQuery.refetch()}
                    className="press min-h-[44px] px-2 text-xs font-semibold text-primary-700"
                  >
                    Retry
                  </button>
                </div>
              ) : lockerRx.length === 0 ? (
                <p className="mt-2 text-xs text-ink-600">
                  No re-usable prescriptions in your locker yet — you can upload one right after
                  placing this order.
                </p>
              ) : (
                <div className="mt-2 space-y-2" role="radiogroup" aria-label="Prescription">
                  {lockerRx.map((rx) => {
                    const active = rx.id === rxId;
                    return (
                      <label key={rx.id} className={optionCls(active)}>
                        <input
                          type="radio"
                          name="rx"
                          className="mt-1 h-4 w-4 shrink-0 accent-primary-600"
                          checked={active}
                          onChange={() => setRxId(rx.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-ink-900">
                            {rx.label ?? "Prescription"}
                          </p>
                          <p className="truncate text-xs text-ink-600">
                            {[rx.doctorName, rx.patientName].filter(Boolean).join(" · ") ||
                              "No doctor recorded"}
                          </p>
                        </div>
                        <span className="shrink-0">
                          <Badge tone={rx.status === "APPROVED" ? "green" : "amber"}>
                            {rx.status === "APPROVED" ? "Approved" : "In review"}
                          </Badge>
                        </span>
                      </label>
                    );
                  })}
                  <label className={optionCls(rxId === null)}>
                    <input
                      type="radio"
                      name="rx"
                      className="mt-1 h-4 w-4 shrink-0 accent-primary-600"
                      checked={rxId === null}
                      onChange={() => setRxId(null)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-900">
                        I’ll upload one after placing the order
                      </p>
                      <p className="text-xs text-ink-600">
                        The order screen takes a photo or PDF of your prescription.
                      </p>
                    </div>
                  </label>
                </div>
              )}
            </Section>
          )}

          {/* -------------------------------------------------- coupon */}
          <Section
            title="Coupon"
            action={
              <Link
                href="/offers"
                className="press min-h-[44px] px-2 text-sm font-semibold text-primary-700"
              >
                View offers
              </Link>
            }
          >
            {quote ? (
              <div className="flex items-center justify-between gap-2 rounded-xl2 border border-success/30 bg-success/5 px-3.5 py-3">
                <p className="text-sm font-semibold text-success">
                  {quote.code} applied — you save {formatPaise(quote.discountPaise)}
                </p>
                <button
                  type="button"
                  className="press min-h-[44px] shrink-0 px-2 text-xs font-semibold text-danger"
                  onClick={clearCoupon}
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <TextInput
                    placeholder="Coupon code (optional)"
                    aria-label="Coupon code"
                    value={coupon}
                    onChange={(e) => {
                      setCoupon(e.target.value.toUpperCase());
                      setCouponError(null);
                    }}
                    autoCapitalize="characters"
                  />
                  <Button
                    variant="secondary"
                    className="press shrink-0"
                    disabled={coupon.trim() === ""}
                    loading={applyCoupon.isPending}
                    onClick={() => applyCoupon.mutate(coupon.trim().toUpperCase())}
                  >
                    Apply
                  </Button>
                </div>
                {couponError && (
                  <p className="mt-1 text-xs font-semibold text-danger" aria-live="polite">
                    {couponError}
                  </p>
                )}
              </>
            )}
          </Section>

          {/* ------------------------------------- delivery preferences */}
          <Section title="Delivery preferences">
            <div className="glass space-y-3 rounded-xl2 p-3.5 shadow-card2">
              <Field label="Note for the rider" hint="Optional · e.g. “Blue gate, call on arrival”">
                <TextInput
                  placeholder="Any directions for the delivery partner?"
                  maxLength={200}
                  value={deliveryNote}
                  onChange={(e) => setDeliveryNote(e.target.value)}
                />
              </Field>
              <label
                className={cn(
                  "flex min-h-[44px] items-center gap-3",
                  paymentMethod === "COD" ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                )}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary-600"
                  checked={contactless}
                  disabled={paymentMethod === "COD"}
                  onChange={(e) => setContactless(e.target.checked)}
                />
                <span className="text-sm text-ink-900">
                  Contactless delivery
                  <span className="block text-xs text-ink-600">
                    {paymentMethod === "COD"
                      ? "Not available with cash on delivery"
                      : "We’ll leave the package at your door"}
                  </span>
                </span>
              </label>
            </div>
          </Section>

          {/* -------------------------------------------------- payment */}
          <Section title="Payment method">
            <div className="space-y-2" role="radiogroup" aria-label="Payment method">
              <label className={optionCls(paymentMethod === "PREPAID")}>
                <input
                  type="radio"
                  name="pay"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary-600"
                  checked={paymentMethod === "PREPAID"}
                  onChange={() => setPaymentMethod("PREPAID")}
                />
                <div>
                  <p className="text-sm font-semibold text-ink-900">Pay online</p>
                  <p className="text-xs text-ink-600">UPI, cards &amp; netbanking via Razorpay</p>
                </div>
              </label>

              <label className={cn(optionCls(paymentMethod === "COD"), !codAllowed && "opacity-60")}>
                <input
                  type="radio"
                  name="pay"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary-600"
                  checked={paymentMethod === "COD"}
                  disabled={!codAllowed}
                  onChange={() => setPaymentMethod("COD")}
                />
                <div>
                  <p className="text-sm font-semibold text-ink-900">Cash on delivery</p>
                  <p className="text-xs text-ink-600">
                    {!store?.featureFlags.codEnabled
                      ? "Currently unavailable"
                      : totals && store && totals.totalPaise > store.codLimitPaise
                        ? `Not available above ${formatPaise(store.codLimitPaise)}`
                        : "Pay the driver on delivery"}
                  </p>
                </div>
              </label>
            </div>
          </Section>

          {/* -------------------------------------------------- bill */}
          {totals && (
            <Section title="Bill details">
              <div className="glass rounded-xl2 p-4 shadow-card2">
                <BillRow label={`Items (${itemCount})`} value={formatPaise(totals.itemsPaise)} />
                <BillRow
                  label="Delivery fee"
                  value={totals.deliveryPaise === 0 ? "FREE" : formatPaise(totals.deliveryPaise)}
                  accent={totals.deliveryPaise === 0}
                />
                {quote && (
                  <div className="flex items-center justify-between py-1 text-sm">
                    <span className="text-success">Discount ({quote.code})</span>
                    <span className="tabular-nums text-success">
                      − {formatPaise(quote.discountPaise)}
                    </span>
                  </div>
                )}
                <div className="my-2 border-t border-line" />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink-900">To pay</span>
                  <span className="text-lg font-semibold tabular-nums text-ink-900">
                    {formatPaise(quote ? quote.totalPaise : totals.totalPaise)}
                  </span>
                </div>
                {!quote && coupon.trim() !== "" && (
                  <p className="mt-1 text-xs text-ink-600">
                    Tap Apply to see the discount before you pay.
                  </p>
                )}
                {!totals.minOrderMet && (
                  <p className="mt-2 text-xs font-semibold text-warning">
                    Add {formatPaise(Math.max(0, totals.minOrderPaise - totals.itemsPaise))} more to
                    reach the {formatPaise(totals.minOrderPaise)} minimum.
                  </p>
                )}
              </div>
            </Section>
          )}
        </div>
      )}

      {/* --------------------------------------------------- sticky CTA */}
      {validate && validate.cart.items.length > 0 && (
        <div className="fixed bottom-16 left-1/2 z-30 w-full max-w-md -translate-x-1/2 glass px-4 py-3 shadow-[0_-8px_28px_rgba(15,23,42,0.10)]">
          {blockReason && blockReason !== "Loading…" && (
            <p className="mb-2 text-center text-xs font-semibold text-warning" aria-live="polite">
              {blockReason}
            </p>
          )}
          <Button
            className={cn("w-full", CTA)}
            loading={placeOrder.isPending}
            disabled={!canPlace}
            onClick={() => placeOrder.mutate()}
          >
            {payLabel} · {formatPaise(quote ? quote.totalPaise : (totals?.totalPaise ?? 0))}
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
            <Button className={CTA} loading={createAddress.isPending} onClick={submitAddress}>
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
              className="press w-full"
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

      {/* --------------------------------------------------- add profile */}
      <Modal
        open={showPatientForm}
        onClose={() => setShowPatientForm(false)}
        title="Add a patient profile"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowPatientForm(false)}>
              Cancel
            </Button>
            <Button className={CTA} loading={createPatient.isPending} onClick={submitPatient}>
              Save profile
            </Button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={submitPatient}>
          <p className="text-xs text-ink-600">
            Dispensing records name the patient, not the account holder — so a profile keeps the
            pharmacy register correct for Schedule H/H1 medicines.
          </p>
          <Field label="Full name">
            <TextInput
              placeholder="e.g. Aarav Sharma"
              maxLength={80}
              value={patientForm.name}
              onChange={(e) => setPatientForm((f) => ({ ...f, name: e.target.value }))}
            />
          </Field>
          <Field label="Relation">
            <Select
              value={patientForm.relation}
              onChange={(e) =>
                setPatientForm((f) => ({ ...f, relation: e.target.value as PatientRelation }))
              }
            >
              {(Object.keys(RELATION_LABEL) as PatientRelation[]).map((r) => (
                <option key={r} value={r}>
                  {RELATION_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date of birth" hint="Optional">
              <TextInput
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={patientForm.dob}
                onChange={(e) => setPatientForm((f) => ({ ...f, dob: e.target.value }))}
              />
            </Field>
            <Field label="Gender" hint="Optional">
              <Select
                value={patientForm.gender}
                onChange={(e) => setPatientForm((f) => ({ ...f, gender: e.target.value }))}
              >
                <option value="">Not specified</option>
                <option value="F">Female</option>
                <option value="M">Male</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
          </div>
          <button type="submit" className="hidden" aria-hidden />
        </form>
      </Modal>
    </div>
  );
}

/* ============================================================== bits */

/** Shared selectable-card styling for the address / payment / Rx radio lists. */
function optionCls(active: boolean): string {
  return cn(
    "press flex cursor-pointer items-start gap-3 rounded-xl2 border p-3.5 transition-shadow",
    active
      ? "border-primary-600 bg-primary-50 shadow-card2 ring-1 ring-primary-600"
      : "border-line bg-surface shadow-sm hover:border-primary-200",
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Radio pill for the patient selector — a real radio, visually a chip. */
function PatientChip({
  label,
  sub,
  active,
  onSelect,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="press cursor-pointer">
      <input
        type="radio"
        name="patient"
        className="peer sr-only"
        checked={active}
        onChange={onSelect}
      />
      <span
        className={cn(
          "flex min-h-[44px] items-center gap-1.5 rounded-pill border px-4 text-sm font-medium",
          "border-line bg-surface text-ink-600 shadow-sm",
          "peer-checked:border-primary-600 peer-checked:bg-primary-50 peer-checked:text-primary-800 peer-checked:shadow-glow",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-primary-600 peer-focus-visible:ring-offset-2",
        )}
      >
        {label}
        {sub && <span className="text-xs font-normal text-ink-600">· {sub}</span>}
      </span>
    </label>
  );
}

function BillRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-ink-600">{label}</span>
      <span className={cn("tabular-nums", accent ? "font-semibold text-success" : "text-ink-900")}>
        {value}
      </span>
    </div>
  );
}
