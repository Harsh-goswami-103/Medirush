"use client";

import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@/lib/store";
import { CountUp } from "@/components/motion";
import { ErrorState, Skeleton } from "@/components/ui";
import { Container } from "./primitives";
import { IconPin, IconRider, IconShieldCheck, IconBolt } from "./icons";

/** The 40-minute promise is a brand commitment, not a store-config field. */
const PROMISE_MINUTES = 40;

function Stat({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl2 bg-primary-50 text-primary-700">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-lg font-bold leading-tight tracking-tight text-ink-900">{value}</div>
        <p className="mt-0.5 text-xs font-medium uppercase tracking-[0.1em] text-ink-600">{label}</p>
      </div>
    </li>
  );
}

/**
 * Trust bar, overlapping the hero. Everything but the 40-minute promise is
 * read LIVE from GET /v1/store; while that is in flight the live cells hold
 * skeletons rather than guessing at values.
 */
export function TrustBar() {
  const qc = useQueryClient();
  const { store, isLoading, error } = useStore();

  const radiusKm = store ? Math.max(1, Math.round(store.serviceRadiusM / 1000)) : null;

  return (
    <Container className="relative z-10 -mt-14 sm:-mt-16">
      <div className="glass rounded-sheet2 p-5 shadow-glass sm:p-7" aria-busy={isLoading}>
        {error && !store ? (
          <ErrorState
            message="Couldn’t load our pharmacy details right now."
            onRetry={() => void qc.invalidateQueries({ queryKey: ["store"] })}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite">
            <Stat
              icon={<IconBolt className="h-5 w-5" />}
              value={
                <>
                  <CountUp to={PROMISE_MINUTES} /> min
                </>
              }
              label="Typical delivery"
            />
            <Stat
              icon={<IconPin className="h-5 w-5" />}
              value={
                radiusKm === null ? (
                  <Skeleton className="h-6 w-20" />
                ) : (
                  <>
                    <CountUp to={radiusKm} /> km
                  </>
                )
              }
              label="Service radius"
            />
            <Stat
              icon={<IconShieldCheck className="h-5 w-5" />}
              value={
                isLoading ? (
                  <Skeleton className="h-6 w-32" />
                ) : (
                  <span className="block truncate text-base">
                    {store?.pharmacistName ?? "Registered pharmacist"}
                  </span>
                )
              }
              label="Pharmacist on duty"
            />
            <Stat
              icon={<IconRider className="h-5 w-5" />}
              value={
                isLoading ? (
                  <Skeleton className="h-6 w-28" />
                ) : (
                  <span className="block truncate text-base tabular-nums">
                    {store?.drugLicenseNo ?? "Licensed pharmacy"}
                  </span>
                )
              }
              label="Drug licence"
            />
          </ul>
        )}
      </div>
    </Container>
  );
}
