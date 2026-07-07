"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpsOrderDetail, ReadyAllocation } from "@medrush/contracts";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  OrderStatusBadge,
  RxBadge,
  Spinner,
} from "@/components/ui";

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const key = ["ops-order", id];

  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<OpsOrderDetail>(`/v1/ops/orders/${id}`),
  });
  const order = query.data?.data;

  const [actionError, setActionError] = useState<string | null>(null);
  const onError = (err: unknown) =>
    setActionError(err instanceof ApiError ? err.message : "Action failed");
  const onSuccess = () => {
    setActionError(null);
    void qc.invalidateQueries({ queryKey: key });
  };

  const rxReview = useMutation({
    mutationFn: (body: { status: "APPROVED" | "REJECTED"; note?: string; patientName?: string; doctorName?: string }) =>
      api.post(`/v1/ops/orders/${id}/rx-review`, body),
    onSuccess,
    onError,
  });
  const startPacking = useMutation({
    mutationFn: () => api.post(`/v1/ops/orders/${id}/start-packing`),
    onSuccess,
    onError,
  });
  const markReady = useMutation({
    mutationFn: (allocations: ReadyAllocation[]) => api.post(`/v1/ops/orders/${id}/ready`, { allocations }),
    onSuccess,
    onError,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => api.post(`/v1/ops/orders/${id}/cancel`, { reason }),
    onSuccess,
    onError,
  });

  if (query.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }
  if (query.isError || !order) {
    return <ErrorState message={(query.error as Error)?.message ?? "Order not found"} onRetry={() => query.refetch()} />;
  }

  const busy = rxReview.isPending || startPacking.isPending || markReady.isPending || cancel.isPending;
  const canStartPacking = order.status === "PLACED" || (order.status === "RX_REVIEW" && order.rxStatus === "APPROVED");
  const canReady = order.status === "PACKING";
  const canCancel = ["PLACED", "RX_REVIEW", "PACKING", "READY"].includes(order.status);
  const inRxReview = order.status === "RX_REVIEW" && order.rxStatus === "PENDING";

  // FEFO auto-allocation from the server pre-fill (§9.4); ready is enabled only
  // when every item is fully covered by suggestions.
  const fefoAllocations: ReadyAllocation[] = order.items.flatMap((item) =>
    item.fefoSuggestions.map((s) => ({ orderItemId: item.id, batchId: s.batchId, qty: s.qty })),
  );
  const fefoCovers = order.items.every(
    (item) => item.fefoSuggestions.reduce((sum, s) => sum + s.qty, 0) === item.qty,
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link href="/orders" className="text-sm text-ink-600 hover:underline">
          ← Board
        </Link>
        <h1 className="text-xl font-semibold text-ink-900">{order.orderNo}</h1>
        <OrderStatusBadge status={order.status} />
        <RxBadge status={order.rxStatus} />
        {order.cancelRequested && <Badge tone="amber">cancel requested</Badge>}
      </div>

      {actionError && <p className="mb-3 rounded-input bg-danger/10 px-3 py-2 text-sm text-danger">{actionError}</p>}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          {/* Items */}
          <Card>
            <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink-900">Items</div>
            <table className="w-full text-sm">
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id} className="border-b border-line last:border-0 align-top">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-ink-900">{item.nameSnap}</div>
                      <div className="text-xs text-ink-400">
                        {item.packSizeSnap} · bin {item.binLocation || "—"}
                        {item.requiresRx && <span className="ml-1 text-rx">· Rx</span>}
                      </div>
                      {item.allocations.length > 0 && (
                        <div className="mt-1 text-xs text-ink-600">
                          Batches: {item.allocations.map((a) => `${a.batchNoSnap}×${a.qty}`).join(", ")}
                        </div>
                      )}
                      {canReady && item.allocations.length === 0 && item.fefoSuggestions.length > 0 && (
                        <div className="mt-1 text-xs text-primary-700">
                          FEFO: {item.fefoSuggestions.map((s) => `${s.batchNo}×${s.qty}`).join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-600">×{item.qty}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(item.pricePaise * item.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Prescriptions */}
          {order.prescriptions.length > 0 && (
            <Card>
              <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink-900">Prescriptions</div>
              <div className="space-y-3 p-4">
                {order.prescriptions.map((rx) => (
                  <div key={rx.id} className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <a href={rx.fileUrl} target="_blank" rel="noreferrer" className="text-primary-700 hover:underline">
                        View {rx.mimeType.includes("pdf") ? "PDF" : "image"}
                      </a>
                      <div className="text-xs text-ink-400">{formatDateTime(rx.createdAt)}</div>
                      {(rx.patientName || rx.doctorName) && (
                        <div className="text-xs text-ink-600">
                          {rx.patientName && `Patient: ${rx.patientName}`} {rx.doctorName && `· Dr. ${rx.doctorName}`}
                        </div>
                      )}
                    </div>
                    <RxBadge status={rx.status} />
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Rx review panel */}
          {inRxReview && order.prescriptions.length > 0 && (
            <RxReviewPanel
              busy={busy}
              onApprove={(patientName, doctorName) => rxReview.mutate({ status: "APPROVED", patientName, doctorName })}
              onReject={(note) => rxReview.mutate({ status: "REJECTED", note })}
            />
          )}

          {/* Events */}
          <Card>
            <div className="border-b border-line px-4 py-2.5 text-sm font-medium text-ink-900">Timeline</div>
            <ol className="space-y-2 p-4 text-sm">
              {order.events.map((e, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="text-ink-900">{e.to.replace(/_/g, " ")}</span>
                  <span className="text-xs text-ink-400">
                    {e.actorType.toLowerCase()} · {formatDateTime(e.createdAt)}
                  </span>
                  {e.note && <span className="text-xs text-ink-600">— {e.note}</span>}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        {/* Side: actions + summary */}
        <div className="space-y-5">
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium text-ink-900">Actions</div>
            <div className="space-y-2">
              {canStartPacking && (
                <Button className="w-full" loading={startPacking.isPending} onClick={() => startPacking.mutate()}>
                  Start packing
                </Button>
              )}
              {canReady && (
                <Button
                  className="w-full"
                  loading={markReady.isPending}
                  disabled={!fefoCovers}
                  onClick={() => markReady.mutate(fefoAllocations)}
                >
                  {fefoCovers ? "Mark ready (FEFO)" : "Insufficient stock for FEFO"}
                </Button>
              )}
              {canCancel && <CancelButton busy={busy} onCancel={(reason) => cancel.mutate(reason)} />}
              {!canStartPacking && !canReady && !canCancel && !inRxReview && (
                <p className="text-sm text-ink-400">No actions available in this state.</p>
              )}
            </div>
          </Card>

          <Card className="p-4 text-sm">
            <div className="mb-2 font-medium text-ink-900">Customer</div>
            <div className="text-ink-600">{order.customer.name ?? "—"}</div>
            <div className="text-ink-600">{order.customer.phone}</div>
            <div className="mt-2 text-ink-600">
              {order.addressSnapshot.line1}
              {order.addressSnapshot.landmark ? `, ${order.addressSnapshot.landmark}` : ""}, {order.addressSnapshot.pincode}
            </div>
          </Card>

          <Card className="p-4 text-sm">
            <Row label="Items" value={formatPaise(order.itemsPaise)} />
            <Row label="Delivery" value={formatPaise(order.deliveryPaise)} />
            {order.discountPaise > 0 && <Row label="Discount" value={`−${formatPaise(order.discountPaise)}`} />}
            <div className="mt-1 border-t border-line pt-1">
              <Row label="Total" value={formatPaise(order.totalPaise)} bold />
            </div>
            <div className="mt-2 text-xs text-ink-400">
              {order.paymentMethod} · {order.paymentStatus.replace(/_/g, " ").toLowerCase()}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-ink-600">{label}</span>
      <span className={bold ? "font-semibold text-ink-900" : "text-ink-900"}>{value}</span>
    </div>
  );
}

function RxReviewPanel({
  busy,
  onApprove,
  onReject,
}: {
  busy: boolean;
  onApprove: (patientName?: string, doctorName?: string) => void;
  onReject: (note: string) => void;
}) {
  const [patientName, setPatientName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  return (
    <Card className="border-rx/30 p-4">
      <div className="mb-3 text-sm font-medium text-rx">Prescription review</div>
      {!rejecting ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              className="rounded-input border border-line px-2.5 py-1.5 text-sm outline-none focus:border-primary-600"
              placeholder="Patient name (H1)"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
            />
            <input
              className="rounded-input border border-line px-2.5 py-1.5 text-sm outline-none focus:border-primary-600"
              placeholder="Doctor name (H1)"
              value={doctorName}
              onChange={(e) => setDoctorName(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              loading={busy}
              onClick={() => onApprove(patientName || undefined, doctorName || undefined)}
            >
              Approve
            </Button>
            <Button variant="danger" className="flex-1" disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            className="w-full rounded-input border border-line px-2.5 py-1.5 text-sm outline-none focus:border-primary-600"
            placeholder="Reason for rejection (shared with the customer)"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setRejecting(false)}>
              Back
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              loading={busy}
              disabled={note.trim().length < 1}
              onClick={() => onReject(note.trim())}
            >
              Confirm reject
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function CancelButton({ busy, onCancel }: { busy: boolean; onCancel: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <Button variant="ghost" className="w-full text-danger" onClick={() => setOpen(true)}>
        Cancel order
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-input border border-danger/20 bg-danger/5 p-2">
      <textarea
        className="w-full rounded-input border border-line px-2.5 py-1.5 text-sm outline-none focus:border-primary-600"
        placeholder="Cancellation reason"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
          Keep
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          loading={busy}
          disabled={reason.trim().length < 3}
          onClick={() => onCancel(reason.trim())}
        >
          Confirm
        </Button>
      </div>
    </div>
  );
}
