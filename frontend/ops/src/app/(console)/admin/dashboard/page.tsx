"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DashboardKpis } from "@medrush/contracts";
import { api, qs } from "@/lib/api";
import { formatPaise } from "@/lib/format";
import { ErrorState, Spinner } from "@/components/ui";
import { PageHeader, StatCard } from "@/components/kit";
import { cn } from "@/lib/cn";

type Range = DashboardKpis["range"];

const RANGES: { label: string; value: Range }[] = [
  { label: "Today", value: "today" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
];

export default function AdminDashboardPage() {
  const [range, setRange] = useState<Range>("today");

  const query = useQuery({
    queryKey: ["admin-dashboard", range],
    queryFn: () => api.get<DashboardKpis>(`/v1/admin/dashboard${qs({ range })}`),
  });

  const kpis = query.data?.data;

  const rangeToggle = (
    <div className="flex gap-0.5 rounded-pill border border-line bg-surface p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.value}
          onClick={() => setRange(r.value)}
          className={cn(
            "rounded-pill px-3 py-1 text-sm",
            range === r.value
              ? "bg-primary-600/10 font-medium text-primary-700"
              : "text-ink-600 hover:bg-surface-2",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader title="Dashboard" actions={rangeToggle} />

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading || !kpis ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          <StatCard label="Orders placed" value={kpis.ordersPlaced} />
          <StatCard label="Delivered" value={kpis.ordersDelivered} />
          <StatCard label="Cancelled" value={kpis.ordersCancelled} />
          <StatCard label="Revenue" value={formatPaise(kpis.revenuePaise)} />
          <StatCard label="Avg order value" value={formatPaise(kpis.aovPaise)} />
          <StatCard
            label="On-time %"
            value={`${kpis.onTimePct}%`}
            tone={kpis.onTimePct >= 90 ? "good" : kpis.onTimePct >= 75 ? "warning" : "danger"}
          />
          <StatCard label="Active drivers" value={kpis.activeDrivers} />
          <StatCard
            label="Low stock"
            value={kpis.lowStockCount}
            tone={kpis.lowStockCount > 0 ? "warning" : "default"}
          />
          <StatCard label="COD due" value={formatPaise(kpis.codDuePaise)} />
        </div>
      )}
    </div>
  );
}
