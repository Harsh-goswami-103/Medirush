"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { WishlistStatus } from "@medrush/contracts";
import { api, apiErrorMessage, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/cn";

/**
 * Batched heart-state for the shop grid.
 *
 * `GET /v1/wishlist/status` caps the id list at 100. Groups are passed in one
 * per loaded page of the infinite grid, so every query key stays stable as more
 * pages append — re-keying a single growing list would refetch the whole set on
 * each page. The first paint of the grid is therefore exactly one request.
 *
 * The key is ["wishlist-status", "batch", <ids>] so it can never collide with
 * the product page's single lookup (["wishlist-status", "one", productId]),
 * which caches a bare boolean rather than this envelope of statuses. Both stay
 * under the ["wishlist-status"] prefix so one invalidation refreshes them.
 */
const STATUS_BATCH_MAX = 100;

export interface WishlistController {
  signedIn: boolean;
  isWishlisted: (productId: string) => boolean;
  isPending: (productId: string) => boolean;
  /** Product whose heart was most recently switched on — drives the pop. */
  poppedId: string | null;
  toggle: (productId: string) => void;
}

export function useWishlist(idGroups: string[][]): WishlistController {
  const t = useTranslations("product");
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const signedIn = Boolean(user);

  // Optimistic truth layered over the server snapshot; an entry is written on
  // toggle and either confirmed (onSuccess) or rolled back (onError).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [poppedId, setPoppedId] = useState<string | null>(null);

  const groups = idGroups
    .map((ids) => ids.slice(0, STATUS_BATCH_MAX))
    .filter((ids) => ids.length > 0);

  const statusQueries = useQueries({
    queries: groups.map((ids) => ({
      queryKey: ["wishlist-status", "batch", ids.join(",")],
      queryFn: () =>
        api.get<WishlistStatus[]>(`/v1/wishlist/status${qs({ productIds: ids.join(",") })}`),
      enabled: signedIn,
      staleTime: 60_000,
      // A missing/failing status lookup must never break browsing — hearts just
      // render empty until the customer taps one.
      retry: false,
    })),
  });

  const serverState = new Map<string, boolean>();
  for (const query of statusQueries) {
    for (const entry of query.data?.data ?? []) serverState.set(entry.productId, entry.wishlisted);
  }

  /** Optimistic override wins over the last server snapshot. */
  const isWishlisted = (productId: string) =>
    overrides[productId] ?? serverState.get(productId) ?? false;

  const mutation = useMutation({
    mutationFn: ({ productId, next }: { productId: string; next: boolean; previous: boolean }) =>
      next
        ? api.post<WishlistStatus>("/v1/wishlist", { productId })
        : api.del<WishlistStatus>(`/v1/wishlist/${productId}`),
    onMutate: ({ productId, next }) => {
      setOverrides((prev) => ({ ...prev, [productId]: next }));
      setPendingIds((prev) => [...prev, productId]);
      setPoppedId(next ? productId : null);
    },
    onSuccess: (res, { productId }) => {
      setOverrides((prev) => ({ ...prev, [productId]: res.data.wishlisted }));
    },
    onError: (err, { productId, previous }) => {
      setOverrides((prev) => ({ ...prev, [productId]: previous }));
      toast.push({ type: "error", message: apiErrorMessage(err, t("wishlistError")) });
    },
    onSettled: (_res, _err, { productId }) => {
      setPendingIds((prev) => prev.filter((id) => id !== productId));
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["wishlist-status"] });
    },
  });

  const isPending = (productId: string) => pendingIds.includes(productId);

  function toggle(productId: string) {
    if (isPending(productId)) return;
    const previous = isWishlisted(productId);
    mutation.mutate({ productId, next: !previous, previous });
  }

  return { signedIn, isWishlisted, isPending, poppedId, toggle };
}

function HeartGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.8 8.8-8.8a5 5 0 0 0 0-7.1Z" />
    </svg>
  );
}

/**
 * Save-to-wishlist overlay for a product card. Rendered as a sibling *over*
 * `<ProductCard>` (which is shared with other surfaces and stays untouched), so
 * the tap lands on this control rather than the card's product link.
 */
export function WishlistHeart({
  productId,
  productName,
  controller,
  className,
}: {
  productId: string;
  productName: string;
  controller: WishlistController;
  className?: string;
}) {
  const t = useTranslations("product");
  const shell =
    "absolute right-0.5 top-0.5 z-10 grid h-11 w-11 place-items-center press";
  const face =
    "flex h-8 w-8 items-center justify-center rounded-full glass shadow-card2 transition-colors";

  if (!controller.signedIn) {
    return (
      <Link
        href="/login"
        aria-label={t("signInToSaveNamed", { name: productName })}
        className={cn(shell, className)}
      >
        <span className={cn(face, "text-ink-600")}>
          <HeartGlyph filled={false} />
        </span>
      </Link>
    );
  }

  const wishlisted = controller.isWishlisted(productId);
  const pending = controller.isPending(productId);

  return (
    <button
      type="button"
      onClick={() => controller.toggle(productId)}
      disabled={pending}
      aria-pressed={wishlisted}
      aria-busy={pending}
      aria-label={
        wishlisted
          ? t("removeNamedFromWishlist", { name: productName })
          : t("saveNamedToWishlist", { name: productName })
      }
      className={cn(shell, "disabled:opacity-60", className)}
    >
      <span
        className={cn(
          face,
          wishlisted ? "text-danger" : "text-ink-600",
          wishlisted && controller.poppedId === productId && "animate-pop",
        )}
      >
        <HeartGlyph filled={wishlisted} />
      </span>
    </button>
  );
}
