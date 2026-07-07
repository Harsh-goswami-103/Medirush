"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { OrderSummary } from "@medrush/contracts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
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

/** Order history — GET /v1/orders?limit=20. Auth-gated (redirects to /login). */
export default function OrdersPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const ordersQuery = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.get<OrderSummary[]>("/v1/orders?limit=20"),
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

  const orders = ordersQuery.data?.data ?? [];

  return (
    <div>
      <TopBar title="Your orders" />
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
              title="No orders yet"
              hint="Your orders will show up here once you place one."
            />
            <Link href="/" className="mt-4 block">
              <Button className="w-full">Browse products</Button>
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {orders.map((o) => (
              <li key={o.id}>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
