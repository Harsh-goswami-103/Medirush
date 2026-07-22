"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Category, ProductSort, ProductSummary } from "@medrush/contracts";
import { api, qs } from "@/lib/api";
import { useStore } from "@/lib/store";
import { ProductCard, ProductGridSkeleton } from "@/components/shop";
import { NotificationBell } from "@/components/AppShell";
import { EmptyState, ErrorState } from "@/components/ui";
import { cn } from "@/lib/cn";

/** localStorage key for the recent-search chips (most recent first, capped). */
const RECENTS_KEY = "medrush.web.recentSearches";
const RECENTS_MAX = 8;

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Sort options surfaced as pills; undefined = default (relevance for search). */
const SORTS: { label: string; value: ProductSort | undefined }[] = [
  { label: "Default", value: undefined },
  { label: "Price ↑", value: "price_asc" },
  { label: "Price ↓", value: "price_desc" },
  { label: "Discount", value: "discount" },
  { label: "A–Z", value: "name" },
];

export default function Home() {
  const { store } = useStore();
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ProductSort | undefined>(undefined);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [discountedOnly, setDiscountedOnly] = useState(false);
  const [rxFilter, setRxFilter] = useState<boolean | undefined>(undefined);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  // Debounce the search box so keystrokes don't fire a query each.
  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [rawSearch]);

  // Record executed searches (debounced, ≥2 chars) as recent-search chips.
  useEffect(() => {
    if (search.length < 2) return;
    setRecents((prev) => {
      const next = [search, ...prev.filter((s) => s.toLowerCase() !== search.toLowerCase())].slice(
        0,
        RECENTS_MAX,
      );
      try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Storage full/blocked — chips just won't persist.
      }
      return next;
    });
  }, [search]);

  function clearRecents() {
    setRecents([]);
    try {
      window.localStorage.removeItem(RECENTS_KEY);
    } catch {
      // ignore
    }
  }

  const catsQuery = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/v1/categories"),
    staleTime: 5 * 60_000,
  });
  // Cursor-paginated so browsing isn't capped at one page — the API already
  // returns `meta.nextCursor`; the old flat `limit:50` fetch just ignored it.
  // Sorted/filtered views compose server-side; a sorted view is top-N (the API
  // returns nextCursor null there, so paging stops naturally).
  const productsQuery = useInfiniteQuery({
    queryKey: [
      "products",
      category ?? "",
      search,
      sort ?? "",
      inStockOnly,
      discountedOnly,
      rxFilter ?? "any",
    ],
    queryFn: ({ pageParam }) =>
      api.get<ProductSummary[]>(
        `/v1/products${qs({
          category,
          search: search || undefined,
          sort,
          inStock: inStockOnly ? "true" : undefined,
          discounted: discountedOnly ? "true" : undefined,
          requiresRx: rxFilter === undefined ? undefined : String(rxFilter),
          cursor: pageParam,
          limit: 20,
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor ?? undefined,
  });

  const categories = catsQuery.data?.data ?? [];
  const products = productsQuery.data?.pages.flatMap((p) => p.data) ?? [];

  // Infinite-scroll sentinel: fetch the next page when it scrolls into view.
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = productsQuery;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onSentinel = useCallback(
    (node: HTMLDivElement | null) => {
      sentinelRef.current = node;
    },
    [],
  );
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, products.length]);

  return (
    <div>
      <div className="bg-primary-600 px-4 pb-4 pt-5 text-white">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs opacity-90">Delivering to you in ~40 min</p>
            <h1 className="text-lg font-semibold">{store?.name ?? "MedRush"}</h1>
          </div>
          <NotificationBell tone="invert" />
        </div>
        {store && !store.isOpen && (
          <p className="mt-1 text-xs font-medium text-white/90">⚠ Store is currently closed</p>
        )}
        <div className="mt-3">
          <input
            className="w-full rounded-input bg-surface px-3 py-2 text-sm text-ink-900 outline-none placeholder:text-ink-400"
            placeholder="Search medicines & health products"
            value={rawSearch}
            // Keep the category — the API supports search WITHIN a category.
            onChange={(e) => setRawSearch(e.target.value)}
          />
        </div>

        {/* Recent searches — tap to re-run; hidden while typing. */}
        {rawSearch === "" && recents.length > 0 && (
          <div className="no-scrollbar mt-2 flex items-center gap-2 overflow-x-auto">
            {recents.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => setRawSearch(term)}
                className="flex shrink-0 items-center gap-1 rounded-pill bg-white/15 px-2.5 py-1 text-xs text-white"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 3" />
                </svg>
                {term}
              </button>
            ))}
            <button
              type="button"
              onClick={clearRecents}
              className="shrink-0 px-1 text-xs text-white/70 underline-offset-2 hover:underline"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-3">
        <Chip
          active={!category && !search}
          onClick={() => {
            setCategory(undefined);
            setRawSearch("");
          }}
        >
          All
        </Chip>
        {categories.map((c) => (
          <Chip
            key={c.id}
            active={category === c.slug}
            // Keep any active search — it now filters within the category.
            onClick={() => setCategory(c.slug)}
          >
            {c.name}
          </Chip>
        ))}
      </div>

      {/* Offers strip → /offers deals surface. */}
      <Link
        href="/offers"
        className="mx-4 mb-3 flex items-center justify-between rounded-card border border-accent/30 bg-accent/5 px-3 py-2"
      >
        <span className="text-sm font-medium text-ink-900">
          <span className="mr-1.5" aria-hidden>
            🏷️
          </span>
          Offers &amp; coupon codes
        </span>
        <span className="text-xs font-semibold text-accent">View all →</span>
      </Link>

      {/* Sort + quick filters — server-side via the extended products query. */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto px-4 pb-3">
        {SORTS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setSort(s.value)}
            className={cn(
              "whitespace-nowrap rounded-pill border px-2.5 py-1 text-xs",
              sort === s.value
                ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
                : "border-line bg-surface text-ink-600",
            )}
          >
            {s.label}
          </button>
        ))}
        <span className="h-4 w-px shrink-0 bg-line" aria-hidden />
        <button
          type="button"
          onClick={() => setInStockOnly((v) => !v)}
          className={cn(
            "whitespace-nowrap rounded-pill border px-2.5 py-1 text-xs",
            inStockOnly
              ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
              : "border-line bg-surface text-ink-600",
          )}
        >
          In stock
        </button>
        <button
          type="button"
          onClick={() => setDiscountedOnly((v) => !v)}
          className={cn(
            "whitespace-nowrap rounded-pill border px-2.5 py-1 text-xs",
            discountedOnly
              ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
              : "border-line bg-surface text-ink-600",
          )}
        >
          On offer
        </button>
        <button
          type="button"
          onClick={() => setRxFilter((v) => (v === undefined ? false : v === false ? true : undefined))}
          className={cn(
            "whitespace-nowrap rounded-pill border px-2.5 py-1 text-xs",
            rxFilter !== undefined
              ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
              : "border-line bg-surface text-ink-600",
          )}
        >
          {rxFilter === undefined ? "Rx: all" : rxFilter ? "Rx only" : "No Rx"}
        </button>
      </div>

      {/* Shop by category — visual tiles (Category.imageUrl was fetched and
          discarded before). Shown only in the default browse state. */}
      {!category && !search && categories.length > 0 && (
        <div className="grid grid-cols-4 gap-3 px-4 pb-3">
          {categories.slice(0, 8).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.slug)}
              className="flex flex-col items-center gap-1"
            >
              <span className="h-14 w-14 overflow-hidden rounded-card border border-line bg-surface-2">
                {c.imageUrl ? (
                  // Plain img — external CDN URLs need no next/image remote config.
                  <img src={c.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-lg font-semibold text-primary-600">
                    {c.name.slice(0, 1)}
                  </span>
                )}
              </span>
              <span className="line-clamp-2 text-center text-[11px] leading-tight text-ink-600">
                {c.name}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="px-4 pb-6">
        {productsQuery.isError ? (
          <ErrorState message={(productsQuery.error as Error).message} onRetry={() => productsQuery.refetch()} />
        ) : productsQuery.isLoading ? (
          <ProductGridSkeleton count={8} />
        ) : products.length === 0 ? (
          <EmptyState title="No products found" hint="Try a different search or category." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              {products.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
            {/* Sentinel drives the next-page fetch; skeletons fill in while loading. */}
            <div ref={onSentinel} className="h-1" aria-hidden />
            {isFetchingNextPage && (
              <div className="mt-3">
                <ProductGridSkeleton count={2} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "whitespace-nowrap rounded-pill border px-3 py-1 text-sm",
        active
          ? "border-primary-600 bg-primary-600/10 font-medium text-primary-700"
          : "border-line bg-surface text-ink-600",
      )}
    >
      {children}
    </button>
  );
}
