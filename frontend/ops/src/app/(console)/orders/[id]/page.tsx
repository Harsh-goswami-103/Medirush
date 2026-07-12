"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminDriver,
  DispatchAssignment,
  OpsCancelOrderBody,
  OpsOrderDetail,
  ReadyAllocation,
  RedispatchResult,
  UnassignResult,
} from "@medrush/contracts";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { isAdmin, useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
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
import { Field, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

/** Human toast for dispatch-action failures — switch on `error.code` (§7.1), never parse messages. */
function dispatchActionMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Action failed — try again";
  switch (err.code) {
    case "CONFLICT":
    case "INVALID_TRANSITION":
      // 409 — busy driver, order moved on, or a concurrent change; the server message says which.
      return err.message || "Order changed — reload and retry";
    case "FORBIDDEN":
      // 403 — unverified or blocked driver.
      return err.message || "This driver cannot take orders";
    case "NOT_FOUND":
      return err.message || "Order or driver not found";
    default:
      return err.message || "Action failed — try again";
  }
}

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
    mutationFn: (body: OpsCancelOrderBody) => api.post(`/v1/ops/orders/${id}/cancel`, body),
    onSuccess,
    onError,
  });

  /* ----- dispatch escape hatches (§9.5) + OTP unlock (§9.7) — toast-driven ----- */

  const toast = useToast();
  const toastError = (err: unknown) =>
    toast.push({ type: "error", message: dispatchActionMessage(err) });

  const [assignOpen, setAssignOpen] = useState(false);
  const [unassignOpen, setUnassignOpen] = useState(false);
  const [redispatchAfter, setRedispatchAfter] = useState(false);
  const closeUnassign = () => {
    setUnassignOpen(false);
    setRedispatchAfter(false);
  };

  const assign = useMutation({
    mutationFn: (driverId: string) =>
      api.post<DispatchAssignment>(`/v1/ops/orders/${id}/assign`, { driverId }),
    onSuccess: () => {
      toast.push({ type: "success", message: "Driver assigned" });
      setAssignOpen(false);
      onSuccess();
    },
    onError: toastError,
  });

  const redispatch = useMutation({
    mutationFn: () => api.post<RedispatchResult>(`/v1/ops/orders/${id}/redispatch`),
    onSuccess: (res) => {
      const n = res.data.offersCreated;
      toast.push({
        type: n > 0 ? "success" : "info",
        message:
          n > 0
            ? `Re-dispatched — ${n} offer${n === 1 ? "" : "s"} sent to nearby drivers`
            : "Re-dispatched — no drivers available right now; try a manual assign",
      });
      onSuccess();
    },
    onError: toastError,
  });

  const unassign = useMutation({
    mutationFn: (redispatchNow: boolean) =>
      api.post<UnassignResult>(`/v1/ops/orders/${id}/unassign`, { redispatch: redispatchNow }),
    onSuccess: (res) => {
      const { redispatched, offersCreated } = res.data;
      toast.push({
        type: "success",
        message: !redispatched
          ? "Driver un-assigned — order is back to READY"
          : offersCreated > 0
            ? `Driver un-assigned — re-dispatched, ${offersCreated} offer${offersCreated === 1 ? "" : "s"} sent`
            : "Driver un-assigned — re-dispatched, but no drivers are available right now",
      });
      closeUnassign();
      onSuccess();
    },
    onError: toastError,
  });

  const resetOtpAttempts = useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/v1/ops/orders/${id}/reset-otp`),
    onSuccess: () => {
      toast.push({ type: "success", message: "Delivery OTP attempts reset — the driver can retry" });
      onSuccess();
    },
    onError: toastError,
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

  const busy =
    rxReview.isPending ||
    startPacking.isPending ||
    markReady.isPending ||
    cancel.isPending ||
    assign.isPending ||
    redispatch.isPending ||
    unassign.isPending ||
    resetOtpAttempts.isPending;
  const canStartPacking = order.status === "PLACED" || (order.status === "RX_REVIEW" && order.rxStatus === "APPROVED");
  const canReady = order.status === "PACKING";
  // Dispatch escape hatches (§9.5): READY with no active delivery can be
  // manually assigned or re-offered; ASSIGNED (before pickup) can be undone.
  const canAssign = order.status === "READY" && !order.delivery;
  const canUnassign = order.status === "ASSIGNED";
  // §9.7 unlock — active delivery-stage orders only (server 409s otherwise).
  const canResetOtp = ["READY", "ASSIGNED", "PICKED_UP"].includes(order.status);
  // Ops may cancel any pre-DELIVERED order (state machine §9.1) — ASSIGNED/
  // PICKED_UP included, which is where a doorstep COD refusal is recorded.
  const canCancel = ["PLACED", "RX_REVIEW", "PACKING", "READY", "ASSIGNED", "PICKED_UP"].includes(order.status);
  const codRefusalEligible =
    order.paymentMethod === "COD" && ["ASSIGNED", "PICKED_UP"].includes(order.status);
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
              {canAssign && (
                <>
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={busy}
                    onClick={() => setAssignOpen(true)}
                  >
                    Assign driver
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full"
                    loading={redispatch.isPending}
                    disabled={busy && !redispatch.isPending}
                    onClick={() => redispatch.mutate()}
                  >
                    Re-dispatch
                  </Button>
                </>
              )}
              {canUnassign && (
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={busy}
                  onClick={() => setUnassignOpen(true)}
                >
                  Un-assign driver
                </Button>
              )}
              {canResetOtp && (
                <ResetOtpAction
                  disabled={busy}
                  onReset={() => resetOtpAttempts.mutateAsync()}
                />
              )}
              {canCancel && (
                <CancelButton
                  busy={busy}
                  codEligible={codRefusalEligible}
                  onCancel={(reason, codRefused) =>
                    cancel.mutate({ reason, ...(codRefused ? { codRefused: true } : {}) })
                  }
                />
              )}
              {!canStartPacking && !canReady && !canAssign && !canUnassign && !canResetOtp && !canCancel && !inRxReview && (
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

          {order.delivery && (
            <Card className="p-4 text-sm">
              <div className="mb-2 font-medium text-ink-900">Delivery</div>
              <div className="text-ink-600">
                {order.delivery.driverName ?? "Driver"} · {order.delivery.driverPhone}
              </div>
              <div className="mt-1 text-xs text-ink-400">
                Accepted {formatDateTime(order.delivery.acceptedAt)}
                {order.delivery.pickedUpAt && <> · picked up {formatDateTime(order.delivery.pickedUpAt)}</>}
                {order.delivery.deliveredAt && <> · delivered {formatDateTime(order.delivery.deliveredAt)}</>}
              </div>
              {order.delivery.codCollectedPaise !== null && (
                <div className="mt-1 text-xs text-ink-600">
                  COD collected: {formatPaise(order.delivery.codCollectedPaise)}
                </div>
              )}
            </Card>
          )}

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

      {/* Mount-on-open so the picker state resets each time. */}
      {assignOpen && (
        <AssignDriverModal
          onClose={() => setAssignOpen(false)}
          assigning={assign.isPending}
          onAssign={(driverId) => assign.mutate(driverId)}
        />
      )}

      <Modal
        open={unassignOpen}
        onClose={closeUnassign}
        title="Un-assign driver"
        footer={
          <>
            <Button variant="secondary" onClick={closeUnassign}>
              Keep driver
            </Button>
            <Button variant="danger" loading={unassign.isPending} onClick={() => unassign.mutate(redispatchAfter)}>
              Un-assign
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-600">
          Take this order back from{" "}
          {order.delivery?.driverName ?? order.delivery?.driverPhone ?? "the driver"}? It returns to
          READY.
        </p>
        <label className="flex items-start gap-2 text-sm text-ink-600">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary-600"
            checked={redispatchAfter}
            onChange={(e) => setRedispatchAfter(e.target.checked)}
          />
          <span>
            Re-dispatch immediately
            <span className="block text-xs text-ink-400">
              Start a fresh offer wave to nearby drivers right after the un-assign.
            </span>
          </span>
        </label>
      </Modal>
    </div>
  );
}

/**
 * Driver picker for the manual assign (§9.5). The fleet roster endpoint
 * (GET /v1/admin/drivers) is ADMIN-only, so INVENTORY operators degrade to a
 * manual DriverProfile-id input instead of a picker.
 */
function AssignDriverModal({
  onClose,
  onAssign,
  assigning,
}: {
  onClose: () => void;
  onAssign: (driverId: string) => void;
  assigning: boolean;
}) {
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const [selected, setSelected] = useState("");

  const driversQuery = useQuery({
    queryKey: ["admin-drivers", "assign-picker"],
    queryFn: () => api.get<AdminDriver[]>("/v1/admin/drivers"),
    enabled: admin,
    staleTime: 15_000,
  });

  // Degrade for INVENTORY (and any unexpected 403): manual id entry.
  const listForbidden =
    !admin || (driversQuery.error instanceof ApiError && driversQuery.error.status === 403);

  const drivers = [...(driversQuery.data?.data ?? [])].sort(
    (a, b) =>
      Number(b.isOnline) - Number(a.isOnline) ||
      Number(b.isVerified) - Number(a.isVerified) ||
      (a.name ?? a.phone).localeCompare(b.name ?? b.phone),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Assign driver"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={assigning}
            disabled={selected.trim().length === 0}
            onClick={() => onAssign(selected.trim())}
          >
            Assign
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-600">
        Directly assign this order to a driver, skipping the offer waves. The driver must be
        verified and free of active deliveries.
      </p>
      {listForbidden ? (
        <Field
          label="Driver ID"
          hint="The fleet roster is admin-only — paste the driver's profile id from an admin."
        >
          <TextInput
            placeholder="DriverProfile id"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          />
        </Field>
      ) : driversQuery.isError ? (
        <ErrorState
          message={(driversQuery.error as Error).message}
          onRetry={() => driversQuery.refetch()}
        />
      ) : driversQuery.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner className="h-5 w-5 text-primary-600" />
        </div>
      ) : drivers.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-400">No drivers on the roster yet.</p>
      ) : (
        <ul className="space-y-1">
          {drivers.map((d) => {
            const selectable = d.isVerified && !d.isBlocked;
            return (
              <li key={d.id}>
                <label
                  className={cn(
                    "flex items-center gap-3 rounded-input border px-3 py-2",
                    selected === d.id ? "border-primary-600 bg-primary-600/10" : "border-line",
                    selectable ? "cursor-pointer" : "opacity-60",
                    selectable && selected !== d.id && "hover:bg-surface-2",
                  )}
                >
                  <input
                    type="radio"
                    name="assign-driver"
                    className="accent-primary-600"
                    disabled={!selectable}
                    checked={selected === d.id}
                    onChange={() => setSelected(d.id)}
                  />
                  <span className="flex-1 text-sm">
                    <span className="font-medium text-ink-900">{d.name ?? d.phone}</span>
                    <span className="ml-1.5 text-xs text-ink-400">{d.phone}</span>
                  </span>
                  <Badge tone={d.isOnline ? "green" : "neutral"}>
                    {d.isOnline ? "Online" : "Offline"}
                  </Badge>
                  {!d.isVerified && <Badge tone="amber">Unverified</Badge>}
                  {d.isBlocked && <Badge tone="red">Blocked</Badge>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** Two-step inline confirm for the §9.7 OTP-attempts unlock (small, low-traffic action). */
function ResetOtpAction({
  disabled,
  onReset,
}: {
  disabled: boolean;
  onReset: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (!confirming) {
    return (
      <Button variant="ghost" className="w-full" disabled={disabled} onClick={() => setConfirming(true)}>
        Reset delivery OTP attempts
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-input border border-line bg-surface-2 p-2">
      <p className="text-xs text-ink-600">
        Zero the wrong-OTP counter so the driver can retry the delivery confirmation?
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled={pending} onClick={() => setConfirming(false)}>
          Keep
        </Button>
        <Button
          className="flex-1"
          loading={pending}
          onClick={() => {
            setPending(true);
            void onReset()
              .then(() => setConfirming(false))
              .catch(() => undefined) // toast comes from the mutation's onError
              .finally(() => setPending(false));
          }}
        >
          Reset
        </Button>
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

function CancelButton({
  busy,
  codEligible,
  onCancel,
}: {
  busy: boolean;
  /** COD order at ASSIGNED/PICKED_UP — the only window a doorstep refusal can be recorded (§10.3). */
  codEligible: boolean;
  onCancel: (reason: string, codRefused: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [codRefused, setCodRefused] = useState(false);
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
      {codEligible && (
        <label className="flex items-start gap-2 text-xs text-ink-600">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary-600"
            checked={codRefused}
            onChange={(e) => setCodRefused(e.target.checked)}
          />
          <span>
            Customer refused COD delivery at the door
            <span className="block text-ink-400">
              Counts toward the customer&rsquo;s COD auto-disable limit — tick only for a genuine
              doorstep refusal.
            </span>
          </span>
        </label>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
          Keep
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          loading={busy}
          disabled={reason.trim().length < 3}
          onClick={() => onCancel(reason.trim(), codEligible && codRefused)}
        >
          Confirm
        </Button>
      </div>
    </div>
  );
}
