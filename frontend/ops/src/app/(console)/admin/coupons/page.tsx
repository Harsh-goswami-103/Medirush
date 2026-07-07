"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CouponKind, type Coupon, type CreateCouponBody } from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Field, Select, Table, THead, Th, Tr, Td, TextInput } from "@/components/kit";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

const KIND_TONE = {
  FLAT: "teal",
  PERCENT: "violet",
} as const satisfies Record<CouponKind, string>;

/** ISO UTC → `YYYY-MM-DDTHH:mm` in local wall-clock for a datetime-local input. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function AdminCouponsPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [active, setActive] = useState<"" | "true" | "false">("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Coupon | null>(null);

  const query = useQuery({
    queryKey: ["admin-coupons", active],
    queryFn: () => api.get<Coupon[]>(`/v1/admin/coupons${qs({ active, limit: 50 })}`),
  });
  const coupons = query.data?.data ?? [];

  const deactivateMut = useMutation({
    mutationFn: (id: string) => api.del(`/v1/admin/coupons/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-coupons"] });
      toast.push({ type: "success", message: "Coupon deactivated" });
    },
    onError: (e) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" }),
  });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (c: Coupon) => {
    setEditing(c);
    setFormOpen(true);
  };

  return (
    <div>
      <PageHeader
        title="Coupons"
        subtitle="Promo codes and their redemption windows."
        actions={
          <>
            {query.isFetching && <Spinner className="h-4 w-4 text-ink-400" />}
            <Select
              className="w-40"
              value={active}
              onChange={(e) => setActive(e.target.value as "" | "true" | "false")}
            >
              <option value="">All coupons</option>
              <option value="true">Active only</option>
              <option value="false">Inactive only</option>
            </Select>
            <Button onClick={openCreate}>New coupon</Button>
          </>
        }
      />

      {query.isError ? (
        <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      ) : coupons.length === 0 ? (
        <EmptyState title="No coupons yet" hint="Create one to start a promotion." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Code</Th>
              <Th>Kind</Th>
              <Th right>Value</Th>
              <Th right>Min order</Th>
              <Th>Window</Th>
              <Th>Status</Th>
              <Th right>Redemptions</Th>
              <Th>Actions</Th>
            </tr>
          </THead>
          <tbody>
            {coupons.map((c) => {
              const deactivating = deactivateMut.isPending && deactivateMut.variables === c.id;
              return (
                <Tr key={c.id}>
                  <Td className="font-medium text-ink-900">{c.code}</Td>
                  <Td>
                    <Badge tone={KIND_TONE[c.kind]}>{c.kind}</Badge>
                  </Td>
                  <Td right>
                    {c.kind === "FLAT" ? formatPaise(c.valuePaiseOrPct) : `${c.valuePaiseOrPct}%`}
                  </Td>
                  <Td right>{formatPaise(c.minOrderPaise)}</Td>
                  <Td className="whitespace-nowrap text-ink-600">
                    {formatDateTime(c.startsAt)} – {formatDateTime(c.endsAt)}
                  </Td>
                  <Td>
                    {c.isActive ? (
                      <Badge tone="green">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </Td>
                  <Td right>{c.redemptionCount}</Td>
                  <Td className="align-middle">
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" className="px-2.5 py-1" onClick={() => openEdit(c)}>
                        Edit
                      </Button>
                      {c.isActive && (
                        <Button
                          variant="ghost"
                          className="px-2.5 py-1 text-danger"
                          loading={deactivating}
                          onClick={() => deactivateMut.mutate(c.id)}
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

      {formOpen && (
        <CouponModal
          key={editing?.id ?? "new"}
          coupon={editing}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}

function CouponModal({ coupon, onClose }: { coupon: Coupon | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const [code, setCode] = useState(coupon?.code ?? "");
  const [kind, setKind] = useState<CouponKind>(coupon?.kind ?? "FLAT");
  const [value, setValue] = useState(
    coupon
      ? coupon.kind === "FLAT"
        ? (coupon.valuePaiseOrPct / 100).toString()
        : coupon.valuePaiseOrPct.toString()
      : "",
  );
  const [minOrder, setMinOrder] = useState(coupon ? (coupon.minOrderPaise / 100).toString() : "");
  const [maxDiscount, setMaxDiscount] = useState(
    coupon?.maxDiscountPaise != null ? (coupon.maxDiscountPaise / 100).toString() : "",
  );
  const [usageLimit, setUsageLimit] = useState(
    coupon?.usageLimit != null ? String(coupon.usageLimit) : "",
  );
  const [perUserLimit, setPerUserLimit] = useState(coupon ? String(coupon.perUserLimit) : "1");
  const [startsAt, setStartsAt] = useState(coupon ? toLocalInput(coupon.startsAt) : "");
  const [endsAt, setEndsAt] = useState(coupon ? toLocalInput(coupon.endsAt) : "");
  const [isActive, setIsActive] = useState(coupon?.isActive ?? true);

  const isFlat = kind === "FLAT";

  const saveMut = useMutation({
    mutationFn: (body: CreateCouponBody) =>
      coupon
        ? api.patch<Coupon>(`/v1/admin/coupons/${coupon.id}`, body)
        : api.post<Coupon>(`/v1/admin/coupons`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-coupons"] });
      toast.push({ type: "success", message: coupon ? "Coupon updated" : "Coupon created" });
      onClose();
    },
    onError: (e) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed" }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const body: CreateCouponBody = {
      code: code.trim().toUpperCase(),
      kind,
      // Dual meaning: FLAT is paise (rupees ×100), PERCENT is a 1–100 integer.
      valuePaiseOrPct: isFlat ? Math.round(Number(value) * 100) : Math.round(Number(value)),
      minOrderPaise: minOrder === "" ? 0 : Math.round(Number(minOrder) * 100),
      perUserLimit: perUserLimit === "" ? 1 : Math.round(Number(perUserLimit)),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      isActive,
      ...(maxDiscount !== "" ? { maxDiscountPaise: Math.round(Number(maxDiscount) * 100) } : {}),
      ...(usageLimit !== "" ? { usageLimit: Math.round(Number(usageLimit)) } : {}),
    };
    saveMut.mutate(body);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={coupon ? "Edit coupon" : "New coupon"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saveMut.isPending}>
            Cancel
          </Button>
          <Button form="coupon-form" type="submit" loading={saveMut.isPending}>
            {coupon ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <form id="coupon-form" onSubmit={onSubmit} className="space-y-3">
        <Field label="Code" hint="A–Z, digits, - or _ (3–32 chars).">
          <TextInput
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="MONSOON10"
            required
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as CouponKind);
                setValue("");
              }}
            >
              {Object.values(CouponKind).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={isFlat ? "Discount (₹)" : "Discount (%)"}
            hint={isFlat ? "Flat amount off." : "Percent off (1–100)."}
          >
            <TextInput
              type="number"
              step={isFlat ? "0.01" : "1"}
              min={isFlat ? "0" : "1"}
              max={isFlat ? undefined : "100"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Min order (₹)">
            <TextInput
              type="number"
              step="0.01"
              min="0"
              value={minOrder}
              onChange={(e) => setMinOrder(e.target.value)}
            />
          </Field>
          <Field label="Max discount (₹)" hint="Cap for percent coupons (optional).">
            <TextInput
              type="number"
              step="0.01"
              min="0"
              value={maxDiscount}
              onChange={(e) => setMaxDiscount(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Usage limit" hint="Global cap (optional).">
            <TextInput
              type="number"
              step="1"
              min="1"
              value={usageLimit}
              onChange={(e) => setUsageLimit(e.target.value)}
            />
          </Field>
          <Field label="Per-user limit">
            <TextInput
              type="number"
              step="1"
              min="1"
              value={perUserLimit}
              onChange={(e) => setPerUserLimit(e.target.value)}
              required
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts at">
            <TextInput
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
            />
          </Field>
          <Field label="Ends at">
            <TextInput
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-900">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line accent-primary-600"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Active
        </label>
      </form>
    </Modal>
  );
}
