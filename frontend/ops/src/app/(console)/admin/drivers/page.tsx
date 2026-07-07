"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminDriver, BlockBody } from "@medrush/contracts";
import { api, ApiError } from "@/lib/api";
import { formatPaise } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Table, THead, Th, Tr, Td, Field, Textarea } from "@/components/kit";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

const KEY = ["admin-drivers"];

export default function AdminDriversPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<AdminDriver[]>("/v1/admin/drivers"),
  });
  const drivers = query.data?.data ?? [];

  // Block requires an (optional) reason, so it routes through a modal; unblock is direct.
  const [blockTarget, setBlockTarget] = useState<AdminDriver | null>(null);
  const [reason, setReason] = useState("");

  const invalidate = () => void qc.invalidateQueries({ queryKey: KEY });
  const onError = (e: unknown) =>
    toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" });

  const verify = useMutation({
    mutationFn: (id: string) => api.post<AdminDriver>(`/v1/admin/drivers/${id}/verify`),
    onSuccess: () => {
      invalidate();
      toast.push({ type: "success", message: "Driver verified" });
    },
    onError,
  });

  const block = useMutation({
    mutationFn: ({ id, body }: { id: string; body: BlockBody }) =>
      api.post<AdminDriver>(`/v1/admin/drivers/${id}/block`, body),
    onSuccess: (_res, vars) => {
      invalidate();
      toast.push({
        type: "success",
        message: vars.body.blocked ? "Driver blocked" : "Driver unblocked",
      });
      closeBlock();
    },
    onError,
  });

  function closeBlock() {
    setBlockTarget(null);
    setReason("");
  }

  return (
    <div>
      <PageHeader
        title="Drivers"
        subtitle="Fleet roster — verify onboarding and manage access."
        actions={query.isFetching ? <Spinner className="h-4 w-4 text-ink-400" /> : undefined}
      />

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : drivers.length === 0 ? (
        <EmptyState title="No drivers yet" hint="Drivers appear here once they onboard." />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Driver</Th>
              <Th>Phone</Th>
              <Th>Vehicle</Th>
              <Th>Verified</Th>
              <Th>Online</Th>
              <Th right>Wallet</Th>
              <Th right>Deliveries</Th>
              <Th right>Actions</Th>
            </Tr>
          </THead>
          <tbody>
            {drivers.map((d) => (
              <Tr key={d.id}>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink-900">{d.name ?? "—"}</span>
                    {d.isBlocked && <Badge tone="red">Blocked</Badge>}
                  </div>
                </Td>
                <Td className="text-ink-600">{d.phone}</Td>
                <Td className="text-ink-600">
                  <span className="capitalize">{d.vehicleType}</span>
                  {d.vehicleNo && <span className="text-ink-400"> · {d.vehicleNo}</span>}
                </Td>
                <Td>
                  <Badge tone={d.isVerified ? "green" : "neutral"}>
                    {d.isVerified ? "Verified" : "Unverified"}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={d.isOnline ? "green" : "neutral"}>
                    {d.isOnline ? "Online" : "Offline"}
                  </Badge>
                </Td>
                <Td right>{formatPaise(d.walletBalancePaise)}</Td>
                <Td right>{d.totalDeliveries}</Td>
                <Td right>
                  <div className="flex justify-end gap-2">
                    {!d.isVerified && (
                      <Button
                        className="px-2.5 py-1.5 text-xs"
                        loading={verify.isPending && verify.variables === d.id}
                        onClick={() => verify.mutate(d.id)}
                      >
                        Verify
                      </Button>
                    )}
                    {d.isBlocked ? (
                      <Button
                        variant="secondary"
                        className="px-2.5 py-1.5 text-xs"
                        loading={block.isPending && block.variables?.id === d.id}
                        onClick={() => block.mutate({ id: d.id, body: { blocked: false } })}
                      >
                        Unblock
                      </Button>
                    ) : (
                      <Button
                        variant="danger"
                        className="px-2.5 py-1.5 text-xs"
                        onClick={() => setBlockTarget(d)}
                      >
                        Block
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={blockTarget !== null}
        onClose={closeBlock}
        title={`Block ${blockTarget?.name ?? "driver"}?`}
        footer={
          <>
            <Button variant="secondary" onClick={closeBlock}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={block.isPending}
              onClick={() =>
                blockTarget &&
                block.mutate({
                  id: blockTarget.id,
                  body: { blocked: true, reason: reason.trim() || undefined },
                })
              }
            >
              Block driver
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-600">
          A blocked driver is rejected at login and receives no new offers.
        </p>
        <Field label="Reason" hint="Optional — recorded on the audit log.">
          <Textarea
            rows={3}
            placeholder="e.g. repeated cancellations"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Modal>
    </div>
  );
}
