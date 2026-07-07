"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminSettings, AppFlags, StoreSettings, UpdateSettingsBody } from "@medrush/contracts";
import { api, ApiError } from "@/lib/api";
import { Button, Card, ErrorState, Spinner } from "@/components/ui";
import { PageHeader, Field, TextInput, Textarea } from "@/components/kit";
import { useToast } from "@/components/toast";

/**
 * Store configuration & feature flags (BLUEPRINT §7.2, ADMIN-only). One save
 * button PUTs the whole store object (partial allowed) plus the flags record.
 * Money is edited in rupees and sent as integer paise; `isOpen` is the §19
 * checkout kill switch.
 */

const QUERY_KEY = ["admin-settings"];

export default function AdminSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<AdminSettings>("/v1/admin/settings"),
  });

  const [form, setForm] = useState<StoreForm | null>(null);
  const [flags, setFlags] = useState<AppFlags | null>(null);

  // Seed the editable copy from the server on load and after each save (the
  // mutation invalidates → refetch → new data reference re-seeds the form).
  useEffect(() => {
    const d = query.data?.data;
    if (d) {
      setForm(storeToForm(d.store));
      setFlags(d.flags);
    }
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: UpdateSettingsBody) => api.put<AdminSettings>("/v1/admin/settings", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.push({ type: "success", message: "Settings saved" });
    },
    onError: (e) =>
      toast.push({ type: "error", message: e instanceof ApiError ? e.message : "Failed to save settings" }),
  });

  function setField<K extends keyof StoreForm>(key: K, value: StoreForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }
  function setFlag(key: string, value: boolean | number | string) {
    setFlags((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form || !flags) return;
    save.mutate({ store: formToStore(form), flags });
  }

  if (query.isError && !form) {
    return <ErrorState message={(query.error as Error).message} onRetry={() => query.refetch()} />;
  }
  if (!form || !flags) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <PageHeader
        title="Store settings"
        subtitle="Store profile, pricing, service area and feature flags."
        actions={
          <Button type="submit" loading={save.isPending}>
            Save changes
          </Button>
        }
      />

      <div className="space-y-5">
        <Section title="Availability" desc="The kill switch takes effect immediately.">
          <div className="flex items-center justify-between rounded-input border border-line bg-surface-2 px-3 py-2.5 sm:col-span-2">
            <div>
              <div className="text-sm font-medium text-ink-900">Store is open</div>
              <div className="text-xs text-ink-400">
                Turning this off instantly blocks new checkouts (§19 incident lever).
              </div>
            </div>
            <label className="inline-flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line accent-primary-600"
                checked={form.isOpen}
                onChange={(e) => setField("isOpen", e.target.checked)}
              />
              <span className={form.isOpen ? "text-success" : "text-danger"}>
                {form.isOpen ? "Open" : "Closed"}
              </span>
            </label>
          </div>
          <Field label="Opens at">
            <TextInput type="time" value={form.openTime} onChange={(e) => setField("openTime", e.target.value)} />
          </Field>
          <Field label="Closes at">
            <TextInput type="time" value={form.closeTime} onChange={(e) => setField("closeTime", e.target.value)} />
          </Field>
        </Section>

        <Section title="Store details">
          <Field label="Store name">
            <TextInput value={form.name} onChange={(e) => setField("name", e.target.value)} />
          </Field>
          <Field label="Support phone">
            <TextInput value={form.supportPhone} onChange={(e) => setField("supportPhone", e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address">
              <Textarea rows={2} value={form.address} onChange={(e) => setField("address", e.target.value)} />
            </Field>
          </div>
          <Field label="GSTIN">
            <TextInput value={form.gstin} onChange={(e) => setField("gstin", e.target.value)} />
          </Field>
          <Field label="FSSAI no.">
            <TextInput value={form.fssaiNo} onChange={(e) => setField("fssaiNo", e.target.value)} />
          </Field>
          <Field label="Drug licence no.">
            <TextInput value={form.drugLicenseNo} onChange={(e) => setField("drugLicenseNo", e.target.value)} />
          </Field>
          <Field label="Pharmacist name">
            <TextInput value={form.pharmacistName} onChange={(e) => setField("pharmacistName", e.target.value)} />
          </Field>
          <Field label="Pharmacist reg. no.">
            <TextInput value={form.pharmacistRegNo} onChange={(e) => setField("pharmacistRegNo", e.target.value)} />
          </Field>
        </Section>

        <Section title="Location & service area">
          <Field label="Latitude">
            <TextInput type="number" step="any" value={form.lat} onChange={(e) => setField("lat", e.target.value)} />
          </Field>
          <Field label="Longitude">
            <TextInput type="number" step="any" value={form.lng} onChange={(e) => setField("lng", e.target.value)} />
          </Field>
          <Field label="Service radius (m)">
            <TextInput
              type="number"
              step="1"
              min="0"
              value={form.serviceRadiusM}
              onChange={(e) => setField("serviceRadiusM", e.target.value)}
            />
          </Field>
        </Section>

        <Section title="Pricing & delivery" desc="Amounts in rupees; stored as paise.">
          <Field label="Minimum order (₹)">
            <MoneyInput value={form.minOrderRupees} onChange={(v) => setField("minOrderRupees", v)} />
          </Field>
          <Field label="Delivery base fee (₹)">
            <MoneyInput value={form.deliveryBaseRupees} onChange={(v) => setField("deliveryBaseRupees", v)} />
          </Field>
          <Field label="Free delivery above (₹)">
            <MoneyInput value={form.freeDeliveryAboveRupees} onChange={(v) => setField("freeDeliveryAboveRupees", v)} />
          </Field>
          <Field label="COD limit (₹)">
            <MoneyInput value={form.codLimitRupees} onChange={(v) => setField("codLimitRupees", v)} />
          </Field>
          <Field label="Commission base (₹)">
            <MoneyInput value={form.commissionBaseRupees} onChange={(v) => setField("commissionBaseRupees", v)} />
          </Field>
          <Field label="Commission per km (₹)">
            <MoneyInput value={form.commissionPerKmRupees} onChange={(v) => setField("commissionPerKmRupees", v)} />
          </Field>
        </Section>

        <Section title="App versions" desc="Minimum supported client versions (semver).">
          <Field label="Min driver app version">
            <TextInput
              value={form.minDriverAppVersion}
              onChange={(e) => setField("minDriverAppVersion", e.target.value)}
              placeholder="1.0.0"
            />
          </Field>
          <Field label="Min customer app version">
            <TextInput
              value={form.minCustomerAppVersion}
              onChange={(e) => setField("minCustomerAppVersion", e.target.value)}
              placeholder="1.0.0"
            />
          </Field>
        </Section>

        <Section title="Feature flags" desc="Runtime tunables — the control type follows each value.">
          {Object.keys(flags).length === 0 ? (
            <p className="text-sm text-ink-400 sm:col-span-2">No feature flags configured.</p>
          ) : (
            Object.entries(flags).map(([key, value]) => (
              <FlagField key={key} name={key} value={value} onChange={(v) => setFlag(key, v)} />
            ))
          )}
        </Section>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------- sub-views */

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <Card>
      <div className="border-b border-line px-4 py-2.5">
        <div className="text-sm font-medium text-ink-900">{title}</div>
        {desc && <div className="text-xs text-ink-400">{desc}</div>}
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-2">{children}</div>
    </Card>
  );
}

function MoneyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextInput
      type="number"
      step="0.01"
      min="0"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function FlagField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: boolean | number | string;
  onChange: (v: boolean | number | string) => void;
}) {
  if (typeof value === "boolean") {
    return (
      <label className="flex items-center justify-between gap-2 rounded-input border border-line px-3 py-2.5">
        <span className="break-all text-sm font-medium text-ink-900">{name}</span>
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-line accent-primary-600"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  }
  if (typeof value === "number") {
    return (
      <Field label={name}>
        <TextInput
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      </Field>
    );
  }
  return (
    <Field label={name}>
      <TextInput value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/* ------------------------------------------------- form <-> wire mapping */

/**
 * Editable mirror of {@link StoreSettings}: numeric/money fields are held as
 * input strings (rupees for money), nullable text is coalesced to "". Converted
 * back to the wire shape (integer paise, nulls) on save.
 */
interface StoreForm {
  name: string;
  address: string;
  drugLicenseNo: string;
  pharmacistName: string;
  pharmacistRegNo: string;
  gstin: string;
  fssaiNo: string;
  supportPhone: string;
  lat: string;
  lng: string;
  serviceRadiusM: string;
  isOpen: boolean;
  openTime: string;
  closeTime: string;
  minOrderRupees: string;
  deliveryBaseRupees: string;
  freeDeliveryAboveRupees: string;
  codLimitRupees: string;
  commissionBaseRupees: string;
  commissionPerKmRupees: string;
  minDriverAppVersion: string;
  minCustomerAppVersion: string;
}

const rupeeStr = (paise: number) => (paise / 100).toString();
const toPaise = (rupees: string) => Math.round((Number(rupees) || 0) * 100);
const toNum = (v: string) => Number(v) || 0;
const nullIfBlank = (v: string) => {
  const t = v.trim();
  return t === "" ? null : t;
};

function storeToForm(s: StoreSettings): StoreForm {
  return {
    name: s.name,
    address: s.address,
    drugLicenseNo: s.drugLicenseNo ?? "",
    pharmacistName: s.pharmacistName ?? "",
    pharmacistRegNo: s.pharmacistRegNo ?? "",
    gstin: s.gstin ?? "",
    fssaiNo: s.fssaiNo ?? "",
    supportPhone: s.supportPhone,
    lat: s.lat.toString(),
    lng: s.lng.toString(),
    serviceRadiusM: s.serviceRadiusM.toString(),
    isOpen: s.isOpen,
    openTime: s.openTime,
    closeTime: s.closeTime,
    minOrderRupees: rupeeStr(s.minOrderPaise),
    deliveryBaseRupees: rupeeStr(s.deliveryBasePaise),
    freeDeliveryAboveRupees: rupeeStr(s.freeDeliveryAbovePaise),
    codLimitRupees: rupeeStr(s.codLimitPaise),
    commissionBaseRupees: rupeeStr(s.commissionBasePaise),
    commissionPerKmRupees: rupeeStr(s.commissionPerKmPaise),
    minDriverAppVersion: s.minDriverAppVersion,
    minCustomerAppVersion: s.minCustomerAppVersion,
  };
}

function formToStore(f: StoreForm): StoreSettings {
  return {
    name: f.name.trim(),
    address: f.address.trim(),
    drugLicenseNo: nullIfBlank(f.drugLicenseNo),
    pharmacistName: nullIfBlank(f.pharmacistName),
    pharmacistRegNo: nullIfBlank(f.pharmacistRegNo),
    gstin: nullIfBlank(f.gstin),
    fssaiNo: nullIfBlank(f.fssaiNo),
    supportPhone: f.supportPhone.trim(),
    lat: toNum(f.lat),
    lng: toNum(f.lng),
    serviceRadiusM: Math.round(toNum(f.serviceRadiusM)),
    isOpen: f.isOpen,
    openTime: f.openTime,
    closeTime: f.closeTime,
    minOrderPaise: toPaise(f.minOrderRupees),
    deliveryBasePaise: toPaise(f.deliveryBaseRupees),
    freeDeliveryAbovePaise: toPaise(f.freeDeliveryAboveRupees),
    codLimitPaise: toPaise(f.codLimitRupees),
    commissionBasePaise: toPaise(f.commissionBaseRupees),
    commissionPerKmPaise: toPaise(f.commissionPerKmRupees),
    minDriverAppVersion: f.minDriverAppVersion.trim(),
    minCustomerAppVersion: f.minCustomerAppVersion.trim(),
  };
}
