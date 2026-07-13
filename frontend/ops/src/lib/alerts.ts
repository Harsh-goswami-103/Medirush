"use client";

import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientToServerEvents, OpsAlert, ServerToClientEvents } from "@medrush/contracts";
import { AlertKind } from "@medrush/contracts";
import { API_BASE_URL } from "./env";
import { api, getAuthToken, qs } from "./api";
import { useAuth } from "./auth";

/**
 * Durable ops-alerts wiring (Phase 7): every `alert` socket emit is persisted
 * as an OpsAlert row server-side. GET /v1/ops/alerts is the inbox (newest
 * first, unacked by default); POST /v1/ops/alerts/:id/ack is idempotent.
 * All alert queries share the {@link OPS_ALERTS_KEY} root so a single
 * invalidation refreshes both the /alerts list and the nav badge.
 */

/** Query-key root for everything alerts — invalidate this to refresh badge + list. */
export const OPS_ALERTS_KEY = ["ops-alerts"] as const;

/** Badge tone per known alert kind. Open set — unknown kinds render neutral. */
const ALERT_KIND_TONE: Record<string, "red" | "amber" | "neutral"> = {
  // Money / data at risk — act before the next business day.
  [AlertKind.WALLET_DRIFT]: "red",
  [AlertKind.DB_BACKUP_FAILED]: "red",
  [AlertKind.MANUAL_REFUND_REQUIRED]: "red",
  // Flow interruptions — an order or account needs a nudge.
  [AlertKind.STUCK_ORDER]: "amber",
  [AlertKind.UNASSIGNED_ORDER]: "amber",
  [AlertKind.FRAUD_VELOCITY]: "amber",
  [AlertKind.GENERIC]: "neutral",
};

export function alertKindTone(kind: string): "red" | "amber" | "neutral" {
  return ALERT_KIND_TONE[kind] ?? "neutral";
}

/**
 * Kinds whose `refId` is an order id at every backend emit site (stuck-order
 * watchdog, dispatch dead-ends, refund failures, customer cancel requests) —
 * these link straight to the ops order page. WALLET_DRIFT carries a wallet id
 * and FRAUD_VELOCITY has no ref, so they render as plain references.
 */
const ORDER_REF_KINDS = new Set<string>([
  AlertKind.STUCK_ORDER,
  AlertKind.UNASSIGNED_ORDER,
  AlertKind.MANUAL_REFUND_REQUIRED,
  AlertKind.GENERIC,
]);

export function refLinksToOrder(alert: Pick<OpsAlert, "kind" | "refId">): boolean {
  return alert.refId !== null && ORDER_REF_KINDS.has(alert.kind);
}

type OpsSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Invalidate the alert queries whenever an `alert` lands on the ops room, so
 * the nav badge and the /alerts inbox update live. Mounted once in AppShell.
 *
 * This opens its own lightweight socket: `useOpsLiveBoard` (lib/socket.ts)
 * already receives the event for toasts, but it neither exposes its socket
 * instance nor invalidates alert queries — folding a one-line
 * `qc.invalidateQueries({ queryKey: OPS_ALERTS_KEY })` into its `alert`
 * handler would let this hook piggyback and drop the extra connection.
 */
export function useOpsAlertsLive(): void {
  const { token } = useAuth();
  const qc = useQueryClient();

  // Key on *having* a session (tokens rotate hourly); the handshake callback
  // reads the current bearer — same pattern as useOpsLiveBoard.
  const authed = token !== null;

  useEffect(() => {
    if (!authed) return;
    const socket: OpsSocket = io(API_BASE_URL, {
      auth: (cb) => cb({ token: getAuthToken() }),
      transports: ["websocket"],
    });

    socket.on("alert", () => void qc.invalidateQueries({ queryKey: OPS_ALERTS_KEY }));

    return () => {
      socket.off();
      socket.disconnect();
    };
  }, [authed, qc]);
}

/**
 * Unacked-alert count for the nav badge. There is no dedicated count endpoint,
 * so this fetches the first (max-size) unacked page: `overflow` means "50+".
 * The socket hook invalidates it live; the interval is the reconnect fallback.
 */
export function useUnackedAlertBadge(): { count: number; overflow: boolean } {
  const query = useQuery({
    queryKey: [...OPS_ALERTS_KEY, "badge"],
    queryFn: () => api.get<OpsAlert[]>(`/v1/ops/alerts${qs({ limit: 50 })}`),
    refetchInterval: 60_000,
  });
  return {
    count: query.data?.data.length ?? 0,
    overflow: Boolean(query.data?.meta?.nextCursor),
  };
}
