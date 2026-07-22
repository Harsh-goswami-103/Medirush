"use client";

import { use, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  CancelOrderResult,
  CreateRatingBody,
  OrderDetail,
  OrderEvent,
  OrderInvoice,
  OrderStatus,
  PaymentStatus,
  Prescription,
  Rating,
  ReturnReason,
  ReturnRequest,
  ReturnStatus,
  RetryPaymentResult,
} from "@medrush/contracts";
import { api, ApiError, apiErrorMessage, qs, type Envelope } from "@/lib/api";
import { API_BASE_URL, whatsappUrl } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useStore } from "@/lib/store";
import { useReorder } from "@/lib/reorder";
import { useOrderLive } from "@/lib/socket";
import { collectPayment, pollUntilPaid } from "@/lib/payment";
import { formatDateTime, formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { Reveal } from "@/components/motion";
import {
  Badge,
  Button,
  ErrorState,
  OrderStatusBadge,
  RxBadge,
  Skeleton,
  Spinner,
  WhatsAppIcon,
} from "@/components/ui";
import { Field, Textarea } from "@/components/kit";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

const CANCELLABLE: OrderStatus[] = ["PENDING_PAYMENT", "PLACED", "RX_REVIEW", "PACKING", "READY"];
const TRACKABLE: OrderStatus[] = ["PACKING", "READY", "ASSIGNED", "PICKED_UP"];

const PAYMENT_TONE = {
  PENDING: "amber",
  PAID: "green",
  FAILED: "red",
  REFUND_INITIATED: "blue",
  REFUNDED: "neutral",
  COD_DUE: "amber",
  COD_COLLECTED: "green",
} as const satisfies Record<PaymentStatus, string>;

/** Human headline for the hero card — the status badge alone reads like a DB enum. */
const STATUS_HEADLINE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Payment pending",
  PLACED: "Order placed",
  RX_REVIEW: "Prescription in review",
  PACKING: "Packing your order",
  READY: "Ready for pickup",
  ASSIGNED: "Rider assigned",
  PICKED_UP: "On the way to you",
  DELIVERED: "Delivered",
  CANCELLED: "Order cancelled",
};

const STATUS_SUB: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Complete the payment to get this order moving.",
  PLACED: "Our pharmacy team has your order and will start packing shortly.",
  RX_REVIEW: "A pharmacist is verifying your prescription.",
  PACKING: "Your medicines are being picked and packed.",
  READY: "Packed and waiting for a delivery partner.",
  ASSIGNED: "A delivery partner is heading to the store.",
  PICKED_UP: "Your order is out for delivery.",
  DELIVERED: "Hope you're feeling better soon.",
  CANCELLED: "This order was cancelled.",
};

/** Canonical happy path for the stepper; optional nodes are filtered per order. */
const FULL_FLOW: OrderStatus[] = [
  "PENDING_PAYMENT",
  "PLACED",
  "RX_REVIEW",
  "PACKING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "DELIVERED",
];

const STEP_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Payment",
  PLACED: "Order placed",
  RX_REVIEW: "Prescription review",
  PACKING: "Packing",
  READY: "Ready for pickup",
  ASSIGNED: "Rider assigned",
  PICKED_UP: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  DAMAGED: "Item arrived damaged",
  WRONG_ITEM: "Wrong item delivered",
  MISSING: "Something is missing",
  EXPIRED: "Item is expired or too close to expiry",
  OTHER: "Something else",
};

const RETURN_STATUS_COPY: Record<ReturnStatus, { label: string; tone: "amber" | "green" | "red" }> =
  {
    REQUESTED: { label: "Under review", tone: "amber" },
    APPROVED: { label: "Approved", tone: "green" },
    REJECTED: { label: "Closed", tone: "red" },
  };

const STAR_WORD = ["", "Poor", "Fair", "Good", "Great", "Excellent"];

const humanize = (s: string) => s.replace(/_/g, " ").toLowerCase();

/** Order detail — GET /v1/orders/:id, with cancel / track / Rx-upload / invoice actions. */
export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, token, loading: authLoading } = useAuth();
  const { store } = useStore();
  const reorder = useReorder();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  // True while a Razorpay capture was reported but the webhook-driven flip out
  // of PENDING_PAYMENT hasn't been observed yet — entered by the retry flow
  // below (poll timeout) or via the one-shot `?confirming=1` marker checkout
  // sets. Replaces the "Complete payment" card with a confirming state.
  const [confirmingPayment, setConfirmingPayment] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("confirming") === "1",
  );
  const fileRef = useRef<HTMLInputElement>(null);

  // Consume the one-shot marker so a refresh (or share) doesn't replay it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("confirming")) {
      url.searchParams.delete("confirming");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, []);

  // Keep the detail fresh over the socket (status→READY reveals the OTP live).
  const { connected } = useOrderLive(id);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  const orderQuery = useQuery({
    queryKey: ["order", id],
    queryFn: () => api.get<OrderDetail>(`/v1/orders/${id}`),
    enabled: Boolean(user),
    // Polling fallback (§7.3): if the socket is down the OTP/status still refresh
    // (READY reveals the OTP). Poll fast while disconnected or while a payment
    // is awaiting webhook confirmation, back off when live.
    refetchInterval: confirmingPayment ? 2000 : connected ? 20000 : 4000,
  });

  const order = orderQuery.data?.data;
  const delivered = order?.status === "DELIVERED";
  // A PREPAID order stuck at PENDING_PAYMENT (customer dismissed the Razorpay
  // sheet) — offer "Complete payment" instead of stranding them with Cancel only.
  const awaitingPayment = order?.status === "PENDING_PAYMENT" && order.paymentMethod === "PREPAID";

  // Razorpay handoff re-served by GET /v1/orders/:id/payment (owner-scoped;
  // PREPAID + PENDING_PAYMENT only). Fetched eagerly for the auto-cancel
  // countdown (`expiresAt`); 409 = already paid / expired — never retried.
  const paymentQuery = useQuery({
    queryKey: ["order-payment", id],
    queryFn: () => api.get<RetryPaymentResult>(`/v1/orders/${id}/payment`),
    enabled: Boolean(user) && awaitingPayment && !confirmingPayment,
    retry: false,
  });

  // Post-delivery feedback. Both endpoints are DELIVERED-only, so they are not
  // fetched at all before that; `null` data means "not rated yet".
  const ratingQuery = useQuery({
    queryKey: ["order-rating", id],
    queryFn: () => api.get<Rating | null>(`/v1/orders/${id}/rating`),
    enabled: Boolean(user) && delivered,
    retry: false,
  });

  // There is no per-order returns endpoint — the customer's list is filtered
  // client-side (a customer realistically has a handful of open requests).
  const returnsQuery = useQuery({
    queryKey: ["returns"],
    queryFn: () => api.get<ReturnRequest[]>(`/v1/returns${qs({ limit: 50 })}`),
    enabled: Boolean(user) && delivered,
    retry: false,
  });

  const retryPayMut = useMutation({
    mutationFn: async (): Promise<boolean> => {
      // Re-fetch the handoff at click time so a stale card (already paid or
      // auto-cancelled elsewhere) surfaces as a 409 before the sheet opens.
      const { data } = await api.get<RetryPaymentResult>(`/v1/orders/${id}/payment`);
      await collectPayment(data.razorpay, {
        name: store?.name ?? "MedRush",
        contact: user?.phone,
      });
      // True only when the flip out of PENDING_PAYMENT was actually observed.
      return pollUntilPaid(id);
    },
    onSuccess: (paid) => {
      if (paid) {
        toast.push({ type: "success", message: "Payment successful" });
      } else {
        // Captured but the webhook hasn't landed yet — swap the retry card for
        // the confirming state (fast order polling above) instead of claiming
        // success next to a still-pending card.
        setConfirmingPayment(true);
      }
      void qc.invalidateQueries({ queryKey: ["order", id] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e) => {
      // 409 → the order moved on (paid in another tab / auto-cancelled):
      // refetch so the page shows the real state instead of a stale retry card.
      if (e instanceof ApiError && e.status === 409) {
        void qc.invalidateQueries({ queryKey: ["order", id] });
        void qc.invalidateQueries({ queryKey: ["order-payment", id] });
        toast.push({ type: "info", message: e.message });
        return;
      }
      // PAYMENT_UNAVAILABLE (503) → friendly retry copy; server errors carry a
      // "Support code" (x-request-id). A dismissed sheet lands here too.
      toast.push({ type: "error", message: apiErrorMessage(e, "Could not start the payment") });
    },
  });

  // Stand down the confirming state once the order leaves PENDING_PAYMENT.
  // Toast only when the paid transition was actually observed — an auto-cancel
  // that fires while confirming must not read as success.
  useEffect(() => {
    if (!confirmingPayment || !order || order.status === "PENDING_PAYMENT") return;
    setConfirmingPayment(false);
    if (order.paymentStatus === "PAID") {
      toast.push({ type: "success", message: "Payment successful" });
    }
    void qc.invalidateQueries({ queryKey: ["orders"] });
  }, [confirmingPayment, order, toast, qc]);

  const cancelMut = useMutation({
    mutationFn: () =>
      api.post<CancelOrderResult>(`/v1/orders/${id}/cancel`, { reason: reason.trim() }),
    onSuccess: (res) => {
      toast.push({
        type: "success",
        message:
          res.data.outcome === "CANCELLED"
            ? "Order cancelled"
            : "Cancellation requested — our team will review it",
      });
      setCancelOpen(false);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["order", id] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e) =>
      toast.push({ type: "error", message: apiErrorMessage(e, "Could not cancel the order") }),
  });

  const uploadMut = useMutation({
    mutationFn: async (file: File): Promise<Prescription> => {
      // Multipart — the JSON api client can't send FormData, so fetch directly.
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_BASE_URL}/v1/orders/${id}/prescriptions`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as
        | { data: Prescription; error?: { code: string; message: string } }
        | null;
      if (!res.ok || !json) {
        throw new ApiError(
          "INTERNAL",
          json?.error?.message ?? `Upload failed (${res.status})`,
          res.status,
        );
      }
      return json.data;
    },
    onSuccess: () => {
      toast.push({ type: "success", message: "Prescription uploaded" });
      void qc.invalidateQueries({ queryKey: ["order", id] });
    },
    onError: (e) => toast.push({ type: "error", message: apiErrorMessage(e, "Upload failed") }),
  });

  const invoiceMut = useMutation({
    mutationFn: () => api.get<OrderInvoice>(`/v1/orders/${id}/invoice`),
    onSuccess: (res) => {
      // Presigned PDF in prod; a stub URL in local dev (non-dereferenceable — expected).
      window.open(res.data.url, "_blank", "noopener,noreferrer");
    },
    onError: (e) =>
      toast.push({ type: "error", message: apiErrorMessage(e, "Could not fetch the invoice") }),
  });

  // Auth still resolving, or redirecting an anonymous visitor away.
  if (authLoading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const liveBadge = connected ? (
    <span className="flex items-center gap-1 text-xs font-medium text-success">
      <span className="h-2 w-2 rounded-full bg-success" />
      Live
    </span>
  ) : undefined;

  const cancellable = order ? CANCELLABLE.includes(order.status) : false;
  const trackable = order ? TRACKABLE.includes(order.status) : false;
  // The invoice number is null until the async invoice job runs post-delivery.
  const invoiceReady = delivered && order?.invoiceNo != null;
  const showActions = cancellable || trackable || invoiceReady;
  // null when NEXT_PUBLIC_SUPPORT_PHONE is unset — the CTA is hidden then.
  const supportUrl = order ? whatsappUrl(`Hi, I need help with order ${order.orderNo}.`) : null;
  const showRxUpload =
    order != null &&
    order.requiresRx &&
    (order.rxStatus === "PENDING" || order.rxStatus === "REJECTED") &&
    order.status !== "DELIVERED" &&
    order.status !== "CANCELLED";

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (file) uploadMut.mutate(file);
  }

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar back title={order?.orderNo ?? "Order"} right={liveBadge} />

      {orderQuery.isError ? (
        <div className="p-4">
          <ErrorState
            message={(orderQuery.error as Error).message}
            onRetry={() => orderQuery.refetch()}
          />
        </div>
      ) : !order ? (
        <OrderDetailSkeleton />
      ) : (
        <>
          <div className={cn("space-y-5 p-4", showActions ? "pb-36" : "pb-8")}>
            {/* Status hero — aria-live announces live transitions (§20.6). */}
            <Panel className="relative overflow-hidden p-5">
              <span
                className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full bg-primary-100 blur-2xl"
                aria-hidden
              />
              <div className="relative">
                <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                  <OrderStatusBadge status={order.status} />
                  <RxBadge status={order.rxStatus} />
                  {order.patientName && (
                    <span className="inline-flex items-center gap-1 rounded-pill border border-rx/20 bg-rx/10 px-2 py-0.5 text-xs font-medium text-rx">
                      For {order.patientName}
                    </span>
                  )}
                </div>
                <h2 className="mt-3 text-2xl font-bold leading-tight tracking-tight text-ink-900">
                  {STATUS_HEADLINE[order.status]}
                </h2>
                <p className="mt-1 text-sm text-ink-600">{STATUS_SUB[order.status]}</p>
                <p className="mt-3 text-xs text-ink-400">
                  Placed {formatDateTime(order.createdAt)}
                  {order.deliveredAt ? ` · Delivered ${formatDateTime(order.deliveredAt)}` : ""}
                </p>
                {order.status === "CANCELLED" && order.cancelReason && (
                  <p className="mt-2 rounded-input bg-danger/5 px-3 py-2 text-sm text-danger">
                    Reason: {order.cancelReason}
                  </p>
                )}
              </div>
            </Panel>

            {/* Complete payment — PREPAID order stuck at PENDING_PAYMENT (the
                customer dismissed the Razorpay sheet; the cart is already gone).
                Once a capture is reported but the webhook hasn't flipped the
                status yet, a confirming card replaces the retry card so the
                customer can't be told "successful" next to a pending state. */}
            {awaitingPayment &&
              (confirmingPayment ? (
                <Panel className="border-primary-600/30 bg-primary-50 p-5">
                  <p className="flex items-center gap-2 text-sm font-semibold text-primary-800">
                    <Spinner className="h-4 w-4" />
                    Payment received — confirming…
                  </p>
                  <p className="mt-1 text-sm text-ink-600">
                    Your payment is being confirmed — this usually takes a few seconds. This page
                    updates automatically.
                  </p>
                </Panel>
              ) : (
                <Panel className="border-warning/30 bg-warning/5 p-5">
                  <p className="text-sm font-semibold text-warning">Payment pending</p>
                  <p className="mt-1 text-sm text-ink-600">
                    This order is reserved but not paid yet.
                    {paymentQuery.data?.data.expiresAt ? (
                      <>
                        {" "}
                        It will be cancelled automatically in{" "}
                        <Countdown until={paymentQuery.data.data.expiresAt} /> unless the payment is
                        completed.
                      </>
                    ) : (
                      <> Complete the payment to get it moving.</>
                    )}
                  </p>
                  <Button
                    className="press mt-4 w-full rounded-pill bg-gradient-to-r from-primary-700 to-primary-600 py-3 shadow-glow"
                    loading={retryPayMut.isPending}
                    onClick={() => retryPayMut.mutate()}
                  >
                    Complete payment · {formatPaise(order.totalPaise)}
                  </Button>
                </Panel>
              ))}

            {/* Post-delivery feedback: rating prompt + issue reporting. */}
            {delivered && (
              <>
                <RatingCard
                  orderId={id}
                  hasDriver={order.driver != null}
                  query={ratingQuery}
                  qc={qc}
                />
                <ReturnCard orderId={id} query={returnsQuery} qc={qc} />
              </>
            )}

            {/* Refund visibility — full-amount refunds (§18.3) */}
            {order.refund && (
              <Panel className="border-info/30 bg-info/5 p-5">
                <p className="text-sm font-semibold text-info">
                  {order.paymentStatus === "REFUNDED" ? "Refund completed" : "Refund initiated"}
                </p>
                <p className="mt-1 text-sm text-ink-600">
                  {formatPaise(order.refund.amountPaise)} is being returned to your original payment
                  method
                  {order.paymentStatus === "REFUNDED"
                    ? "."
                    : " — banks typically take 5–7 working days."}
                </p>
                <p className="mt-1 text-xs text-ink-400">
                  {order.refund.refundId ? `Ref: ${order.refund.refundId} · ` : ""}
                  Updated {formatDateTime(order.refund.updatedAt)}
                </p>
              </Panel>
            )}

            {/* Delivery OTP — owner-only, READY+ (server returns null otherwise) */}
            {order.deliveryOtp && (
              <Panel className="relative overflow-hidden border-primary-600/30 bg-gradient-to-br from-primary-50 to-mint p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary-800">
                  Delivery OTP
                </p>
                <p className="mt-2 text-4xl font-bold tabular-nums tracking-[0.3em] text-primary-800">
                  {order.deliveryOtp}
                </p>
                <p className="mt-2 text-xs text-ink-600">
                  Share this with your delivery partner to receive the order.
                </p>
              </Panel>
            )}

            {/* Driver card */}
            {order.driver && (
              <Section title="Delivery partner">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-700 to-primary-600 text-base font-bold text-white shadow-glow"
                      aria-hidden
                    >
                      {(order.driver.name ?? "R").charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink-900">
                        {order.driver.name ?? "Assigned"}
                      </p>
                      <p className="truncate text-xs text-ink-600">
                        {order.driver.vehicleType}
                        {order.driver.vehicleNo ? ` · ${order.driver.vehicleNo}` : ""}
                      </p>
                    </div>
                  </div>
                  <a
                    href={`tel:${order.driver.phone}`}
                    aria-label={`Call ${order.driver.name ?? "the delivery partner"}`}
                    className="press inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-pill border border-primary-600/40 bg-primary-50 px-4 text-sm font-semibold text-primary-800"
                  >
                    Call
                  </a>
                </div>
              </Section>
            )}

            {/* Prescription */}
            {(order.requiresRx || order.prescriptions.length > 0) && (
              <Section title="Prescription">
                {showRxUpload && (
                  <>
                    <p className="text-sm text-ink-600">
                      This order needs a valid prescription. Upload a clear photo or PDF.
                    </p>
                    <div className="mt-3">
                      <Button
                        variant="secondary"
                        className="press rounded-pill"
                        loading={uploadMut.isPending}
                        onClick={() => fileRef.current?.click()}
                      >
                        Upload prescription
                      </Button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,application/pdf"
                        className="hidden"
                        onChange={onPickFile}
                      />
                    </div>
                  </>
                )}
                {order.prescriptions.length > 0 && (
                  <ul className={cn("space-y-2", showRxUpload && "mt-3 border-t border-line pt-3")}>
                    {order.prescriptions.map((p) => (
                      <li key={p.id} className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs text-ink-600">{formatDateTime(p.createdAt)}</p>
                          {p.reviewNote && <p className="text-xs text-ink-400">{p.reviewNote}</p>}
                        </div>
                        <RxBadge status={p.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {/* Status stepper — canonical flow with the live node emphasised. */}
            <Reveal as="section">
              <div className="mb-2 flex items-end justify-between gap-2 px-1">
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
                  Progress
                </h2>
              </div>
              <Panel className="p-5">
                <Stepper order={order} />
                {order.events.length > 0 && (
                  <details className="mt-4 border-t border-line pt-3">
                    <summary className="cursor-pointer list-none text-xs font-semibold text-primary-700">
                      Full history ({order.events.length})
                    </summary>
                    <ul className="mt-3 space-y-2.5">
                      {order.events.map((ev: OrderEvent) => (
                        <li key={`${ev.to}-${ev.createdAt}`} className="text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <OrderStatusBadge status={ev.to} />
                            <span className="text-ink-400">{humanize(ev.actorType)}</span>
                          </div>
                          {ev.note && <p className="mt-0.5 text-ink-600">{ev.note}</p>}
                          <p className="mt-0.5 text-ink-400">{formatDateTime(ev.createdAt)}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Panel>
            </Reveal>

            {/* Items */}
            <Reveal as="section">
              <div className="mb-2 px-1">
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
                  Items ({order.items.length})
                </h2>
              </div>
              <Panel className="p-4">
                <ul>
                  {order.items.map((it) => (
                    <li
                      key={it.id}
                      className="flex items-start justify-between gap-3 border-b border-line py-3 first:pt-0 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-900">{it.nameSnap}</p>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {it.packSizeSnap} · Qty {it.qty} × {formatPaise(it.pricePaise)}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-semibold tabular-nums text-ink-900">
                        {formatPaise(it.pricePaise * it.qty)}
                      </p>
                    </li>
                  ))}
                </ul>
              </Panel>
            </Reveal>

            {/* Order again — repopulate the cart from this order's lines (§17 v1). */}
            {order.items.length > 0 && (
              <Button
                variant="secondary"
                className="press w-full rounded-pill border-primary-600/40 bg-primary-50 py-3 font-semibold text-primary-800"
                loading={reorder.isPending}
                onClick={() =>
                  reorder.mutate({
                    items: order.items.map((it) => ({ productId: it.productId, qty: it.qty })),
                  })
                }
              >
                Order again
              </Button>
            )}

            {/* Delivery address */}
            <Reveal as="section">
              <div className="mb-2 px-1">
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
                  Delivery address
                </h2>
              </div>
              <Panel className="p-4">
                {order.addressSnapshot.label && (
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-400">
                    {order.addressSnapshot.label}
                  </p>
                )}
                <p className="text-sm font-medium text-ink-900">
                  {order.addressSnapshot.name} · {order.addressSnapshot.phone}
                </p>
                <p className="text-sm text-ink-600">
                  {order.addressSnapshot.line1}
                  {order.addressSnapshot.line2 ? `, ${order.addressSnapshot.line2}` : ""}
                </p>
                {order.addressSnapshot.landmark && (
                  <p className="text-sm text-ink-600">Near {order.addressSnapshot.landmark}</p>
                )}
                <p className="text-sm text-ink-600">{order.addressSnapshot.pincode}</p>
                {(order.deliveryNote || order.contactless) && (
                  <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                    {order.contactless && (
                      <p className="inline-flex items-center gap-1.5 rounded-pill bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-800">
                        Contactless delivery
                      </p>
                    )}
                    {order.deliveryNote && (
                      <p className="text-xs text-ink-600">Note: {order.deliveryNote}</p>
                    )}
                  </div>
                )}
              </Panel>
            </Reveal>

            {/* Bill */}
            <Reveal as="section">
              <div className="mb-2 px-1">
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
                  Bill details
                </h2>
              </div>
              <Panel className="p-4">
                <dl className="space-y-1.5 text-sm">
                  <BillRow label="Item total" value={formatPaise(order.itemsPaise)} />
                  <BillRow label="Delivery fee" value={formatPaise(order.deliveryPaise)} />
                  {order.discountPaise > 0 && (
                    <BillRow
                      label={order.couponCode ? `Discount (${order.couponCode})` : "Discount"}
                      value={`− ${formatPaise(order.discountPaise)}`}
                      tone="good"
                    />
                  )}
                  <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-base font-bold text-ink-900">
                    <span>Total</span>
                    <span className="tabular-nums">{formatPaise(order.totalPaise)}</span>
                  </div>
                </dl>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-sm">
                  <span className="text-ink-600">Payment</span>
                  <span className="flex items-center gap-2">
                    <span className="text-ink-900">
                      {order.paymentMethod === "COD" ? "Cash on delivery" : "Prepaid"}
                    </span>
                    <Badge tone={PAYMENT_TONE[order.paymentStatus]}>
                      {humanize(order.paymentStatus)}
                    </Badge>
                  </span>
                </div>
              </Panel>
            </Reveal>

            {/* Support — WhatsApp deep-link with the order number pre-filled.
                Hidden when no support phone is configured. */}
            {supportUrl && (
              <a
                href={supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="press inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-pill border border-success/30 bg-success/5 px-4 text-sm font-semibold text-success hover:bg-success/10"
              >
                <WhatsAppIcon />
                Need help with this order?
              </a>
            )}
          </div>

          {/* Sticky contextual action bar (clears the tab nav at bottom-16). */}
          {showActions && (
            <div className="glass fixed inset-x-0 bottom-16 z-30 mx-auto max-w-md px-4 py-3">
              <div className="flex gap-2">
                {trackable && (
                  <Link href={`/orders/${id}/track`} className="flex-1">
                    <Button className="press w-full rounded-pill bg-gradient-to-r from-primary-700 to-primary-600 py-3 shadow-glow">
                      Track order
                    </Button>
                  </Link>
                )}
                {invoiceReady && (
                  <Button
                    className="press flex-1 rounded-pill bg-gradient-to-r from-primary-700 to-primary-600 py-3 shadow-glow"
                    loading={invoiceMut.isPending}
                    onClick={() => invoiceMut.mutate()}
                  >
                    Download invoice
                  </Button>
                )}
                {cancellable && (
                  <Button
                    variant="danger"
                    className={cn("press rounded-pill py-3", trackable ? "" : "flex-1")}
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancel order
                  </Button>
                )}
              </div>
            </div>
          )}

          <Modal
            open={cancelOpen}
            onClose={() => setCancelOpen(false)}
            title="Cancel order"
            footer={
              <>
                <Button variant="ghost" onClick={() => setCancelOpen(false)}>
                  Keep order
                </Button>
                <Button
                  variant="danger"
                  className="press rounded-pill"
                  loading={cancelMut.isPending}
                  disabled={reason.trim().length < 3}
                  onClick={() => cancelMut.mutate()}
                >
                  Cancel order
                </Button>
              </>
            }
          >
            <p className="mb-3 text-sm text-ink-600">
              Orders already being packed may need our team to approve the cancellation.
            </p>
            <Field label="Reason" hint="Minimum 3 characters.">
              <Textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Tell us why you're cancelling"
              />
            </Field>
          </Modal>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- feedback */

type RatingQuery = UseQueryResult<Envelope<Rating | null>, Error>;
type ReturnsQuery = UseQueryResult<Envelope<ReturnRequest[]>, Error>;

/**
 * Post-delivery rating. `GET /v1/orders/:id/rating` returns null until the
 * customer rates; `POST` is an upsert, so re-submitting edits the rating.
 */
function RatingCard({
  orderId,
  hasDriver,
  query,
  qc,
}: {
  orderId: string;
  hasDriver: boolean;
  query: RatingQuery;
  qc: QueryClient;
}) {
  const toast = useToast();
  const existing = query.data?.data ?? null;
  const [editing, setEditing] = useState(false);
  const [orderStars, setOrderStars] = useState(0);
  const [driverStars, setDriverStars] = useState(0);
  const [comment, setComment] = useState("");

  const mut = useMutation({
    mutationFn: (body: CreateRatingBody) => api.post<Rating>(`/v1/orders/${orderId}/rating`, body),
    onSuccess: (res) => {
      qc.setQueryData<Envelope<Rating | null>>(["order-rating", orderId], res);
      setEditing(false);
      toast.push({ type: "success", message: "Thanks for the feedback" });
    },
    onError: (e) =>
      toast.push({ type: "error", message: apiErrorMessage(e, "Could not save your rating") }),
  });

  if (query.isLoading) {
    return (
      <Panel className="p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-9 w-52" />
      </Panel>
    );
  }

  if (query.isError) {
    return (
      <Panel className="p-5">
        <p className="text-sm font-semibold text-ink-900">Rate this order</p>
        <p className="mt-1 text-sm text-ink-600">We couldn&apos;t load your rating just now.</p>
        <Button
          variant="secondary"
          className="press mt-3 rounded-pill"
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </Panel>
    );
  }

  // Submitted view — the rating stands until the customer chooses to edit it.
  if (existing && !editing) {
    return (
      <Panel className="border-primary-600/20 bg-gradient-to-br from-primary-50 to-mint p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary-800">Your rating</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StarsReadOnly value={existing.orderStars} label="Order" />
              <span className="text-xs text-ink-600">Order</span>
            </div>
            {existing.driverStars != null && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <StarsReadOnly value={existing.driverStars} label="Delivery partner" />
                <span className="text-xs text-ink-600">Delivery partner</span>
              </div>
            )}
            {existing.comment && (
              <p className="mt-2 text-sm italic text-ink-600">“{existing.comment}”</p>
            )}
            <p className="mt-2 text-xs text-ink-400">Rated {formatDateTime(existing.createdAt)}</p>
          </div>
          <button
            type="button"
            className="press min-h-[44px] shrink-0 rounded-pill px-3 text-sm font-semibold text-primary-800 underline-offset-2 hover:underline"
            onClick={() => {
              setOrderStars(existing.orderStars);
              setDriverStars(existing.driverStars ?? 0);
              setComment(existing.comment ?? "");
              setEditing(true);
            }}
          >
            Edit
          </button>
        </div>
      </Panel>
    );
  }

  const canSubmit = orderStars >= 1 && !mut.isPending;

  return (
    <Panel className="relative overflow-hidden border-primary-600/20 p-5">
      <span
        className="pointer-events-none absolute -left-10 -bottom-12 h-32 w-32 rounded-full bg-primary-100 blur-2xl"
        aria-hidden
      />
      <div className="relative">
        <p className="text-base font-bold tracking-tight text-ink-900">How did we do?</p>
        <p className="mt-0.5 text-sm text-ink-600">
          Your rating helps our pharmacists and riders improve.
        </p>

        <StarPicker
          name={`order-stars-${orderId}`}
          legend="Rate this order"
          value={orderStars}
          onChange={setOrderStars}
        />

        {hasDriver && (
          <StarPicker
            name={`driver-stars-${orderId}`}
            legend="Rate your delivery partner"
            value={driverStars}
            onChange={setDriverStars}
          />
        )}

        <div className="mt-4">
          <Field label="Anything to add? (optional)" hint="Up to 500 characters.">
            <Textarea
              rows={3}
              maxLength={500}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What went well, or what could be better?"
            />
          </Field>
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            className="press flex-1 rounded-pill bg-gradient-to-r from-primary-700 to-primary-600 py-3 shadow-glow"
            loading={mut.isPending}
            disabled={!canSubmit}
            onClick={() =>
              mut.mutate({
                orderStars,
                ...(hasDriver && driverStars >= 1 ? { driverStars } : {}),
                ...(comment.trim() ? { comment: comment.trim() } : {}),
              })
            }
          >
            {existing ? "Update rating" : "Submit rating"}
          </Button>
          {existing && (
            <Button
              variant="ghost"
              className="press rounded-pill"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

/**
 * "Report an issue" on a delivered order. A pre-existing request is shown
 * instead of the form; a 409 (already requested) refetches rather than erroring.
 */
function ReturnCard({
  orderId,
  query,
  qc,
}: {
  orderId: string;
  query: ReturnsQuery;
  qc: QueryClient;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [note, setNote] = useState("");

  const existing = query.data?.data.find((r) => r.orderId === orderId) ?? null;

  const mut = useMutation({
    mutationFn: (body: { reason: ReturnReason; note?: string }) =>
      api.post<ReturnRequest>(`/v1/orders/${orderId}/returns`, body),
    onSuccess: () => {
      setOpen(false);
      setReason("");
      setNote("");
      void qc.invalidateQueries({ queryKey: ["returns"] });
      toast.push({ type: "success", message: "Reported — our pharmacist will get back to you" });
    },
    onError: (e) => {
      // 409 → a request for this order already exists; show it instead of an error.
      if (e instanceof ApiError && e.status === 409) {
        setOpen(false);
        void qc.invalidateQueries({ queryKey: ["returns"] });
        toast.push({ type: "info", message: e.message || "You've already reported this order" });
        return;
      }
      toast.push({ type: "error", message: apiErrorMessage(e, "Could not report the issue") });
    },
  });

  if (query.isLoading) {
    return (
      <Panel className="p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-10 w-full rounded-pill" />
      </Panel>
    );
  }

  if (existing) {
    const copy = RETURN_STATUS_COPY[existing.status];
    return (
      <Panel className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-ink-900">Issue reported</p>
          <Badge tone={copy.tone}>{copy.label}</Badge>
        </div>
        <p className="mt-2 text-sm text-ink-600">{RETURN_REASON_LABEL[existing.reason]}</p>
        {existing.note && <p className="mt-1 text-sm italic text-ink-600">“{existing.note}”</p>}
        {existing.resolutionNote && (
          <p className="mt-3 rounded-input bg-surface-2 px-3 py-2 text-sm text-ink-600">
            <span className="font-medium text-ink-900">Our response: </span>
            {existing.resolutionNote}
          </p>
        )}
        <p className="mt-2 text-xs text-ink-400">
          Reported {formatDateTime(existing.createdAt)}
          {existing.resolvedAt ? ` · Resolved ${formatDateTime(existing.resolvedAt)}` : ""}
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel className="p-5">
        <p className="text-sm font-semibold text-ink-900">Something wrong with this order?</p>
        <p className="mt-1 text-sm text-ink-600">
          Damaged, missing or incorrect items — tell us and a pharmacist will pick it up.
        </p>
        {query.isError && (
          <p className="mt-2 text-xs text-ink-400">
            We couldn&apos;t check for an existing report — sending a new one is still fine.
          </p>
        )}
        <button
          type="button"
          className="press mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-pill border border-line bg-surface px-4 text-sm font-semibold text-ink-900 hover:bg-surface-2"
          onClick={() => setOpen(true)}
        >
          Report an issue
        </button>
      </Panel>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Report an issue"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              className="press rounded-pill bg-gradient-to-r from-primary-700 to-primary-600 shadow-glow"
              loading={mut.isPending}
              disabled={reason === ""}
              onClick={() => {
                if (reason === "") return;
                mut.mutate({ reason, ...(note.trim() ? { note: note.trim() } : {}) });
              }}
            >
              Submit report
            </Button>
          </>
        }
      >
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink-900">What went wrong?</legend>
          <div className="space-y-2">
            {(Object.keys(RETURN_REASON_LABEL) as ReturnReason[]).map((r) => (
              <label
                key={r}
                className={cn(
                  "press flex min-h-[44px] cursor-pointer items-center gap-3 rounded-input border px-3 py-2 text-sm",
                  reason === r
                    ? "border-primary-600 bg-primary-50 font-medium text-primary-800"
                    : "border-line bg-surface text-ink-900 hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name="return-reason"
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  className="h-4 w-4 shrink-0 accent-primary-600"
                />
                {RETURN_REASON_LABEL[r]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4">
          <Field label="Add a note (optional)" hint="Up to 500 characters.">
            <Textarea
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Which item, and what's wrong with it?"
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------- star input */

function StarGlyph({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-8 w-8", className)}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3.5l2.6 5.3 5.9.86-4.25 4.14 1 5.87L12 16.9l-5.25 2.77 1-5.87L3.5 9.66l5.9-.86z" />
    </svg>
  );
}

/** Read-only stars with a single accessible name (never five separate ones). */
function StarsReadOnly({ value, label }: { value: number; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${value} out of 5 stars`}
      className="inline-flex items-center gap-0.5 text-accent"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <StarGlyph key={n} filled={n <= value} className="h-4 w-4" />
      ))}
    </span>
  );
}

/**
 * Keyboard-accessible star input: real radios (arrow keys + Space work natively)
 * with the visual star as the label; focus is mirrored onto the glyph because
 * the input itself is visually hidden.
 */
function StarPicker({
  name,
  legend,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-medium text-ink-900">{legend}</legend>
      <div className="mt-1 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="press cursor-pointer">
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              className="peer sr-only"
            />
            <span className="sr-only">{`Rate ${n} out of 5`}</span>
            <span
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary-600 peer-focus-visible:ring-offset-2",
                n <= value ? "text-accent" : "text-ink-400",
              )}
            >
              <StarGlyph filled={n <= value} className={cn(n <= value && "animate-pop")} />
            </span>
          </label>
        ))}
      </div>
      <p className="mt-0.5 min-h-[1rem] text-xs font-medium text-ink-600" aria-live="polite">
        {value >= 1 ? `${value} out of 5 · ${STAR_WORD[value]}` : ""}
      </p>
    </fieldset>
  );
}

/* --------------------------------------------------------------- stepper */

type StepState = "done" | "current" | "upcoming";
interface Step {
  key: string;
  label: string;
  at: string | null;
  state: StepState;
  terminal?: boolean;
}

/**
 * Collapses the audit trail onto the canonical happy path: optional nodes
 * (prepaid payment, Rx review) only appear when they apply to this order, and a
 * cancellation is appended as a terminal node after whatever was reached.
 */
function buildSteps(order: OrderDetail): Step[] {
  const reachedAt = new Map<OrderStatus, string>();
  for (const ev of order.events) {
    if (!reachedAt.has(ev.to)) reachedAt.set(ev.to, ev.createdAt);
  }
  const fallback: Partial<Record<OrderStatus, string | null>> = {
    PLACED: order.placedAt,
    PACKING: order.packedAt,
    READY: order.readyAt,
    DELIVERED: order.deliveredAt,
  };

  const flow = FULL_FLOW.filter((s) => {
    if (s === "PENDING_PAYMENT") {
      return order.paymentMethod === "PREPAID" && (reachedAt.has(s) || order.status === s);
    }
    if (s === "RX_REVIEW") return order.requiresRx || reachedAt.has(s);
    return true;
  });

  const cancelled = order.status === "CANCELLED";
  const currentIdx = flow.indexOf(order.status);
  // For a cancelled order nothing is "current" on the happy path — everything
  // actually reached stays done, the rest greys out.
  const lastReached = flow.reduce((acc, s, i) => (reachedAt.has(s) ? i : acc), -1);

  const steps: Step[] = flow.map((s, i) => ({
    key: s,
    label: STEP_LABEL[s],
    at: reachedAt.get(s) ?? fallback[s] ?? null,
    state: cancelled
      ? i <= lastReached
        ? "done"
        : "upcoming"
      : i < currentIdx
        ? "done"
        : i === currentIdx
          ? "current"
          : "upcoming",
  }));

  if (cancelled) {
    steps.push({
      key: "CANCELLED",
      label: STEP_LABEL.CANCELLED,
      at: order.cancelledAt ?? reachedAt.get("CANCELLED") ?? null,
      state: "current",
      terminal: true,
    });
  }
  return steps;
}

function Stepper({ order }: { order: OrderDetail }) {
  const steps = buildSteps(order);
  return (
    <ol>
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const connectorDone = steps[i + 1]?.state !== "upcoming";
        return (
          <li key={step.key} className="flex gap-3.5">
            <div className="flex flex-col items-center">
              <StepNode index={i} state={step.state} terminal={step.terminal} />
              {!isLast && (
                <span
                  className={cn(
                    "my-1 w-[3px] grow rounded-full",
                    connectorDone
                      ? "bg-gradient-to-b from-primary-600 to-primary-500"
                      : "bg-line",
                  )}
                  aria-hidden
                />
              )}
            </div>
            <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-6")}>
              <p
                className={cn(
                  "text-sm leading-9",
                  step.state === "upcoming"
                    ? "text-ink-400"
                    : step.state === "current"
                      ? cn("font-bold", step.terminal ? "text-danger" : "text-ink-900")
                      : "font-medium text-ink-900",
                )}
              >
                {step.label}
              </p>
              {step.at && <p className="-mt-2 text-xs text-ink-400">{formatDateTime(step.at)}</p>}
              {step.state === "current" && !step.terminal && (
                <p className="mt-1 inline-flex items-center gap-1.5 rounded-pill bg-primary-50 px-2.5 py-0.5 text-xs font-semibold text-primary-800">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-600" aria-hidden />
                  In progress
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepNode({
  index,
  state,
  terminal,
}: {
  index: number;
  state: StepState;
  terminal?: boolean;
}) {
  if (state === "upcoming") {
    return (
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-line bg-surface text-xs font-semibold text-ink-400"
        aria-hidden
      >
        {index + 1}
      </span>
    );
  }
  if (state === "done") {
    return (
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-600 to-primary-700 text-white shadow-sm"
        aria-hidden
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  // Current — a haloed node so the eye lands on "where my order is right now".
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center" aria-hidden>
      <span
        className={cn(
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
          terminal ? "bg-danger/40" : "bg-primary-500/50",
        )}
      />
      <span
        className={cn(
          "relative inline-flex h-9 w-9 items-center justify-center rounded-full text-white",
          terminal
            ? "bg-danger shadow-sm"
            : "bg-gradient-to-br from-primary-600 to-primary-700 shadow-glow",
        )}
      >
        {terminal ? (
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <span className="h-2.5 w-2.5 rounded-full bg-white" />
        )}
      </span>
    </span>
  );
}

/* --------------------------------------------------------------- helpers */

/** Elevated panel — the Premium Teal surface for every block on this screen. */
function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl2 border border-line/70 bg-surface shadow-card2", className)}>
      {children}
    </div>
  );
}

/** mm:ss ticker to the auto-cancel deadline (retry-payment card). */
function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <span className="font-semibold tabular-nums text-warning">
      {mm}:{ss}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
        {title}
      </h2>
      <Panel className="p-4">{children}</Panel>
    </section>
  );
}

function BillRow({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-600">{label}</dt>
      <dd className={cn("tabular-nums", tone === "good" ? "text-success" : "text-ink-900")}>
        {value}
      </dd>
    </div>
  );
}

/** Shaped placeholder for the initial detail load (§20.4). */
function OrderDetailSkeleton() {
  return (
    <div className="space-y-5 p-4" aria-hidden>
      <div className="rounded-xl2 border border-line/70 bg-surface p-5 shadow-card2">
        <Skeleton className="h-5 w-24 rounded-pill" />
        <Skeleton className="mt-3 h-7 w-48" />
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="mt-2 h-3 w-40" />
      </div>
      <div className="rounded-xl2 border border-line/70 bg-surface p-5 shadow-card2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3.5 py-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </div>
      <div className="rounded-xl2 border border-line/70 bg-surface p-4 shadow-card2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between py-3">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
