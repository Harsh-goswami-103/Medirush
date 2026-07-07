"use client";

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PayoutStatus } from "@medrush/contracts";
import type { AdminPayout, MarkPayoutPaidBody, RejectPayoutBody } from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Table, THead, Th, Tr, Td, Field, Select, TextInput, Textarea } from "@/components/kit";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

const STATUS_TONE = {
  REQUESTED: "amber",
  APPROVED: "blue",
  PAID: "green",
  REJECTED: "red",
} as const satisfies Record<PayoutStatus, string>;

export default function AdminPayoutsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<PayoutStatus | undefined>(undefined);

  const query = useInfiniteQuery({
    queryKey: ["admin-payouts", status ?? "ALL"],
    queryFn: ({ pageParam }) =>
      api.get<AdminPayout[]>(`/v1/admin/payouts${qs({ status, cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
  });
  const payouts = query.data?.pages.flatMap((p) => p.data) ?? [];

  // Reject (any reason) and mark-paid (a bank UTR) both collect input via a modal.
  const [rejectTarget, setRejectTarget] = useState<AdminPayout | null>(null);
  const [payTarget, setPayTarget] = useState<AdminPayout | null>(null);
  const [reason, setReason] = useState("");
  const [utr, setUtr] = useState("");

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["admin-payouts"] });
  const onError = (e: unknown) =>
    toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" });

  const approve = useMutation({
    mutationFn: (id: string) => api.post<AdminPayout>(`/v1/admin/payouts/${id}/approve`),
    onSuccess: () => {
      invalidate();
      toast.push({ type: "success", message: "Payout approved — wallet debited" });
    },
    onError,
  });

  const reject = useMutation({
    mutationFn: ({ id, body }: { id: string; body: RejectPayoutBody }) =>
      api.post<AdminPayout>(`/v1/admin/payouts/${id}/reject`, body),
    onSuccess: () => {
      invalidate();
      toast.push({ type: "success", message: "Payout rejected" });
      closeReject();
    },
    onError,
  });

  const markPaid = useMutation({
    mutationFn: ({ id, body }: { id: string; body: MarkPayoutPaidBody }) =>
      api.post<AdminPayout>(`/v1/admin/payouts/${id}/mark-paid`, body),
    onSuccess: () => {
      invalidate();
      toast.push({ type: "success", message: "Payout marked paid" });
      closePay();
    },
    onError,
  });

  function closeReject() {
    setRejectTarget(null);
    setReason("");
  }
  function closePay() {
    setPayTarget(null);
    setUtr("");
  }

  return (
    <div>
      <PageHeader title="Payouts" subtitle="Approve driver withdrawals and settle UPI transfers." />

      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-ink-600">Status</span>
        <Select
          className="w-44"
          value={status ?? ""}
          onChange={(e) => setStatus((e.target.value || undefined) as PayoutStatus | undefined)}
        >
          <option value="">All</option>
          {Object.values(PayoutStatus).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        {query.isFetching && !query.isFetchingNextPage && (
          <Spinner className="h-4 w-4 text-ink-400" />
        )}
      </div>

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : payouts.length === 0 ? (
        <EmptyState title="No payouts" hint="Driver withdrawal requests will show up here." />
      ) : (
        <>
          <Table>
            <THead>
              <Tr>
                <Th>Driver</Th>
                <Th right>Amount</Th>
                <Th>Status</Th>
                <Th>Method</Th>
                <Th>UPI / Account</Th>
                <Th>Requested</Th>
                <Th right>Actions</Th>
              </Tr>
            </THead>
            <tbody>
              {payouts.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <div className="font-medium text-ink-900">{p.driverName ?? "—"}</div>
                    <div className="text-xs text-ink-400">{p.driverPhone}</div>
                  </Td>
                  <Td right>{formatPaise(p.amountPaise)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                  </Td>
                  <Td className="text-ink-600">{p.method}</Td>
                  <Td className="text-ink-600">{p.upiOrAcct}</Td>
                  <Td className="text-ink-600">{formatDateTime(p.requestedAt)}</Td>
                  <Td right>
                    <div className="flex justify-end gap-2">
                      {p.status === "REQUESTED" && (
                        <Button
                          className="px-2.5 py-1.5 text-xs"
                          loading={approve.isPending && approve.variables === p.id}
                          onClick={() => approve.mutate(p.id)}
                        >
                          Approve
                        </Button>
                      )}
                      {p.status === "APPROVED" && (
                        <Button
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => setPayTarget(p)}
                        >
                          Mark paid
                        </Button>
                      )}
                      {(p.status === "REQUESTED" || p.status === "APPROVED") && (
                        <Button
                          variant="secondary"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={() => setRejectTarget(p)}
                        >
                          Reject
                        </Button>
                      )}
                      {(p.status === "PAID" || p.status === "REJECTED") && (
                        <span className="text-xs text-ink-400">{p.utr ? `UTR ${p.utr}` : "—"}</span>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>

          {query.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      {/* Reject */}
      <Modal
        open={rejectTarget !== null}
        onClose={closeReject}
        title="Reject payout"
        footer={
          <>
            <Button variant="secondary" onClick={closeReject}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={reject.isPending}
              disabled={reason.trim().length < 3}
              onClick={() =>
                rejectTarget &&
                reject.mutate({ id: rejectTarget.id, body: { reason: reason.trim() } })
              }
            >
              Reject payout
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-600">
          {rejectTarget && (
            <>
              {formatPaise(rejectTarget.amountPaise)} to {rejectTarget.driverName ?? rejectTarget.driverPhone}.
              An approved payout is refunded to the driver&rsquo;s wallet.
            </>
          )}
        </p>
        <Field label="Reason" hint="Shared with the driver (min 3 characters).">
          <Textarea
            rows={3}
            placeholder="e.g. invalid UPI id — please re-request"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Modal>

      {/* Mark paid */}
      <Modal
        open={payTarget !== null}
        onClose={closePay}
        title="Mark payout paid"
        footer={
          <>
            <Button variant="secondary" onClick={closePay}>
              Cancel
            </Button>
            <Button
              loading={markPaid.isPending}
              disabled={utr.trim().length < 4}
              onClick={() =>
                payTarget && markPaid.mutate({ id: payTarget.id, body: { utr: utr.trim() } })
              }
            >
              Mark paid
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-600">
          {payTarget && (
            <>
              Confirm the {formatPaise(payTarget.amountPaise)} UPI/IMPS transfer to{" "}
              {payTarget.driverName ?? payTarget.driverPhone}.
            </>
          )}
        </p>
        <Field label="Bank UTR" hint="Transfer reference (min 4 characters).">
          <TextInput
            placeholder="e.g. 431298765432"
            value={utr}
            onChange={(e) => setUtr(e.target.value)}
          />
        </Field>
      </Modal>
    </div>
  );
}
