"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/lib/store";
import { ErrorState, Skeleton } from "@/components/ui";
import { Container, Eyebrow } from "./primitives";
import { IconArrowRight, IconShieldCheck } from "./icons";

function Row({
  label,
  value,
  isLoading,
}: {
  label: string;
  value: string | null | undefined;
  isLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line/80 py-3.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="text-sm text-ink-600">{label}</dt>
      <dd className="text-sm font-semibold text-ink-900 sm:max-w-[62%] sm:text-right">
        {isLoading ? (
          <Skeleton className="h-4 w-40 sm:ml-auto" />
        ) : value ? (
          <span className="break-words tabular-nums">{value}</span>
        ) : (
          <span className="font-normal text-ink-400">Not published</span>
        )}
      </dd>
    </div>
  );
}

/**
 * Statutory identifiers, read LIVE from GET /v1/store. A pharmacy is legally
 * required to display these (§10.2), so a value the store config has not set
 * reads as "Not published" rather than being quietly dropped.
 */
export function Compliance() {
  const qc = useQueryClient();
  const { store, isLoading, error } = useStore();

  return (
    <section
      id="licensing"
      aria-labelledby="licensing-title"
      className="scroll-mt-24 py-20 sm:py-24"
    >
      <Container>
        <div className="glass grid gap-10 rounded-sheet2 p-6 shadow-glass sm:p-10 lg:grid-cols-[0.85fr_1fr] lg:gap-14 lg:p-12">
          <div>
            <span className="grid h-16 w-16 place-items-center rounded-xl2 bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-glow">
              <IconShieldCheck className="h-8 w-8" />
            </span>
            <Eyebrow className="mt-6">Licensing &amp; compliance</Eyebrow>
            <h2
              id="licensing-title"
              className="mt-4 text-[1.7rem] font-bold leading-tight tracking-tight text-ink-900 sm:text-4xl"
            >
              A real, licensed pharmacy.
            </h2>
            <p className="mt-4 text-base leading-7 text-ink-600">
              MedRush dispenses under the Drugs and Cosmetics Act and Rules. Prescription medicines
              are supplied only against a valid prescription, reviewed by the registered pharmacist
              named here. Our registration details are published live from our store record — not
              typed into a page.
            </p>
            <Link
              href="/legal"
              className="press mt-6 inline-flex h-12 items-center gap-2 rounded-pill border border-primary-600/25 bg-primary-50 px-5 text-sm font-semibold text-primary-700 transition-colors hover:bg-primary-100"
            >
              Full licensing details
              <IconArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="rounded-xl2 border border-line bg-surface p-5 shadow-card2 sm:p-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-600">
              Registration
            </h3>
            {error && !store ? (
              <div className="mt-4">
                <ErrorState
                  message="Couldn’t load our registration details."
                  onRetry={() => void qc.invalidateQueries({ queryKey: ["store"] })}
                />
              </div>
            ) : (
              <dl className="mt-3" aria-busy={isLoading}>
                <Row label="Pharmacy" value={store?.name} isLoading={isLoading} />
                <Row label="Drug licence no." value={store?.drugLicenseNo} isLoading={isLoading} />
                <Row
                  label="Registered pharmacist"
                  value={store?.pharmacistName}
                  isLoading={isLoading}
                />
                <Row
                  label="Pharmacist reg. no."
                  value={store?.pharmacistRegNo}
                  isLoading={isLoading}
                />
                <Row label="GSTIN" value={store?.gstin} isLoading={isLoading} />
                <Row label="FSSAI no." value={store?.fssaiNo} isLoading={isLoading} />
                <Row label="Registered address" value={store?.address} isLoading={isLoading} />
              </dl>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}
