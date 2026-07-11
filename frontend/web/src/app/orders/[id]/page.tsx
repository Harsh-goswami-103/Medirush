"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CancelOrderResult,
  OrderDetail,
  OrderInvoice,
  OrderStatus,
  PaymentStatus,
  Prescription,
} from "@medrush/contracts";
import { api, ApiError } from "@/lib/api";
import { API_BASE_URL, whatsappUrl } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useOrderLive } from "@/lib/socket";
import { formatDateTime, formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  OrderStatusBadge,
  RxBadge,
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

const humanize = (s: string) => s.replace(/_/g, " ").toLowerCase();

/** Order detail — GET /v1/orders/:id, with cancel / track / Rx-upload / invoice actions. */
export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, token, loading: authLoading } = useAuth();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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
    // (READY reveals the OTP). Poll fast while disconnected, back off when live.
    refetchInterval: connected ? 20000 : 4000,
  });

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
      toast.push({
        type: "error",
        message: e instanceof ApiError ? e.message : "Could not cancel the order",
      }),
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
    onError: (e) =>
      toast.push({
        type: "error",
        message: e instanceof ApiError ? e.message : "Upload failed",
      }),
  });

  const invoiceMut = useMutation({
    mutationFn: () => api.get<OrderInvoice>(`/v1/orders/${id}/invoice`),
    onSuccess: (res) => {
      // Presigned PDF in prod; a stub URL in local dev (non-dereferenceable — expected).
      window.open(res.data.url, "_blank", "noopener,noreferrer");
    },
    onError: (e) =>
      toast.push({
        type: "error",
        message: e instanceof ApiError ? e.message : "Could not fetch the invoice",
      }),
  });

  // Auth still resolving, or redirecting an anonymous visitor away.
  if (authLoading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const order = orderQuery.data?.data;

  const liveBadge = connected ? (
    <span className="flex items-center gap-1 text-xs font-medium text-success">
      <span className="h-2 w-2 rounded-full bg-success" />
      Live
    </span>
  ) : undefined;

  const cancellable = order ? CANCELLABLE.includes(order.status) : false;
  const trackable = order ? TRACKABLE.includes(order.status) : false;
  const delivered = order?.status === "DELIVERED";
  // The invoice number is null until the async invoice job runs post-delivery.
  const invoiceReady = delivered && order?.invoiceNo != null;
  const showActions = cancellable || trackable || invoiceReady;
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
    <div>
      <TopBar back title={order?.orderNo ?? "Order"} right={liveBadge} />

      {orderQuery.isError ? (
        <div className="p-4">
          <ErrorState
            message={(orderQuery.error as Error).message}
            onRetry={() => orderQuery.refetch()}
          />
        </div>
      ) : !order ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : (
        <>
          <div className={cn("space-y-4 p-4", showActions ? "pb-32" : "pb-6")}>
            {/* Status header */}
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <OrderStatusBadge status={order.status} />
                <RxBadge status={order.rxStatus} />
              </div>
              <p className="mt-2 text-xs text-ink-400">Placed {formatDateTime(order.createdAt)}</p>
              {order.status === "CANCELLED" && order.cancelReason && (
                <p className="mt-1 text-sm text-danger">Reason: {order.cancelReason}</p>
              )}
            </Card>

            {/* Delivery OTP — owner-only, READY+ (server returns null otherwise) */}
            {order.deliveryOtp && (
              <Card className="border-primary-600/30 bg-primary-600/5 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
                  Delivery OTP
                </p>
                <p className="mt-1 text-3xl font-bold tabular-nums tracking-[0.35em] text-primary-700">
                  {order.deliveryOtp}
                </p>
                <p className="mt-1 text-xs text-ink-600">
                  Share this with your delivery partner to receive the order.
                </p>
              </Card>
            )}

            {/* Driver card */}
            {order.driver && (
              <Section title="Delivery partner">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-900">
                      {order.driver.name ?? "Assigned"}
                    </p>
                    <p className="text-xs text-ink-600">
                      {order.driver.vehicleType}
                      {order.driver.vehicleNo ? ` · ${order.driver.vehicleNo}` : ""}
                    </p>
                  </div>
                  <a href={`tel:${order.driver.phone}`}>
                    <Button variant="secondary">Call</Button>
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
                          {p.reviewNote && (
                            <p className="text-xs text-ink-400">{p.reviewNote}</p>
                          )}
                        </div>
                        <RxBadge status={p.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            {/* Timeline */}
            {order.events.length > 0 && (
              <Section title="Timeline">
                <ol>
                  {order.events.map((ev, i) => {
                    const last = i === order.events.length - 1;
                    return (
                      <li key={`${ev.to}-${ev.createdAt}`} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-primary-600" />
                          {!last && <span className="w-px flex-1 bg-line" />}
                        </div>
                        <div className={cn("flex-1", !last && "pb-4")}>
                          <div className="flex flex-wrap items-center gap-2">
                            <OrderStatusBadge status={ev.to} />
                            <span className="text-xs text-ink-400">
                              {humanize(ev.actorType)}
                            </span>
                          </div>
                          {ev.note && <p className="mt-1 text-sm text-ink-600">{ev.note}</p>}
                          <p className="mt-0.5 text-xs text-ink-400">
                            {formatDateTime(ev.createdAt)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Section>
            )}

            {/* Items */}
            <Section title={`Items (${order.items.length})`}>
              <ul>
                {order.items.map((it) => (
                  <li
                    key={it.id}
                    className="flex items-start justify-between gap-3 border-b border-line py-2 first:pt-0 last:border-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-ink-900">{it.nameSnap}</p>
                      <p className="text-xs text-ink-400">
                        {it.packSizeSnap} · Qty {it.qty} × {formatPaise(it.pricePaise)}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-medium tabular-nums text-ink-900">
                      {formatPaise(it.pricePaise * it.qty)}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>

            {/* Delivery address */}
            <Section title="Delivery address">
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
            </Section>

            {/* Bill */}
            <Section title="Bill details">
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
                <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-base font-semibold text-ink-900">
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
            </Section>

            {/* Support — WhatsApp deep-link with the order number pre-filled. */}
            <a
              href={whatsappUrl(`Hi, I need help with order ${order.orderNo}.`)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-input border border-success/30 bg-success/5 px-3.5 py-2 text-sm font-medium text-success hover:bg-success/10"
            >
              <WhatsAppIcon />
              Need help with this order?
            </a>
          </div>

          {/* Sticky contextual action bar (clears the tab nav at bottom-16). */}
          {showActions && (
            <div className="fixed inset-x-0 bottom-16 z-30 mx-auto max-w-md border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
              <div className="flex gap-2">
                {trackable && (
                  <Link href={`/orders/${id}/track`} className="flex-1">
                    <Button className="w-full">Track order</Button>
                  </Link>
                )}
                {invoiceReady && (
                  <Button
                    className="flex-1"
                    loading={invoiceMut.isPending}
                    onClick={() => invoiceMut.mutate()}
                  >
                    Download invoice
                  </Button>
                )}
                {cancellable && (
                  <Button
                    variant="danger"
                    className={trackable ? "" : "flex-1"}
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

/* --------------------------------------------------------------- helpers */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
        {title}
      </h2>
      <Card className="p-4">{children}</Card>
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
