"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateBatchBody,
  CreateProductBody,
  GstRate,
  OpsCategory,
  OpsProduct,
  ScheduleClass,
} from "@medrush/contracts";
import { ApiError, api, qs } from "@/lib/api";
import { formatPaise } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import {
  Field,
  PageHeader,
  Select,
  Table,
  Td,
  Textarea,
  TextInput,
  THead,
  Th,
  Tr,
} from "@/components/kit";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

const PRODUCTS_KEY = "ops-products";
const GST_RATES: GstRate[] = [0, 5, 12, 18];
const SCHEDULE_CLASSES: ScheduleClass[] = ["NONE", "OTC", "H", "H1"];
type ActiveFilter = "all" | "active" | "inactive";

/** Debounce a changing value so the list query does not refire on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export default function ProductsPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [active, setActive] = useState<ActiveFilter>("all");
  const debouncedSearch = useDebounced(search, 300);

  const [productModal, setProductModal] = useState<{ product: OpsProduct | null } | null>(null);
  const [batchProduct, setBatchProduct] = useState<OpsProduct | null>(null);
  const [deactivating, setDeactivating] = useState<OpsProduct | null>(null);

  const categoriesQuery = useQuery({
    queryKey: ["ops-categories"],
    queryFn: () => api.get<OpsCategory[]>("/v1/ops/categories"),
  });
  const categories = categoriesQuery.data?.data ?? [];

  const query = useQuery({
    queryKey: [PRODUCTS_KEY, debouncedSearch, category, active],
    queryFn: () =>
      api.get<OpsProduct[]>(
        `/v1/ops/products${qs({
          search: debouncedSearch || undefined,
          category: category || undefined,
          isActive: active === "all" ? undefined : active === "active",
          limit: 50,
        })}`,
      ),
  });
  const products = query.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle="Catalogue, pricing and stock"
        actions={
          <>
            {query.isFetching && <Spinner className="h-4 w-4 text-ink-400" />}
            <Button onClick={() => setProductModal({ product: null })}>New product</Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TextInput
          className="w-64"
          placeholder="Search name or composition…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-48" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          className="w-40"
          value={active}
          onChange={(e) => setActive(e.target.value as ActiveFilter)}
        >
          <option value="all">All</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
        </Select>
      </div>

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : products.length === 0 ? (
        <EmptyState title="No products found" hint="Adjust your filters or add a new product." />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>Product</Th>
              <Th>Category</Th>
              <Th right>Price / MRP</Th>
              <Th right>Stock</Th>
              <Th>Rx</Th>
              <Th>Active</Th>
              <Th right>Actions</Th>
            </Tr>
          </THead>
          <tbody>
            {products.map((p) => {
              const categoryName = categories.find((c) => c.id === p.categoryId)?.name ?? "—";
              const low = p.stockQty <= p.lowStockThreshold;
              return (
                <Tr key={p.id}>
                  <Td>
                    <button
                      onClick={() => setProductModal({ product: p })}
                      className="text-left font-medium text-primary-700 hover:underline"
                    >
                      {p.name}
                    </button>
                    {p.brand && <div className="text-xs text-ink-400">{p.brand}</div>}
                    <div className="text-xs text-ink-400">{p.packSize}</div>
                  </Td>
                  <Td className="text-ink-600">{categoryName}</Td>
                  <Td right>
                    <div className="font-medium text-ink-900">{formatPaise(p.pricePaise)}</div>
                    {p.pricePaise < p.mrpPaise && (
                      <div className="text-xs text-ink-400 line-through">{formatPaise(p.mrpPaise)}</div>
                    )}
                  </Td>
                  <Td right>
                    <span className={low ? "font-medium text-warning" : "text-ink-900"}>
                      {p.stockQty}
                    </span>
                  </Td>
                  <Td>{p.requiresRx ? <Badge tone="violet">Rx</Badge> : <span className="text-ink-400">—</span>}</Td>
                  <Td>
                    {p.isActive ? <Badge tone="green">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
                  </Td>
                  <Td right>
                    <div className="flex justify-end gap-1">
                      <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setBatchProduct(p)}>
                        Add batch
                      </Button>
                      {p.isActive && (
                        <Button
                          variant="ghost"
                          className="px-2.5 py-1 text-xs text-danger"
                          onClick={() => setDeactivating(p)}
                        >
                          Deactivate
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {productModal && (
        <ProductModal
          product={productModal.product}
          categories={categories}
          onClose={() => setProductModal(null)}
        />
      )}
      {batchProduct && <BatchModal product={batchProduct} onClose={() => setBatchProduct(null)} />}
      {deactivating && (
        <DeactivateModal product={deactivating} onClose={() => setDeactivating(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- product form */

interface ProductFormState {
  name: string;
  categoryId: string;
  brand: string;
  mrpRupees: string;
  priceRupees: string;
  gstRatePct: string;
  hsnCode: string;
  packSize: string;
  composition: string;
  binLocation: string;
  requiresRx: boolean;
  scheduleClass: ScheduleClass;
  images: string;
  lowStockThreshold: string;
  maxPerOrder: string;
  isActive: boolean;
}

function initProductForm(p: OpsProduct | null): ProductFormState {
  return {
    name: p?.name ?? "",
    categoryId: p?.categoryId ?? "",
    brand: p?.brand ?? "",
    mrpRupees: p ? String(p.mrpPaise / 100) : "",
    priceRupees: p ? String(p.pricePaise / 100) : "",
    gstRatePct: p ? String(p.gstRatePct) : "12",
    hsnCode: p?.hsnCode ?? "",
    packSize: p?.packSize ?? "",
    composition: p?.composition ?? "",
    binLocation: p?.binLocation ?? "",
    requiresRx: p?.requiresRx ?? false,
    scheduleClass: p?.scheduleClass ?? "NONE",
    images: p ? p.images.join(", ") : "",
    lowStockThreshold: p ? String(p.lowStockThreshold) : "",
    maxPerOrder: p ? String(p.maxPerOrder) : "",
    isActive: p?.isActive ?? true,
  };
}

function buildProductBody(f: ProductFormState): CreateProductBody {
  const images = f.images
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: f.name.trim(),
    categoryId: f.categoryId,
    brand: f.brand.trim() || undefined,
    mrpPaise: Math.round(Number(f.mrpRupees) * 100),
    pricePaise: Math.round(Number(f.priceRupees) * 100),
    gstRatePct: Number(f.gstRatePct) as GstRate,
    hsnCode: f.hsnCode.trim() || undefined,
    packSize: f.packSize.trim(),
    composition: f.composition.trim() || undefined,
    binLocation: f.binLocation.trim() || undefined,
    requiresRx: f.requiresRx,
    scheduleClass: f.scheduleClass,
    // Always send the array so blanking the field on edit actually clears images
    // (an omitted field would leave the server value unchanged).
    images,
    lowStockThreshold: f.lowStockThreshold.trim() !== "" ? Number(f.lowStockThreshold) : undefined,
    maxPerOrder: f.maxPerOrder.trim() !== "" ? Number(f.maxPerOrder) : undefined,
    // Lets an edit reactivate a deactivated product (UpdateProductBody accepts it).
    isActive: f.isActive,
  };
}

function ProductModal({
  product,
  categories,
  onClose,
}: {
  product: OpsProduct | null;
  categories: OpsCategory[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<ProductFormState>(() => initProductForm(product));
  const set = (patch: Partial<ProductFormState>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: (body: CreateProductBody) =>
      product
        ? api.patch<OpsProduct>(`/v1/ops/products/${product.id}`, body)
        : api.post<OpsProduct>("/v1/ops/products", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [PRODUCTS_KEY] });
      toast.push({ type: "success", message: product ? "Product updated" : "Product created" });
      onClose();
    },
    onError: (e) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" }),
  });

  const canSubmit =
    form.name.trim() !== "" &&
    form.categoryId !== "" &&
    form.mrpRupees.trim() !== "" &&
    form.priceRupees.trim() !== "" &&
    form.packSize.trim() !== "";

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? `Edit ${product.name}` : "New product"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!canSubmit}
            onClick={() => save.mutate(buildProductBody(form))}
          >
            {product ? "Save changes" : "Create product"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
              <option value="" disabled>
                Select category…
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Brand">
            <TextInput value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
          </Field>

          <Field label="MRP (₹)">
            <TextInput
              type="number"
              step="0.01"
              min="0"
              value={form.mrpRupees}
              onChange={(e) => set({ mrpRupees: e.target.value })}
            />
          </Field>
          <Field label="Selling price (₹)" hint="Must be ≤ MRP">
            <TextInput
              type="number"
              step="0.01"
              min="0"
              value={form.priceRupees}
              onChange={(e) => set({ priceRupees: e.target.value })}
            />
          </Field>

          <Field label="GST %">
            <Select value={form.gstRatePct} onChange={(e) => set({ gstRatePct: e.target.value })}>
              {GST_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pack size" hint="e.g. 10 tablets">
            <TextInput value={form.packSize} onChange={(e) => set({ packSize: e.target.value })} />
          </Field>

          <Field label="HSN code">
            <TextInput value={form.hsnCode} onChange={(e) => set({ hsnCode: e.target.value })} />
          </Field>
          <Field label="Bin location" hint="e.g. R2-S3">
            <TextInput
              value={form.binLocation}
              onChange={(e) => set({ binLocation: e.target.value })}
            />
          </Field>

          <Field label="Schedule class">
            <Select
              value={form.scheduleClass}
              onChange={(e) => set({ scheduleClass: e.target.value as ScheduleClass })}
            >
              {SCHEDULE_CLASSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Max per order">
            <TextInput
              type="number"
              min="1"
              value={form.maxPerOrder}
              onChange={(e) => set({ maxPerOrder: e.target.value })}
            />
          </Field>

          <Field label="Low-stock threshold">
            <TextInput
              type="number"
              min="0"
              value={form.lowStockThreshold}
              onChange={(e) => set({ lowStockThreshold: e.target.value })}
            />
          </Field>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-ink-900">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line accent-primary-600"
                checked={form.requiresRx}
                onChange={(e) => set({ requiresRx: e.target.checked })}
              />
              Requires prescription
            </label>
          </div>
          {product && (
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-ink-900">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-line accent-primary-600"
                  checked={form.isActive}
                  onChange={(e) => set({ isActive: e.target.checked })}
                />
                Active {!form.isActive && <span className="text-ink-400">(deactivated)</span>}
              </label>
            </div>
          )}
        </div>

        <Field label="Composition">
          <Textarea
            rows={2}
            value={form.composition}
            onChange={(e) => set({ composition: e.target.value })}
          />
        </Field>
        <Field label="Images" hint="Comma-separated image URLs">
          <Textarea rows={2} value={form.images} onChange={(e) => set({ images: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- GRN batch */

interface BatchFormState {
  batchNo: string;
  expiryDate: string;
  qtyReceived: string;
  costRupees: string;
  wholesaler: string;
  invoiceNo: string;
}

function BatchModal({ product, onClose }: { product: OpsProduct; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<BatchFormState>({
    batchNo: "",
    expiryDate: "",
    qtyReceived: "",
    costRupees: "",
    wholesaler: "",
    invoiceNo: "",
  });
  const set = (patch: Partial<BatchFormState>) => setForm((f) => ({ ...f, ...patch }));

  const create = useMutation({
    mutationFn: (body: CreateBatchBody) =>
      api.post(`/v1/ops/products/${product.id}/batches`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [PRODUCTS_KEY] });
      toast.push({ type: "success", message: "Batch received" });
      onClose();
    },
    onError: (e) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" }),
  });

  const canSubmit =
    form.batchNo.trim() !== "" &&
    form.expiryDate !== "" &&
    form.qtyReceived.trim() !== "" &&
    form.costRupees.trim() !== "" &&
    form.wholesaler.trim() !== "" &&
    form.invoiceNo.trim() !== "";

  const submit = () =>
    create.mutate({
      batchNo: form.batchNo.trim(),
      expiryDate: form.expiryDate,
      qtyReceived: Number(form.qtyReceived),
      costPaise: Math.round(Number(form.costRupees) * 100),
      wholesaler: form.wholesaler.trim(),
      invoiceNo: form.invoiceNo.trim(),
    });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add batch — ${product.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!canSubmit} onClick={submit}>
            Receive batch
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Batch no.">
          <TextInput value={form.batchNo} onChange={(e) => set({ batchNo: e.target.value })} />
        </Field>
        <Field label="Expiry date">
          <TextInput
            type="date"
            value={form.expiryDate}
            onChange={(e) => set({ expiryDate: e.target.value })}
          />
        </Field>
        <Field label="Quantity received">
          <TextInput
            type="number"
            min="1"
            value={form.qtyReceived}
            onChange={(e) => set({ qtyReceived: e.target.value })}
          />
        </Field>
        <Field label="Cost / unit (₹)">
          <TextInput
            type="number"
            step="0.01"
            min="0"
            value={form.costRupees}
            onChange={(e) => set({ costRupees: e.target.value })}
          />
        </Field>
        <Field label="Wholesaler">
          <TextInput
            value={form.wholesaler}
            onChange={(e) => set({ wholesaler: e.target.value })}
          />
        </Field>
        <Field label="Invoice no.">
          <TextInput value={form.invoiceNo} onChange={(e) => set({ invoiceNo: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- deactivate */

function DeactivateModal({ product, onClose }: { product: OpsProduct; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const deactivate = useMutation({
    mutationFn: () => api.del<{ ok: boolean }>(`/v1/ops/products/${product.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [PRODUCTS_KEY] });
      toast.push({ type: "success", message: "Product deactivated" });
      onClose();
    },
    onError: (e) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Deactivate product"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep active
          </Button>
          <Button variant="danger" loading={deactivate.isPending} onClick={() => deactivate.mutate()}>
            Deactivate
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-600">
        Deactivate <span className="font-medium text-ink-900">{product.name}</span>? It will be
        hidden from the customer catalogue. Existing order history is preserved and you can
        reactivate it later by editing the product.
      </p>
    </Modal>
  );
}
