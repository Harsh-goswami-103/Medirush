"use client";

import { useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { OpsAlert } from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { OPS_ALERTS_KEY, alertKindTone, refLinksToOrder } from "@/lib/alerts";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Table, THead, Th, Tr, Td } from "@/components/kit";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/cn";

/**
 * Ops alert inbox (Phase 7): durable OpsAlert rows so alerts raised while no
 * tab was open (e.g. the 02:30 IST drift audit) survive for morning review.
 * Newest first, unacked by default; ack is idempotent. The socket hook mounted
 * in AppShell invalidates the query live when a new alert lands.
 */

const FILTERS = [
  { label: "Outstanding", includeAcked: false },
  { label: "All alerts", includeAcked: true },
] as const;

export default function AlertsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [includeAcked, setIncludeAcked] = useState(false);

  const query = useInfiniteQuery({
    queryKey: [...OPS_ALERTS_KEY, "list", includeAcked ? "all" : "unacked"],
    queryFn: ({ pageParam }) =>
      api.get<OpsAlert[]>(
        `/v1/ops/alerts${qs({
          includeAcked: includeAcked ? "true" : undefined,
          cursor: pageParam,
          limit: 20,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
  });
  const alerts = query.data?.pages.flatMap((p) => p.data) ?? [];

  const ack = useMutation({
    mutationFn: (id: string) => api.post<OpsAlert>(`/v1/ops/alerts/${id}/ack`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: OPS_ALERTS_KEY });
      toast.push({ type: "success", message: "Alert acknowledged" });
    },
    onError: (e: unknown) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Ack failed" }),
  });

  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle="Durable ops alerts — every alert lands here until acknowledged."
        actions={
          query.isFetching && !query.isFetchingNextPage ? (
            <Spinner className="h-4 w-4 text-ink-400" />
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setIncludeAcked(f.includeAcked)}
            className={cn(
              "rounded-pill border px-3 py-1 text-sm",
              includeAcked === f.includeAcked
                ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
                : "border-line bg-surface text-ink-600 hover:bg-surface-2",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState
          title={includeAcked ? "No alerts yet" : "No outstanding alerts"}
          hint={
            includeAcked
              ? "Watchdog and audit alerts will show up here."
              : "All clear — acknowledged alerts are under “All alerts”."
          }
        />
      ) : (
        <>
          <Table>
            <THead>
              <Tr>
                <Th>Alert</Th>
                <Th>Reference</Th>
                <Th>Raised</Th>
                <Th right>Status</Th>
              </Tr>
            </THead>
            <tbody>
              {alerts.map((a) => (
                <Tr key={a.id}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={alertKindTone(a.kind)}>{a.kind.replace(/_/g, " ")}</Badge>
                    </div>
                    <div className="mt-1 max-w-xl text-sm text-ink-900">{a.message}</div>
                  </Td>
                  <Td>
                    {a.refId === null ? (
                      <span className="text-ink-400">—</span>
                    ) : refLinksToOrder(a) ? (
                      <Link
                        href={`/orders/${a.refId}`}
                        className="text-sm font-medium text-primary-700 hover:underline"
                      >
                        View order
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-ink-600">{a.refId}</span>
                    )}
                  </Td>
                  <Td className="text-ink-600">
                    <div>{timeAgo(a.createdAt)}</div>
                    <div className="text-xs text-ink-400">{formatDateTime(a.createdAt)}</div>
                  </Td>
                  <Td right>
                    {a.acknowledgedAt ? (
                      <span className="text-xs text-ink-400">
                        Acked {formatDateTime(a.acknowledgedAt)}
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        className="px-2.5 py-1.5 text-xs"
                        loading={ack.isPending && ack.variables === a.id}
                        onClick={() => ack.mutate(a.id)}
                      >
                        Ack
                      </Button>
                    )}
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
    </div>
  );
}
