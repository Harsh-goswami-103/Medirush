"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cart } from "@medrush/contracts";
import { api, type Envelope } from "./api";
import { useAuth } from "./auth";

/**
 * Server cart hook (price integrity — the client only sends qty). Reads
 * `/v1/cart` when authed; `setItem` upserts an exact line qty (or removes at
 * qty ≤ 0) and writes the returned cart straight into the query cache.
 */
export function useCart() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["cart"],
    queryFn: () => api.get<Cart>("/v1/cart"),
    enabled: Boolean(user),
  });

  const setItem = useMutation({
    mutationFn: ({ productId, qty }: { productId: string; qty: number }): Promise<Envelope<Cart>> =>
      qty <= 0
        ? api.del<Cart>(`/v1/cart/items/${productId}`)
        : api.put<Cart>("/v1/cart/items", { productId, qty }),
    onSuccess: (res) => qc.setQueryData<Envelope<Cart>>(["cart"], res),
  });

  const cart = query.data?.data;
  const itemCount = cart?.items.reduce((n, i) => n + i.qty, 0) ?? 0;
  const qtyOf = (productId: string) => cart?.items.find((i) => i.productId === productId)?.qty ?? 0;

  return { cart, isLoading: query.isLoading, setItem, itemCount, qtyOf };
}
