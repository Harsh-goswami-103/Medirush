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
import { Reveal } from "@/components/motion";
import {
  Button,
  EmptyState,
  ErrorState,
  OrderStatusBadge,
  RxBadge,
  Skeleton,
  Spinner,
} from "@/components/ui";

/** History filter tabs — the API takes a single `status`, so tabs map 1:1. */
const TABS: { label: string; status?: OrderStatus }[] = [
  { label: "All" },
  { label: "Delivered", status: "DELIVERED" },
  { label: "Cancelled", status: "CANCELLED" },
];

/** Statuses whose live-tracking screen is worth a one-tap shortcut from the list. */
const TRACKABLE: OrderStatus[] = ["PACKING", "READY", "ASSIGNED", "PICKED_UP"];

/** Left edge accent — reads the order's state before any text is parsed. */
const ACCENT: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "bg-warning",
  PLACED: "bg-gradient-to-b from-primary-500 to-primary-700",
  RX_REVIEW: "bg-rx",
  PACKING: "bg-gradient-to-b from-primary-500 to-primary-700",
  READY: "bg-gradient-to-b from-primary-500 to-primary-700",
  ASSIGNED: "bg-gradient-to-b from-primary-500 to-primary-700",
  PICKED_UP: "bg-gradient-to-b from-primary-500 to-primary-700",
  DELIVERED: "bg-success",
  CANCELLED: "bg-danger",
};

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
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const orders = ordersQuery.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar title="Your orders" />

      {/* Status filter — segmented control on a frosted rail. */}
      <div className="px-4 pt-4">
        <div
          role="group"
          aria-label="Filter orders by status"
          className="no-scrollbar flex gap-1 overflow-x-auto rounded-pill glass p-1 shadow-glass"
        >
          {TABS.map((t, i) => (
            <button
              key={t.label}
              type="button"
              aria-pressed={i === tab}
              onClick={() => setTab(i)}
              className={cn(
                "press min-h-[40px] flex-1 whitespace-nowrap rounded-pill px-4 text-sm font-semibold transition-colors",
                i === tab
                  ? "bg-gradient-to-r from-primary-700 to-primary-600 text-white shadow-glow"
                  : "text-ink-600 hover:bg-white/70 hover:text-primary-700",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {ordersQuery.isError ? (
          <ErrorState
            message={(ordersQuery.error as Error).message}
            onRetry={() => ordersQuery.refetch()}
          />
        ) : ordersQuery.isLoading ? (
          <OrderListSkeleton />
        ) : orders.length === 0 ? (
          <EmptyState
            icon={<BagIcon />}
            title={status ? `No ${status.toLowerCase()} orders` : "No orders yet"}
            hint="Your orders will show up here once you place one."
            action={
              <Link href="/shop" className="block">
                <Button className="press w-full bg-gradient-to-r from-primary-700 to-primary-600 shadow-glow">
                  Browse products
                </Button>
              </Link>
            }
          />
        ) : (
          <ul className="space-y-3">
            {orders.map((o, i) => {
              const repeatable = o.status === "DELIVERED" || o.status === "CANCELLED";
              const trackable = TRACKABLE.includes(o.status);
              return (
                <Reveal as="li" key={o.id} delayMs={Math.min(i, 6) * 45}>
                  <article className="relative overflow-hidden rounded-xl2 border border-line/70 bg-surface shadow-card2">
                    <span
                      className={cn("absolute inset-y-0 left-0 w-1.5", ACCENT[o.status])}
                      aria-hidden
                    />
                    <Link href={`/orders/${o.id}`} className="press block py-4 pl-5 pr-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold tracking-tight text-ink-900">
                          {o.orderNo}
                        </span>
                        <svg
                          viewBox="0 0 24 24"
                          className="h-4 w-4 shrink-0 text-ink-400"
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
                      <div className="mt-3 flex items-end justify-between gap-3">
                        <span className="text-xs leading-relaxed text-ink-600">
                          {o.itemCount} item{o.itemCount === 1 ? "" : "s"}
                          <br />
                          {formatDateTime(o.deliveredAt ?? o.createdAt)}
                        </span>
                        <span className="text-lg font-bold tabular-nums tracking-tight text-ink-900">
                          {formatPaise(o.totalPaise)}
                        </span>
                      </div>
                    </Link>

                    {(repeatable || trackable) && (
                      <div className="flex gap-2 border-t border-line/70 bg-surface-2/60 px-4 py-2.5 pl-5">
                        {trackable && (
                          <Link
                            href={`/orders/${o.id}/track`}
                            className="press inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-pill bg-gradient-to-r from-primary-700 to-primary-600 px-3 text-sm font-semibold text-white shadow-glow"
                          >
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
                            Track order
                          </Link>
                        )}
                        {repeatable && (
                          <button
                            type="button"
                            className="press inline-flex min-h-[40px] flex-1 items-center justify-center rounded-pill border border-primary-600/40 bg-primary-50 px-3 text-sm font-semibold text-primary-800 disabled:opacity-60"
                            disabled={reorderingId === o.id}
                            onClick={() => reorder.mutate({ orderId: o.id })}
                          >
                            {reorderingId === o.id ? "Adding…" : "Order again"}
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                </Reveal>
              );
            })}

            {ordersQuery.hasNextPage && (
              <li className="pt-1">
                <Button
                  variant="secondary"
                  className="press w-full rounded-pill border-line/70 shadow-sm"
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

/* --------------------------------------------------------------- helpers */

/** Shaped placeholders (§20.4 — skeletons, never a bare spinner, for list loads). */
function OrderListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <ul className="space-y-3" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="overflow-hidden rounded-xl2 border border-line/70 bg-surface p-4 shadow-card2"
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-4 rounded-full" />
          </div>
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-5 w-20 rounded-pill" />
            <Skeleton className="h-5 w-14 rounded-pill" />
          </div>
          <div className="mt-4 flex items-end justify-between">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-6 w-20" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function BagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 3h10l2 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V7z" />
      <path d="M5 7h14M9 12h6M9 16h6" />
    </svg>
  );
}
