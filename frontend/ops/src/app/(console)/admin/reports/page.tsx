"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GstReport, H1Register, SalesReport } from "@medrush/contracts";
import { api, ApiError, downloadFile, qs } from "@/lib/api";
import { formatPaise } from "@/lib/format";
import { Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Field, TextInput, Table, THead, Th, Tr, Td } from "@/components/kit";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/cn";

/**
 * Statutory / accounting registers (BLUEPRINT §7.2, ADMIN-only). Three report
 * kinds share one from/to calendar-date range (IST, inclusive). Each kind is
 * fetched only when its tab is active, and can also be exported as CSV via the
 * authenticated `format=csv` download.
 */

type TabKey = "sales" | "gst" | "h1";

const TAB_ORDER: TabKey[] = ["sales", "gst", "h1"];
/** `segment` is the URL path piece (and the CSV filename prefix). */
const TAB_META: Record<TabKey, { label: string; segment: string }> = {
  sales: { label: "Sales", segment: "sales" },
  gst: { label: "GST", segment: "gst" },
  h1: { label: "H1 register", segment: "h1-register" },
};

/** Local wall-clock date → `YYYY-MM-DD` (IST calendar) for a type=date input. */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

export default function AdminReportsPage() {
  const toast = useToast();

  const [tab, setTab] = useState<TabKey>("sales");
  const [from, setFrom] = useState(() => isoDay(daysAgo(30)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [downloading, setDownloading] = useState(false);

  const salesQ = useQuery({
    queryKey: ["report-sales", from, to],
    queryFn: () => api.get<SalesReport>(`/v1/admin/reports/sales${qs({ from, to })}`),
    enabled: tab === "sales" && !!from && !!to,
  });
  const gstQ = useQuery({
    queryKey: ["report-gst", from, to],
    queryFn: () => api.get<GstReport>(`/v1/admin/reports/gst${qs({ from, to })}`),
    enabled: tab === "gst" && !!from && !!to,
  });
  const h1Q = useQuery({
    queryKey: ["report-h1", from, to],
    queryFn: () => api.get<H1Register>(`/v1/admin/reports/h1-register${qs({ from, to })}`),
    enabled: tab === "h1" && !!from && !!to,
  });

  const meta = TAB_META[tab];
  const activeFetching =
    (tab === "sales" && salesQ.isFetching) ||
    (tab === "gst" && gstQ.isFetching) ||
    (tab === "h1" && h1Q.isFetching);

  async function download() {
    setDownloading(true);
    try {
      await downloadFile(
        `/v1/admin/reports/${meta.segment}${qs({ from, to, format: "csv" })}`,
        `${meta.segment}-${from}-${to}.csv`,
      );
    } catch (e) {
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Download failed" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Sales, GST and Schedule H1 registers."
        actions={
          <>
            {activeFetching && <Spinner className="h-4 w-4 text-ink-400" />}
            <Button
              variant="secondary"
              loading={downloading}
              disabled={!from || !to}
              onClick={download}
            >
              Download CSV
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex gap-1.5">
          {TAB_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                "rounded-pill border px-3 py-1 text-sm",
                tab === k
                  ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
                  : "border-line bg-surface text-ink-600 hover:bg-surface-2",
              )}
            >
              {TAB_META[k].label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-end gap-3">
          <div className="w-40">
            <Field label="From">
              <TextInput
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="To">
              <TextInput
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </div>

      {tab === "sales" && (
        <ReportSection<SalesReport> query={salesQ} isEmpty={(d) => d.rows.length === 0}>
          {(d) => <SalesTable data={d} />}
        </ReportSection>
      )}
      {tab === "gst" && (
        <ReportSection<GstReport> query={gstQ} isEmpty={(d) => d.rows.length === 0}>
          {(d) => <GstTable data={d} />}
        </ReportSection>
      )}
      {tab === "h1" && (
        <ReportSection<H1Register> query={h1Q} isEmpty={(d) => d.rows.length === 0}>
          {(d) => <H1Table data={d} />}
        </ReportSection>
      )}
    </div>
  );
}

/** Shared loading / error / empty wrapper around a report table. */
function ReportSection<T>({
  query,
  isEmpty,
  children,
}: {
  query: {
    isError: boolean;
    isLoading: boolean;
    error: unknown;
    data?: { data: T };
    refetch: () => void;
  };
  isEmpty: (d: T) => boolean;
  children: (d: T) => ReactNode;
}) {
  if (query.isError) {
    return (
      <ErrorState
        message={query.error instanceof Error ? query.error.message : "Failed to load report"}
        onRetry={() => query.refetch()}
      />
    );
  }
  if (query.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }
  const d = query.data?.data;
  if (!d || isEmpty(d)) {
    return <EmptyState title="No data" hint="No records for the selected date range." />;
  }
  return <>{children(d)}</>;
}

/* -------------------------------------------------------------- sales */

function SalesTable({ data }: { data: SalesReport }) {
  const { rows, totals } = data;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Date</Th>
          <Th right>Orders</Th>
          <Th right>Items</Th>
          <Th right>Delivery</Th>
          <Th right>Discount</Th>
          <Th right>Total</Th>
          <Th right>COD</Th>
          <Th right>Prepaid</Th>
        </tr>
      </THead>
      <tbody>
        {rows.map((r) => (
          <Tr key={r.date}>
            <Td className="whitespace-nowrap">{r.date}</Td>
            <Td right>{r.orders}</Td>
            <Td right>{formatPaise(r.itemsPaise)}</Td>
            <Td right>{formatPaise(r.deliveryPaise)}</Td>
            <Td right>{formatPaise(r.discountPaise)}</Td>
            <Td right>{formatPaise(r.totalPaise)}</Td>
            <Td right>{formatPaise(r.codPaise)}</Td>
            <Td right>{formatPaise(r.prepaidPaise)}</Td>
          </Tr>
        ))}
        <tr className="border-t-2 border-line bg-surface-2 font-semibold text-ink-900">
          <td className="px-4 py-2.5">Total</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{totals.orders}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.itemsPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.deliveryPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.discountPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.totalPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.codPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.prepaidPaise)}</td>
        </tr>
      </tbody>
    </Table>
  );
}

/* ---------------------------------------------------------------- gst */

function GstTable({ data }: { data: GstReport }) {
  const { rows, totals } = data;
  return (
    <Table>
      <THead>
        <tr>
          <Th>HSN</Th>
          <Th right>GST %</Th>
          <Th right>Taxable</Th>
          <Th right>CGST</Th>
          <Th right>SGST</Th>
          <Th right>Total</Th>
        </tr>
      </THead>
      <tbody>
        {rows.map((r, i) => (
          <Tr key={`${r.hsnCode ?? "na"}-${r.gstRatePct}-${i}`}>
            <Td className="whitespace-nowrap">{r.hsnCode ?? "—"}</Td>
            <Td right>{r.gstRatePct}%</Td>
            <Td right>{formatPaise(r.taxablePaise)}</Td>
            <Td right>{formatPaise(r.cgstPaise)}</Td>
            <Td right>{formatPaise(r.sgstPaise)}</Td>
            <Td right>{formatPaise(r.totalPaise)}</Td>
          </Tr>
        ))}
        <tr className="border-t-2 border-line bg-surface-2 font-semibold text-ink-900">
          <td className="px-4 py-2.5" colSpan={2}>
            Total
          </td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.taxablePaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.cgstPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.sgstPaise)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(totals.totalPaise)}</td>
        </tr>
      </tbody>
    </Table>
  );
}

/* ----------------------------------------------------------------- h1 */

function H1Table({ data }: { data: H1Register }) {
  return (
    <Table>
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Order</Th>
          <Th>Invoice</Th>
          <Th>Product</Th>
          <Th>Batch</Th>
          <Th right>Qty</Th>
          <Th>Patient</Th>
          <Th>Doctor</Th>
        </tr>
      </THead>
      <tbody>
        {data.rows.map((r, i) => (
          <Tr key={`${r.orderNo}-${r.batchNo}-${i}`}>
            <Td className="whitespace-nowrap">{r.date}</Td>
            <Td className="whitespace-nowrap font-medium text-ink-900">{r.orderNo}</Td>
            <Td className="whitespace-nowrap">{r.invoiceNo ?? "—"}</Td>
            <Td>{r.productName}</Td>
            <Td className="whitespace-nowrap">{r.batchNo}</Td>
            <Td right>{r.qty}</Td>
            <Td>{r.patientName ?? "—"}</Td>
            <Td>{r.doctorName ?? "—"}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
