import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ActiveDelivery,
  CreatePayoutBody,
  DeliverBody,
  DeliverResult,
  DriverHistory,
  DriverStatus,
  Offer,
  Payout,
  Wallet,
  WalletTxn,
} from "@medrush/contracts";
import { api, qs } from "./api";

/**
 * Typed data hooks for every driver endpoint (§7.2 driver + wallet). Response
 * types are the frozen contract types — nothing here is hand-shaped. Query keys
 * are exported so the socket layer can invalidate on real-time events.
 */

export const qk = {
  active: ["active"] as const,
  offers: ["offers"] as const,
  wallet: ["wallet"] as const,
  walletTxns: ["wallet", "txns"] as const,
  payouts: ["payouts"] as const,
  history: (date?: string) => ["history", date ?? "today"] as const,
};

/* ------------------------------------------------------------ status */

export function useSetOnline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (isOnline: boolean) =>
      api.patch<DriverStatus>("/v1/driver/status", { isOnline }).then((r) => r.data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.offers });
    },
  });
}

/* ------------------------------------------------------------ offers */

/** Poll open offers while online (socket is primary; this is the refresh path). */
export function useOffers(enabled: boolean): UseQueryResult<Offer[]> {
  return useQuery({
    queryKey: qk.offers,
    queryFn: () => api.get<Offer[]>("/v1/driver/offers").then((r) => r.data),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
  });
}

export function useAcceptOffer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) =>
      api.post<ActiveDelivery>(`/v1/driver/offers/${offerId}/accept`).then((r) => r.data),
    onSuccess: (active) => {
      client.setQueryData(qk.active, active);
      void client.invalidateQueries({ queryKey: qk.offers });
    },
  });
}

export function useRejectOffer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) =>
      api.post<{ ok: true }>(`/v1/driver/offers/${offerId}/reject`).then((r) => r.data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.offers });
    },
  });
}

/* --------------------------------------------------- active delivery */

export function useActiveDelivery(enabled = true): UseQueryResult<ActiveDelivery | null> {
  return useQuery({
    queryKey: qk.active,
    queryFn: () => api.get<ActiveDelivery | null>("/v1/driver/active").then((r) => r.data),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function usePickedUp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api
        .post<ActiveDelivery>(`/v1/driver/deliveries/${deliveryId}/picked-up`)
        .then((r) => r.data),
    onSuccess: (active) => {
      client.setQueryData(qk.active, active);
    },
  });
}

export function useDeliver() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ deliveryId, body }: { deliveryId: string; body: DeliverBody }) =>
      api
        .post<DeliverResult>(`/v1/driver/deliveries/${deliveryId}/deliver`, body)
        .then((r) => r.data),
    onSuccess: () => {
      client.setQueryData(qk.active, null);
      void client.invalidateQueries({ queryKey: qk.active });
      void client.invalidateQueries({ queryKey: qk.wallet });
      void client.invalidateQueries({ queryKey: qk.walletTxns });
      void client.invalidateQueries({ queryKey: ["history"] });
    },
  });
}

/* ------------------------------------------------------------ wallet */

export function useWallet(): UseQueryResult<Wallet> {
  return useQuery({
    queryKey: qk.wallet,
    queryFn: () => api.get<Wallet>("/v1/driver/wallet").then((r) => r.data),
  });
}

export function useWalletTxns(): UseQueryResult<WalletTxn[]> {
  return useQuery({
    queryKey: qk.walletTxns,
    queryFn: () => api.get<WalletTxn[]>("/v1/driver/wallet/txns").then((r) => r.data),
  });
}

/**
 * A customer tip is credited as its own ORDER-ref CREDIT alongside the delivery
 * commission. The ledger has no tip subtype, so the note the server writes
 * (`Tip for <orderNo>`) is the only thing that separates the two rows.
 */
const TIP_NOTE_PREFIX = "Tip for ";

export function isTipTxn(txn: WalletTxn): boolean {
  return txn.refType === "ORDER" && (txn.note?.startsWith(TIP_NOTE_PREFIX) ?? false);
}

/* ----------------------------------------------------------- payouts */

export function usePayouts(): UseQueryResult<Payout[]> {
  return useQuery({
    queryKey: qk.payouts,
    queryFn: () => api.get<Payout[]>("/v1/driver/payouts").then((r) => r.data),
  });
}

export function useRequestPayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: CreatePayoutBody; idempotencyKey: string }) =>
      api.post<Payout>("/v1/driver/payouts", body, { idempotencyKey }).then((r) => r.data),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.payouts });
      void client.invalidateQueries({ queryKey: qk.wallet });
    },
  });
}

/* ----------------------------------------------------------- history */

export function useHistory(date?: string): UseQueryResult<DriverHistory> {
  return useQuery({
    queryKey: qk.history(date),
    queryFn: () =>
      api.get<DriverHistory>(`/v1/driver/history${qs({ date })}`).then((r) => r.data),
  });
}
