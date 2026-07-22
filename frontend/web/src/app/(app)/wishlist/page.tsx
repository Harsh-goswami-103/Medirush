"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { WishlistEntry, WishlistStatus } from "@medrush/contracts";
import { api, apiErrorMessage, qs, type Envelope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { TopBar } from "@/components/AppShell";
import { Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { ProductCard, ProductGridSkeleton } from "@/components/shop";
import { Reveal } from "@/components/motion";
import { useToast } from "@/components/toast";

type WishlistPages = InfiniteData<Envelope<WishlistEntry[]>>;

const WISHLIST_KEY = ["wishlist"] as const;

/** Deep teal gradient CTA — kept at primary-700→800 so white label stays ≥4.5:1. */
const CTA =
  "press inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-input bg-gradient-to-br from-primary-700 to-primary-800 px-4 text-sm font-semibold text-white shadow-glow transition-colors hover:from-primary-800 hover:to-primary-900";

function HeartIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-4 w-4"}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20.3l-1.45-1.32C5.4 14.36 2 11.28 2 7.5 2 4.42 4.42 2 7.5 2c1.74 0 3.41.81 4.5 2.09C13.09 2.81 14.76 2 16.5 2 19.58 2 22 4.42 22 7.5c0 3.78-3.4 6.86-8.55 11.48z" />
    </svg>
  );
}

/** Saved products — GET /v1/wishlist (cursor-paginated), remove via DELETE. */
export default function WishlistPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const wishlistQuery = useInfiniteQuery({
    queryKey: WISHLIST_KEY,
    queryFn: ({ pageParam }) =>
      api.get<WishlistEntry[]>(`/v1/wishlist${qs({ cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
    enabled: Boolean(user),
  });

  const remove = useMutation({
    mutationFn: (productId: string) => api.del<WishlistStatus>(`/v1/wishlist/${productId}`),
    // Optimistic: the card disappears on tap; a failure rolls the page back.
    onMutate: async (productId) => {
      await qc.cancelQueries({ queryKey: WISHLIST_KEY });
      const previous = qc.getQueryData<WishlistPages>(WISHLIST_KEY);
      qc.setQueryData<WishlistPages>(WISHLIST_KEY, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                data: page.data.filter((entry) => entry.product.id !== productId),
              })),
            }
          : old,
      );
      return { previous };
    },
    onError: (err, _productId, ctx) => {
      if (ctx?.previous) qc.setQueryData(WISHLIST_KEY, ctx.previous);
      toast.push({ type: "error", message: apiErrorMessage(err, "Could not remove this item") });
    },
    onSuccess: () => toast.push({ type: "success", message: "Removed from wishlist" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: WISHLIST_KEY }),
  });

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-mesh">
        <Spinner className="h-6 w-6 text-primary-600" />
      </div>
    );
  }

  const entries = wishlistQuery.data?.pages.flatMap((p) => p.data) ?? [];
  const hasEntries = entries.length > 0;

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar title="Wishlist" back />

      <div className="space-y-4 p-4">
        {hasEntries && (
          <Reveal as="section">
            <div className="glass flex items-center gap-3 rounded-xl2 p-4 shadow-glass">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700">
                <HeartIcon className="h-5 w-5" filled />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-900" aria-live="polite">
                  {entries.length} saved {entries.length === 1 ? "item" : "items"}
                </p>
                <p className="mt-0.5 text-sm text-ink-600">
                  Prices and stock stay live — tap the heart to remove.
                </p>
              </div>
            </div>
          </Reveal>
        )}

        {wishlistQuery.isError ? (
          <ErrorState
            message={apiErrorMessage(wishlistQuery.error, "Could not load your wishlist")}
            onRetry={() => void wishlistQuery.refetch()}
          />
        ) : wishlistQuery.isLoading ? (
          <ProductGridSkeleton count={6} />
        ) : !hasEntries ? (
          <EmptyState
            icon={<HeartIcon className="h-10 w-10" />}
            title="Nothing saved yet"
            hint="Tap the heart on any medicine to keep it here for a one-tap reorder."
            action={
              <Link href="/shop" className={CTA}>
                Browse medicines
              </Link>
            }
          />
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-3">
              {entries.map((entry, i) => (
                <Reveal as="li" key={entry.id} delayMs={(i % 6) * 60} className="relative">
                  <ProductCard product={entry.product} />
                  <button
                    type="button"
                    onClick={() => remove.mutate(entry.product.id)}
                    disabled={remove.isPending && remove.variables === entry.product.id}
                    aria-label={`Remove ${entry.product.name} from wishlist`}
                    className="press absolute right-0 top-0 z-10 flex h-11 w-11 items-center justify-center disabled:opacity-50"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface/90 text-danger shadow-card2 backdrop-blur">
                      <HeartIcon className="h-4 w-4" filled />
                    </span>
                  </button>
                </Reveal>
              ))}
            </ul>

            {wishlistQuery.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  className="press"
                  loading={wishlistQuery.isFetchingNextPage}
                  onClick={() => void wishlistQuery.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
