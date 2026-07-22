"use client";

import { use, useEffect, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import type { OrderStatus, TrackOrderResult } from "@medrush/contracts";
import { api } from "@/lib/api";
import { whatsappUrl } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useOrderLive } from "@/lib/socket";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { ErrorState, OrderStatusBadge, Skeleton, Spinner } from "@/components/ui";

/** Code-split the MapLibre map — it is browser-only and heavy (§11), so never SSR it. */
const TrackMap = dynamic(() => import("@/components/TrackMap").then((m) => m.TrackMap), {
  ssr: false,
  loading: () => <div className="skeleton h-full w-full" />,
});

/**
 * Happy-path timeline shown as a vertical stepper.
 *
 * The step labels live in the `trackStatus` catalog, keyed by the enum value —
 * the stepper only ever renders these six, so adding a member here without a
 * matching message fails typecheck instead of rendering a raw identifier.
 */
const HAPPY_PATH = ["PLACED", "PACKING", "READY", "ASSIGNED", "PICKED_UP", "DELIVERED"] as const;

/** Where the live status sits on the happy path (−1 for pre-placement / cancelled). */
function currentStepIndex(status: OrderStatus): number {
  switch (status) {
    case "PLACED":
    case "RX_REVIEW":
      return 0;
    case "PACKING":
      return 1;
    case "READY":
      return 2;
    case "ASSIGNED":
      return 3;
    case "PICKED_UP":
      return 4;
    case "DELIVERED":
      // One past the last node so every step renders "done" (no "current").
      return 6;
    default:
      return -1; // PENDING_PAYMENT, CANCELLED
  }
}

export default function TrackOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const t = useTranslations("orders");
  const tStep = useTranslations("trackStatus");
  // Intl.RelativeTimeFormat via next-intl: Hindi relative time for free, rather
  // than hand-rolling "2m ago" strings into the catalog.
  const format = useFormatter();
  const { user, loading } = useAuth();
  const { connected } = useOrderLive(id);

  // Auth-gate: bounce to sign-in once we know there is no session.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const trackQuery = useQuery({
    queryKey: ["order-track", id],
    queryFn: () => api.get<TrackOrderResult>(`/v1/orders/${id}/track`),
    enabled: Boolean(user),
    // Polling fallback (§7.3): poll fast while the socket is down, back off when live.
    refetchInterval: connected ? 15000 : 4000,
  });

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const track = trackQuery.data?.data;
  const idx = track ? currentStepIndex(track.status) : -1;
  const cancelled = track?.status === "CANCELLED";
  // null when NEXT_PUBLIC_SUPPORT_PHONE is unset — the CTA is hidden then.
  const supportUrl = whatsappUrl(t("supportMessageTrack", { id }));
  const driverPoint = track?.driverLocation
    ? { lat: track.driverLocation.lat, lng: track.driverLocation.lng }
    : null;
  // Timestamps for the stepper come from the server timeline (oldest→newest).
  const reachedAt = new Map<OrderStatus, string>();
  for (const entry of track?.timeline ?? []) {
    if (!reachedAt.has(entry.status)) reachedAt.set(entry.status, entry.at);
  }

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar back title={t("trackOrder")} right={<LiveIndicator connected={connected} />} />

      <div className="space-y-4 p-4 pb-8">
        {trackQuery.isError ? (
          <ErrorState
            message={(trackQuery.error as Error).message}
            onRetry={() => trackQuery.refetch()}
          />
        ) : !track ? (
          <TrackSkeleton />
        ) : (
          <>
            {/* Live map — store/destination anchors + the moving driver (§18.1). */}
            {!cancelled && (
              <div className="h-[260px] overflow-hidden rounded-xl2 border border-line/70 shadow-card2">
                <TrackMap store={track.store} destination={track.destination} driver={driverPoint} />
              </div>
            )}

            {/* ETA banner */}
            {!cancelled && <EtaBanner status={track.status} etaMinutes={track.etaMinutes} />}

            {/* aria-live so screen readers hear status transitions (§20.6). */}
            <div
              className="flex items-center justify-between gap-2 rounded-pill glass px-4 py-2.5 shadow-sm"
              aria-live="polite"
            >
              <p className="text-sm font-medium text-ink-600">{t("currentStatus")}</p>
              <OrderStatusBadge status={track.status} />
            </div>

            {cancelled && (
              <div className="rounded-xl2 border border-danger/20 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
                {t("trackCancelled")}
              </div>
            )}

            <Panel className={cn("p-5", cancelled && "opacity-60")}>
              <ol>
                {HAPPY_PATH.map((step, i) => {
                  const state = i < idx ? "done" : i === idx ? "current" : "upcoming";
                  const isLast = i === HAPPY_PATH.length - 1;
                  const at = reachedAt.get(step);
                  return (
                    <li key={step} className="flex gap-3.5">
                      <div className="flex flex-col items-center">
                        {state === "upcoming" ? (
                          <span
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-line bg-surface text-xs font-semibold text-ink-400"
                            aria-hidden
                          >
                            {i + 1}
                          </span>
                        ) : state === "done" ? (
                          <span
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-600 to-primary-700 text-white shadow-sm"
                            aria-hidden
                          >
                            <svg
                              viewBox="0 0 24 24"
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          </span>
                        ) : (
                          <span
                            className="relative flex h-9 w-9 shrink-0 items-center justify-center"
                            aria-hidden
                          >
                            {!cancelled && (
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary-500/50 opacity-60" />
                            )}
                            <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary-600 to-primary-700 shadow-glow">
                              <span className="h-2.5 w-2.5 rounded-full bg-white" />
                            </span>
                          </span>
                        )}
                        {!isLast && (
                          <span
                            className={cn(
                              "my-1 w-[3px] grow rounded-full",
                              i < idx
                                ? "bg-gradient-to-b from-primary-600 to-primary-500"
                                : "bg-line",
                            )}
                            aria-hidden
                          />
                        )}
                      </div>
                      <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-6")}>
                        <p
                          className={cn(
                            "text-sm leading-9",
                            state === "upcoming"
                              ? "text-ink-400"
                              : state === "current"
                                ? "font-bold text-ink-900"
                                : "font-medium text-ink-900",
                          )}
                        >
                          {tStep(step)}
                        </p>
                        {at && <p className="-mt-2 text-xs text-ink-400">{formatDateTime(at)}</p>}
                        {state === "current" && !cancelled && (
                          <p className="mt-1 inline-flex items-center gap-1.5 rounded-pill bg-primary-50 px-2.5 py-0.5 text-xs font-semibold text-primary-800">
                            <span
                              className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-600"
                              aria-hidden
                            />
                            {t("inProgress")}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Panel>

            {/* Driver card — name / vehicle / Call (present once ASSIGNED). */}
            {track.driver && (
              <Panel className="p-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-ink-400">
                  {t("deliveryPartner")}
                </p>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-700 to-primary-600 text-base font-bold text-white shadow-glow"
                      aria-hidden
                    >
                      {(track.driver.name ?? "R").charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink-900">
                        {track.driver.name ?? t("driverAssigned")}
                      </p>
                      <p className="truncate text-xs text-ink-600">
                        {track.driver.vehicleType}
                        {track.driver.vehicleNo ? ` · ${track.driver.vehicleNo}` : ""}
                      </p>
                      {track.driverLocation && (
                        <p className="mt-0.5 text-xs text-ink-400">
                          {t("liveUpdated", { ago: format.relativeTime(new Date(track.driverLocation.ts)) })}
                        </p>
                      )}
                    </div>
                  </div>
                  <a
                    href={`tel:${track.driver.phone}`}
                    aria-label={t("callDriverAria", {
                      name: track.driver.name ?? t("theDeliveryPartner"),
                    })}
                    className="press inline-flex min-h-[44px] shrink-0 items-center rounded-pill border border-primary-600/40 bg-primary-50 px-4 text-sm font-semibold text-primary-800"
                  >
                    {t("call")}
                  </a>
                </div>
              </Panel>
            )}

            <div className="flex flex-col gap-2 pt-1">
              <Link
                href={`/orders/${id}`}
                className="press inline-flex min-h-[44px] w-full items-center justify-center rounded-pill border border-line bg-surface px-4 text-sm font-semibold text-ink-900 hover:bg-surface-2"
              >
                {t("viewOrderDetails")}
              </Link>
              {supportUrl && (
                <a
                  href={supportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="press inline-flex min-h-[44px] w-full items-center justify-center rounded-pill px-4 text-sm font-medium text-ink-600 hover:bg-surface-2"
                >
                  {t("needHelpWhatsapp")}
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

/** Elevated panel — the Premium Teal surface used across the order screens. */
function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl2 border border-line/70 bg-surface shadow-card2", className)}>
      {children}
    </div>
  );
}

/** ETA banner — "Arriving in ~N min", or an accented "Driver arriving" when close. */
function EtaBanner({ status, etaMinutes }: { status: OrderStatus; etaMinutes: number | null }) {
  // Hook first: both branches below return early, but the hook order must not depend on them.
  const t = useTranslations("orders");
  const arriving = status === "PICKED_UP" && (etaMinutes == null || etaMinutes <= 2);
  if (arriving) {
    return (
      <div
        className="flex items-center gap-2.5 rounded-xl2 border border-accent/30 bg-accent/10 px-4 py-3.5"
        aria-live="polite"
      >
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" aria-hidden />
        <p className="text-base font-bold text-warning">{t("driverArriving")}</p>
      </div>
    );
  }
  if (etaMinutes != null) {
    return (
      <div
        className="flex items-baseline justify-between gap-3 rounded-xl2 bg-gradient-to-br from-primary-800 to-primary-700 px-4 py-3.5 shadow-glow"
        aria-live="polite"
      >
        <p className="text-sm font-medium text-white/90">{t("arrivingIn")}</p>
        <p className="text-2xl font-bold tabular-nums text-white">
          ~{etaMinutes} <span className="text-base font-semibold">{t("minutesShort")}</span>
        </p>
      </div>
    );
  }
  return null;
}

/** Socket connection pill: green “Live” when connected, amber pulse otherwise. */
function LiveIndicator({ connected }: { connected: boolean }) {
  const t = useTranslations("orders");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        connected ? "text-success" : "text-warning",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          connected ? "bg-success" : "animate-pulse bg-warning",
        )}
        aria-hidden
      />
      {connected ? t("live") : t("reconnecting")}
    </span>
  );
}

/** Shaped placeholder for the initial track load (§20.4). */
function TrackSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-[260px] w-full rounded-xl2" />
      <Skeleton className="h-14 w-full rounded-xl2" />
      <div className="rounded-xl2 border border-line/70 bg-surface p-5 shadow-card2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3.5 py-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
