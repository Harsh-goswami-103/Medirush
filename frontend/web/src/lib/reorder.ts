"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Cart, OrderDetail } from "@medrush/contracts";
import { api, ApiError, type Envelope } from "./api";
import { useToast } from "@/components/toast";

/** A single line to (re)add to the cart. */
export interface ReorderLine {
  productId: string;
  qty: number;
}

/**
 * "Order again" — repopulate the server cart from a past order.
 *
 * The blueprint calls out reorder as the core pharmacy loop (§17 v1 "reorder
 * shortcut"), and every field we need already exists: `OrderDetail.items[]`
 * carries `productId` + `qty`, and `PUT /v1/cart/items` upserts an exact line
 * qty. We therefore need **no new backend** — we just replay the lines.
 *
 * Call with `{ items }` when the caller already holds the order detail (order
 * page), or `{ orderId }` to have the hook fetch it first (history list rows).
 * Items that are now inactive / out of stock / over the per-order cap fail
 * their individual PUT and are counted as `skipped` rather than aborting the
 * whole reorder — the customer still gets everything that is still buyable.
 */
export function useReorder() {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();

  return useMutation({
    mutationFn: async (
      arg: { items: ReorderLine[] } | { orderId: string },
    ): Promise<{ added: number; skipped: number; cart?: Envelope<Cart> }> => {
      const lines: ReorderLine[] =
        "items" in arg
          ? arg.items
          : (await api.get<OrderDetail>(`/v1/orders/${arg.orderId}`)).data.items.map((i) => ({
              productId: i.productId,
              qty: i.qty,
            }));

      let added = 0;
      let skipped = 0;
      let cart: Envelope<Cart> | undefined;
      // Sequential so the server sees a stable cart per upsert and the last
      // response reflects every line we managed to add.
      for (const line of lines) {
        try {
          cart = await api.put<Cart>("/v1/cart/items", {
            productId: line.productId,
            qty: line.qty,
          });
          added += 1;
        } catch (err) {
          // A NETWORK error is transient and shouldn't be silently swallowed as
          // "unavailable" — surface it so the customer can retry.
          if (err instanceof ApiError && err.code === "NETWORK") throw err;
          skipped += 1;
        }
      }
      return { added, skipped, cart };
    },
    onSuccess: ({ added, skipped, cart }) => {
      // Write the freshest cart straight into the query cache useCart reads.
      if (cart) qc.setQueryData<Envelope<Cart>>(["cart"], cart);
      else void qc.invalidateQueries({ queryKey: ["cart"] });

      if (added === 0) {
        toast.push({
          type: "error",
          message: "None of those items are available right now",
        });
        return;
      }
      toast.push({
        type: "success",
        message: skipped
          ? `Added ${added} item${added > 1 ? "s" : ""} · ${skipped} no longer available`
          : `Added ${added} item${added > 1 ? "s" : ""} to your cart`,
      });
      router.push("/cart");
    },
    onError: () =>
      toast.push({ type: "error", message: "Couldn't reorder — please try again" }),
  });
}
