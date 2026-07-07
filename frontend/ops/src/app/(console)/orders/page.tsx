"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { OpsOrderSummary, OrderStatus } from "@medrush/contracts";
import { api, qs } from "@/lib/api";
import { formatPaise, timeAgo } from "@/lib/format";
import { Card, EmptyState, ErrorState, OrderStatusBadge, RxBadge, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";

const FILTERS: { label: string; status?: OrderStatus }[] = [
  { label: "New", status: "PLACED" },
  { label: "Rx review", status: "RX_REVIEW" },
  { label: "Packing", status: "PACKING" },
  { label: "Ready", status: "READY" },
  { label: "All", status: undefined },
];

export default function OrdersBoard() {
  const [status, setStatus] = useState<OrderStatus | undefined>("PLACED");

  const query = useQuery({
    queryKey: ["ops-orders", status ?? "ALL"],
    queryFn: () => api.get<OpsOrderSummary[]>(`/v1/ops/orders${qs({ status, limit: 50 })}`),
    refetchInterval: 5_000, // live-ish board; socket push is a Phase-3 enhancement
  });

  const orders = query.data?.data ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink-900">Order board</h1>
        {query.isFetching && <Spinner className="h-4 w-4 text-ink-400" />}
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setStatus(f.status)}
            className={cn(
              "rounded-pill border px-3 py-1 text-sm",
              status === f.status
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
      ) : orders.length === 0 ? (
        <EmptyState title="No orders here" hint="New orders will appear automatically." />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 text-right font-medium">Items</th>
                <th className="px-4 py-2.5 text-right font-medium">Total</th>
                <th className="px-4 py-2.5 font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2.5">
                    <Link href={`/orders/${o.id}`} className="font-medium text-primary-700 hover:underline">
                      {o.orderNo}
                    </Link>
                    <div className="text-xs text-ink-400">
                      {o.paymentMethod === "PREPAID" ? "Prepaid" : "COD"}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <OrderStatusBadge status={o.status} />
                      <RxBadge status={o.rxStatus} />
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-ink-600">{o.customerName ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{o.itemCount}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(o.totalPaise)}</td>
                  <td className="px-4 py-2.5 text-ink-600">{timeAgo(o.placedAt ?? o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
