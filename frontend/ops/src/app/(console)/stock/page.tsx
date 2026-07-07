"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LowStockItem,
  ManualAdjustReason,
  NearExpiryItem,
  OpsProduct,
  StockAdjustBody,
  StockAdjustResult,
} from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { Button, Card, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { Field, PageHeader, Select, Td, Textarea, TextInput, Th, THead, Tr } from "@/components/kit";
import { useToast } from "@/components/toast";

const REASONS = ["RETURN", "DAMAGE", "EXPIRY", "CORRECTION"] as const satisfies readonly ManualAdjustReason[];

const LOW_KEY = ["ops-stock-low"];
const NEAR_KEY = ["ops-stock-near-expiry"];

export default function StockPage() {
  const qc = useQueryClient();
  const toast = useToast();

  /* -------------------------------------------------------- adjust form */

  const [productId, setProductId] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState<ManualAdjustReason>("RETURN");
  const [note, setNote] = useState("");

  const productsQuery = useQuery({
    queryKey: ["ops-stock-products"],
    // limit is capped at 50 by the contract (CursorQuerySchema); a single dark
    // store's catalog fits well under that. (A typeahead is the >50 answer.)
    queryFn: () => api.get<OpsProduct[]>(`/v1/ops/products${qs({ limit: 50 })}`),
  });
  const products = productsQuery.data?.data ?? [];

  const adjust = useMutation({
    mutationFn: (body: StockAdjustBody) => api.post<StockAdjustResult>("/v1/ops/stock/adjust", body),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: LOW_KEY });
      void qc.invalidateQueries({ queryKey: NEAR_KEY });
      toast.push({ type: "success", message: `Stock adjusted — new qty ${res.data.stockQty}` });
      setDelta("");
      setNote("");
    },
    onError: (e) => toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" }),
  });

  const deltaNum = Number(delta);
  const canAdjust =
    productId !== "" && delta.trim() !== "" && Number.isInteger(deltaNum) && deltaNum !== 0 && !adjust.isPending;

  const submitAdjust = () => {
    if (!canAdjust) return;
    adjust.mutate({
      productId,
      delta: deltaNum,
      reason,
      note: note.trim() || undefined,
    });
  };

  /* ------------------------------------------------------------ low stock */

  const lowQuery = useQuery({
    queryKey: LOW_KEY,
    queryFn: () => api.get<LowStockItem[]>("/v1/ops/stock/low"),
  });
  const lowItems = lowQuery.data?.data ?? [];

  /* --------------------------------------------------------- near expiry */

  const [days, setDays] = useState("60");
  const daysNum = Number(days);
  const validDays =
    Number.isFinite(daysNum) && daysNum >= 1 ? Math.min(365, Math.trunc(daysNum)) : 60;

  const nearQuery = useQuery({
    queryKey: [...NEAR_KEY, validDays],
    queryFn: () => api.get<NearExpiryItem[]>(`/v1/ops/stock/near-expiry${qs({ days: validDays })}`),
  });
  const nearItems = nearQuery.data?.data ?? [];

  return (
    <div>
      <PageHeader title="Stock" subtitle="Adjust inventory and watch low-stock & expiry alerts." />

      <div className="space-y-5">
        {/* 1) Adjust stock */}
        <Card className="p-4">
          <div className="mb-3 text-sm font-medium text-ink-900">Adjust stock</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field
                label="Product"
                error={productsQuery.isError ? "Failed to load products" : undefined}
              >
                <Select
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  disabled={productsQuery.isLoading}
                >
                  <option value="">
                    {productsQuery.isLoading ? "Loading products…" : "Select a product"}
                  </option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Signed units" hint="Non-zero integer; negative removes stock.">
              <TextInput
                type="number"
                step="1"
                inputMode="numeric"
                placeholder="e.g. -5"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
              />
            </Field>

            <Field label="Reason">
              <Select value={reason} onChange={(e) => setReason(e.target.value as ManualAdjustReason)}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <Field label="Note (optional)">
                <Textarea
                  rows={2}
                  maxLength={500}
                  placeholder="Context for the audit trail"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <div className="mt-3 flex justify-end">
            <Button loading={adjust.isPending} disabled={!canAdjust} onClick={submitAdjust}>
              Apply adjustment
            </Button>
          </div>
        </Card>

        {/* 2) Low stock */}
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-medium text-ink-900">Low stock</span>
            {lowQuery.isFetching && <Spinner className="h-4 w-4 text-ink-400" />}
          </div>
          {lowQuery.isError ? (
            <div className="p-4">
              <ErrorState message={(lowQuery.error as Error).message} onRetry={() => lowQuery.refetch()} />
            </div>
          ) : lowQuery.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner className="h-6 w-6 text-primary-600" />
            </div>
          ) : lowItems.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No low-stock items" hint="Everything is above its threshold." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <THead>
                  <tr>
                    <Th>Product</Th>
                    <Th right>Stock</Th>
                    <Th right>Threshold</Th>
                    <Th>Bin</Th>
                  </tr>
                </THead>
                <tbody>
                  {lowItems.map((it) => (
                    <Tr key={it.productId}>
                      <Td className="font-medium text-ink-900">{it.name}</Td>
                      <Td right className="text-danger">
                        {it.stockQty}
                      </Td>
                      <Td right className="text-ink-600">
                        {it.lowStockThreshold}
                      </Td>
                      <Td className="text-ink-600">{it.binLocation || "—"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* 3) Near expiry */}
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-medium text-ink-900">Near expiry</span>
            <div className="flex items-center gap-2 text-sm text-ink-600">
              <span>Within</span>
              <TextInput
                type="number"
                min={1}
                max={365}
                step="1"
                inputMode="numeric"
                aria-label="Days to expiry window"
                className="w-20 py-1"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
              <span>days</span>
              {nearQuery.isFetching && <Spinner className="h-4 w-4 text-ink-400" />}
            </div>
          </div>
          {nearQuery.isError ? (
            <div className="p-4">
              <ErrorState message={(nearQuery.error as Error).message} onRetry={() => nearQuery.refetch()} />
            </div>
          ) : nearQuery.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner className="h-6 w-6 text-primary-600" />
            </div>
          ) : nearItems.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing expiring soon"
                hint={`No batches expiring within ${validDays} days.`}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <THead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Batch</Th>
                    <Th>Expiry</Th>
                    <Th right>Qty</Th>
                    <Th right>Days left</Th>
                  </tr>
                </THead>
                <tbody>
                  {nearItems.map((it) => {
                    const tone =
                      it.daysToExpiry < 30
                        ? "text-danger"
                        : it.daysToExpiry < 60
                          ? "text-warning"
                          : "text-ink-900";
                    return (
                      <Tr key={it.batchId}>
                        <Td className="font-medium text-ink-900">{it.productName}</Td>
                        <Td className="text-ink-600">{it.batchNo}</Td>
                        <Td className="text-ink-600 tabular-nums">{it.expiryDate}</Td>
                        <Td right className="text-ink-600">
                          {it.qtyAvailable}
                        </Td>
                        <Td right className={`font-medium ${tone}`}>
                          {it.daysToExpiry}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
