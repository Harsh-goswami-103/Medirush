"use client";

import { use, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { OrderStatus, TrackOrderResult } from "@medrush/contracts";
import { api } from "@/lib/api";
import { whatsappUrl } from "@/lib/env";
import { useAuth } from "@/lib/auth";
import { useOrderLive } from "@/lib/socket";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { Button, Card, ErrorState, OrderStatusBadge, Spinner } from "@/components/ui";

/** Code-split the MapLibre map — it is browser-only and heavy (§11), so never SSR it. */
const TrackMap = dynamic(() => import("@/components/TrackMap").then((m) => m.TrackMap), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-surface-2" />,
});

/** Happy-path timeline shown as a vertical stepper. */
const HAPPY_PATH = ["PLACED", "PACKING", "READY", "ASSIGNED", "PICKED_UP", "DELIVERED"] as const;
type HappyStep = (typeof HAPPY_PATH)[number];

const STEP_LABEL: Record<HappyStep, string> = {
  PLACED: "Order placed",
  PACKING: "Packing your order",
  READY: "Ready for pickup",
  ASSIGNED: "Rider assigned",
  PICKED_UP: "Picked up",
  DELIVERED: "Delivered",
};

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
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const track = trackQuery.data?.data;
  const idx = track ? currentStepIndex(track.status) : -1;
  const cancelled = track?.status === "CANCELLED";
  const driverPoint = track?.driverLocation
    ? { lat: track.driverLocation.lat, lng: track.driverLocation.lng }
    : null;

  return (
    <div>
      <TopBar back title="Track order" right={<LiveIndicator connected={connected} />} />

      <div className="space-y-4 p-4">
        {trackQuery.isError ? (
          <ErrorState
            message={(trackQuery.error as Error).message}
            onRetry={() => trackQuery.refetch()}
          />
        ) : !track ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6 text-primary-600" />
          </div>
        ) : (
          <>
            {/* Live map — store/destination anchors + the moving driver (§18.1). */}
            {!cancelled && (
              <div className="h-[260px] overflow-hidden rounded-card border border-line">
                <TrackMap store={track.store} destination={track.destination} driver={driverPoint} />
              </div>
            )}

            {/* ETA banner */}
            {!cancelled && <EtaBanner status={track.status} etaMinutes={track.etaMinutes} />}

            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-ink-600">Current status</p>
              <OrderStatusBadge status={track.status} />
            </div>

            {cancelled && (
              <div className="rounded-card border border-danger/20 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
                This order was cancelled.
              </div>
            )}

            <Card className={cn("p-4", cancelled && "opacity-60")}>
              <ol>
                {HAPPY_PATH.map((step, i) => {
                  const state = i < idx ? "done" : i === idx ? "current" : "upcoming";
                  const isLast = i === HAPPY_PATH.length - 1;
                  return (
                    <li key={step} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                            state === "upcoming"
                              ? "border-line bg-surface text-ink-400"
                              : "border-primary-600 bg-primary-600 text-white",
                            state === "current" && "ring-4 ring-primary-600/20",
                          )}
                        >
                          {state === "done" ? (
                            <svg
                              viewBox="0 0 24 24"
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            i + 1
                          )}
                        </span>
                        {!isLast && (
                          <span
                            className={cn(
                              "my-1 w-0.5 grow rounded-full",
                              i < idx ? "bg-primary-600" : "bg-line",
                            )}
                          />
                        )}
                      </div>
                      <div className={cn(isLast ? "pb-0" : "pb-6")}>
                        <p
                          className={cn(
                            "text-sm",
                            state === "upcoming"
                              ? "text-ink-400"
                              : state === "current"
                                ? "font-semibold text-ink-900"
                                : "text-ink-900",
                          )}
                        >
                          {STEP_LABEL[step]}
                        </p>
                        {state === "current" && !cancelled && (
                          <p className="mt-0.5 text-xs font-medium text-primary-700">In progress</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>

            {/* Driver card — name / vehicle / Call (present once ASSIGNED). */}
            {track.driver && (
              <Card className="p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Delivery partner
                </p>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {track.driver.name ?? "Assigned"}
                    </p>
                    <p className="text-xs text-ink-600">
                      {track.driver.vehicleType}
                      {track.driver.vehicleNo ? ` · ${track.driver.vehicleNo}` : ""}
                    </p>
                    {track.driverLocation && (
                      <p className="mt-0.5 text-xs text-ink-400">
                        Live · updated {timeAgo(track.driverLocation.ts)}
                      </p>
                    )}
                  </div>
                  <a href={`tel:${track.driver.phone}`} className="shrink-0">
                    <Button variant="secondary">Call</Button>
                  </a>
                </div>
              </Card>
            )}

            <div className="flex flex-col gap-2">
              <Link
                href={`/orders/${id}`}
                className="inline-flex w-full items-center justify-center rounded-input border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink-900 hover:bg-surface-2"
              >
                View order details
              </Link>
              <a
                href={whatsappUrl(`Hi, I need help with my order (${id}).`)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center rounded-input px-3.5 py-2 text-sm font-medium text-ink-600 hover:bg-surface-2"
              >
                Need help? Chat on WhatsApp
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** ETA banner — "Arriving in ~N min", or an accented "Driver arriving" when close. */
function EtaBanner({ status, etaMinutes }: { status: OrderStatus; etaMinutes: number | null }) {
  const arriving = status === "PICKED_UP" && (etaMinutes == null || etaMinutes <= 2);
  if (arriving) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-accent/30 bg-accent/10 px-4 py-3">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" aria-hidden />
        <p className="text-sm font-semibold text-accent">Driver arriving</p>
      </div>
    );
  }
  if (etaMinutes != null) {
    return (
      <div className="rounded-card border border-primary-600/20 bg-primary-600/5 px-4 py-3">
        <p className="text-sm font-semibold text-primary-700">Arriving in ~{etaMinutes} min</p>
      </div>
    );
  }
  return null;
}

/** Socket connection pill: green “Live” when connected, amber pulse otherwise. */
function LiveIndicator({ connected }: { connected: boolean }) {
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
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}
