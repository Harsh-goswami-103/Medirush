"use client";

import type { ReactNode } from "react";
import { useStore } from "@/lib/store";
import { Card, ErrorState, Spinner } from "@/components/ui";

/**
 * Statutory identifiers for the pharmacy, sourced LIVE from GET /v1/store
 * (StoreInfo). Every field below is exposed by the public contract; a value
 * that the store config has not set yet (null) falls back to an operator
 * placeholder so it is obvious what still needs filling.
 */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
      <dt className="text-sm text-ink-600">{label}</dt>
      <dd className="max-w-[60%] text-right text-sm font-medium text-ink-900">
        {value ? value : <span className="font-normal text-warning">[OPERATOR: not set]</span>}
      </dd>
    </div>
  );
}

export function LicensingCard() {
  const { store, isLoading, error } = useStore();

  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="flex justify-center py-8">
        <Spinner className="h-5 w-5 text-primary-600" />
      </div>
    );
  } else if (error || !store) {
    body = <ErrorState message="Couldn’t load licensing details. Please try again." />;
  } else {
    body = (
      <dl>
        <Row label="Pharmacy" value={store.name} />
        <Row label="Registered address" value={store.address} />
        <Row label="Drug License No." value={store.drugLicenseNo} />
        <Row label="Pharmacist" value={store.pharmacistName} />
        <Row label="Pharmacist Reg. No." value={store.pharmacistRegNo} />
        <Row label="GSTIN" value={store.gstin} />
        <Row label="FSSAI No." value={store.fssaiNo} />
      </dl>
    );
  }

  return (
    <Card className="p-4">
      <h2 className="mb-2 text-sm font-semibold text-ink-900">Licensing & registration</h2>
      {body}
    </Card>
  );
}
