"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { OrderStatus, OrderSummary } from "@medrush/contracts";
import { api, qs } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useReorder } from "@/lib/reorder";
import { formatDateTime, formatPaise } from "@/lib/format";
import { TopBar } from "@/components/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  OrderStatusBadge,
  RxBadge,
  Spinner,
} from "@/components/ui";

/** History filter tabs — the API takes a single `status`, so tabs map 1:1. */
const TABS: { label: string; status?: OrderStatus }[] = [
  { label: "All" },
  { label: "Delivered", status: "DELIVERED" },
  { label: "Cancelled", status: "CANCELLED" },
];

/** Order history — GET /v1/orders?status&cursor&limit. Auth-gated (redirects to /login). */
export default function OrdersPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const reorder = useReorder();
  const [tab, setTab] = useState(0);
  const status = TABS[tab]?.status;
  const reorderingId =
    reorder.isPending && reorder.variables && "orderId" in reorder.variables
      ? reorder.variables.orderId
      : null;

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // Cursor-paginated (the old fetch showed only the first 20, ignoring
  // `meta.nextCursor`); status tabs re-key the query for a server-side filter.
  const ordersQuery = useInfiniteQuery({
    queryKey: ["orders", status ?? "all"],
    queryFn: ({ pageParam }) =>
      api.get<OrderSummary[]>(`/v1/orders${qs({ status, cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
    enabled: Boolean(user),
  });

  // Auth still resolving, or redirecting an anonymous visitor away.
  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const orders = ordersQuery.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div>
      <TopBar title="Your orders" />

      {/* Status tabs */}
      <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pt-3">
        {TABS.map((t, i) => (
          <button
            key={t.label}
            type="button"
            onClick={() => setTab(i)}
            className={cn(
              "whitespace-nowrap rounded-pill border px-3 py-1 text-sm",
              i === tab
                ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
                : "border-line bg-surface text-ink-600",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {ordersQuery.isError ? (
          <ErrorState
            message={(ordersQuery.error as Error).message}
            onRetry={() => ordersQuery.refetch()}
          />
        ) : ordersQuery.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6 text-primary-600" />
          </div>
        ) : orders.length === 0 ? (
          <div>
            <EmptyState
              title={status ? `No ${status.toLowerCase()} orders` : "No orders yet"}
              hint="Your orders will show up here once you place one."
            />
            <Link href="/" className="mt-4 block">
              <Button className="w-full">Browse products</Button>
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {orders.map((o) => (
              <li key={o.id} className="space-y-2">
                <Link href={`/orders/${o.id}`} className="block">
                  <Card className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink-900">{o.orderNo}</span>
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4 text-ink-400"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <OrderStatusBadge status={o.status} />
                      <RxBadge status={o.rxStatus} />
                    </div>
                    <div className="mt-3 flex items-end justify-between gap-2">
                      <span className="text-xs text-ink-600">
                        {o.itemCount} item{o.itemCount === 1 ? "" : "s"} ·{" "}
                        {formatDateTime(o.createdAt)}
                      </span>
                      <span className="font-semibold tabular-nums text-ink-900">
                        {formatPaise(o.totalPaise)}
                      </span>
                    </div>
                  </Card>
                </Link>
                {(o.status === "DELIVERED" || o.status === "CANCELLED") && (
                  <button
                    type="button"
                    className="w-full rounded-input border border-primary-600 px-3 py-1.5 text-sm font-medium text-primary-700 disabled:opacity-60"
                    disabled={reorderingId === o.id}
                    onClick={() => reorder.mutate({ orderId: o.id })}
                  >
                    {reorderingId === o.id ? "Adding…" : "Order again"}
                  </button>
                )}
              </li>
            ))}
            {ordersQuery.hasNextPage && (
              <li>
                <Button
                  variant="secondary"
                  className="w-full"
                  loading={ordersQuery.isFetchingNextPage}
                  onClick={() => void ordersQuery.fetchNextPage()}
                >
                  Load more
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
