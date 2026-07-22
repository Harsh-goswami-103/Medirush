"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Category, HealthConcern, ProductSort, ProductSummary } from "@medrush/contracts";
import { api, qs } from "@/lib/api";
import { useStore } from "@/lib/store";
import { ProductCard, ProductGridSkeleton } from "@/components/shop";
import { NotificationBell } from "@/components/AppShell";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { cn } from "@/lib/cn";
import { SectionHeader } from "./_components/section";
import { ConcernRail } from "./_components/concerns";
import { WishlistHeart, useWishlist } from "./_components/wishlist";

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

const PILL_BASE =
  "press inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-pill border text-xs font-semibold transition-colors";
const PILL_ON =
  "border-transparent bg-gradient-to-br from-primary-700 to-primary-900 text-white shadow-glow";
const PILL_OFF = "border-line bg-surface text-ink-600 shadow-sm";

export default function Home() {
  const { store, isLoading: storeLoading } = useStore();
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [concern, setConcern] = useState<HealthConcern | undefined>(undefined);
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
      concern?.slug ?? "",
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
          concern: concern?.slug,
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
  const pages = productsQuery.data?.pages ?? [];
  const products = pages.flatMap((p) => p.data);

  // One batched heart-state lookup per loaded page — see useWishlist.
  const wishlist = useWishlist(pages.map((p) => p.data.map((product) => product.id)));

  // Infinite-scroll sentinel: fetch the next page when it scrolls into view.
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = productsQuery;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onSentinel = useCallback((node: HTMLDivElement | null) => {
    sentinelRef.current = node;
  }, []);
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

  const browsingDefault = !category && !concern && !search;
  const filtersActive =
    Boolean(category || concern || search) ||
    sort !== undefined ||
    inStockOnly ||
    discountedOnly ||
    rxFilter !== undefined;

  function resetAll() {
    setCategory(undefined);
    setConcern(undefined);
    setRawSearch("");
    setSearch("");
    setSort(undefined);
    setInStockOnly(false);
    setDiscountedOnly(false);
    setRxFilter(undefined);
  }

  const activeCategoryName = categories.find((c) => c.slug === category)?.name;
  const resultsTitle = search
    ? `Results for “${search}”`
    : (concern?.name ?? activeCategoryName ?? "Popular right now");

  return (
    <div className="pb-6">
      <header className="bg-mesh px-4 pb-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-primary-700">
              <BoltIcon />
              Delivery in ~40 min
            </p>
            {storeLoading && !store ? (
              <Skeleton className="mt-1.5 h-5 w-40 rounded" />
            ) : (
              <h1 className="mt-0.5 flex items-center gap-1.5 text-lg font-bold tracking-tight text-ink-900">
                <PinIcon />
                <span className="truncate">{store?.name ?? "MedRush"}</span>
              </h1>
            )}
            {store?.address && <p className="truncate text-xs text-ink-600">{store.address}</p>}
          </div>
          <NotificationBell />
        </div>

        {store && !store.isOpen && (
          <p className="mt-3 flex items-start gap-2 rounded-xl2 border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-semibold text-ink-900">
            <WarnIcon />
            <span>
              Store is currently closed. You can browse now — orders open at {store.openTime}.
            </span>
          </p>
        )}

        <div className="relative mt-3.5">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400">
            <SearchIcon />
          </span>
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label="Search medicines and health products"
            className="glass w-full rounded-xl2 py-3 pl-10 pr-11 text-sm text-ink-900 shadow-card2 outline-none placeholder:text-ink-400 [&::-webkit-search-cancel-button]:appearance-none"
            placeholder="Search medicines & health products"
            value={rawSearch}
            // Keep the category — the API supports search WITHIN a category.
            onChange={(e) => setRawSearch(e.target.value)}
          />
          {rawSearch !== "" && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setRawSearch("")}
              className="press absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full text-ink-400"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {/* Recent searches — tap to re-run; hidden while typing. */}
        {rawSearch === "" && recents.length > 0 && (
          <div className="no-scrollbar mt-2.5 flex items-center gap-2 overflow-x-auto">
            {recents.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => setRawSearch(term)}
                className="press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border border-line bg-surface/80 px-3 text-xs font-medium text-ink-600 shadow-sm"
              >
                <ClockIcon />
                {term}
              </button>
            ))}
            <button
              type="button"
              onClick={clearRecents}
              className="press min-h-11 shrink-0 px-2 text-xs font-semibold text-primary-700"
            >
              Clear
            </button>
          </div>
        )}
      </header>

      <nav aria-label="Categories" className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-3">
        <FilterPill
          active={browsingDefault}
          onClick={resetAll}
          className="px-4 text-sm"
          label="All products"
        >
          All
        </FilterPill>
        {catsQuery.isLoading &&
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11 w-24 rounded-pill" />)}
        {categories.map((c) => (
          <FilterPill
            key={c.id}
            active={category === c.slug}
            className="px-4 text-sm"
            // Keep any active search — it now filters within the category.
            onClick={() => setCategory(category === c.slug ? undefined : c.slug)}
          >
            {c.name}
          </FilterPill>
        ))}
      </nav>

      {/* Offers strip → /offers deals surface. */}
      <Reveal className="px-4 pb-4">
        <Link
          href="/offers"
          className="press flex items-center gap-3 rounded-xl2 border border-accent/25 bg-gradient-to-r from-accent/20 via-accent/10 to-accent/5 px-3.5 py-3 shadow-card2"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent/20 text-accent">
            <TagIcon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-ink-900">Offers &amp; coupon codes</span>
            <span className="block truncate text-xs text-ink-600">
              Save more on every order — live deals inside
            </span>
          </span>
          <span className="shrink-0 text-xs font-bold text-primary-700">View all →</span>
        </Link>
      </Reveal>

      <ConcernRail activeSlug={concern?.slug} onSelect={setConcern} />

      {/* Shop by category — visual tiles (Category.imageUrl was fetched and
          discarded before). Shown only in the default browse state. */}
      {browsingDefault && categories.length > 0 && (
        <Reveal as="section" className="pb-4">
          <SectionHeader title="Shop by category" hint="Everyday essentials, sorted" />
          <ul className="grid grid-cols-4 gap-3 px-4">
            {categories.slice(0, 8).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setCategory(c.slug)}
                  className="press flex w-full flex-col items-center gap-1.5"
                >
                  <span className="grid h-16 w-16 place-items-center overflow-hidden rounded-xl2 bg-primary-50 shadow-card2 ring-1 ring-primary-100">
                    {c.imageUrl ? (
                      // Plain img — external CDN URLs need no next/image remote config.
                      <img src={c.imageUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-lg font-bold text-primary-700">
                        {c.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 text-center text-[11px] font-medium leading-tight text-ink-600">
                    {c.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Reveal>
      )}

      <section>
        <SectionHeader
          title={resultsTitle}
          hint={
            productsQuery.isLoading
              ? "Loading…"
              : `${products.length}${hasNextPage ? "+" : ""} product${products.length === 1 ? "" : "s"}`
          }
          action={
            filtersActive ? (
              <button
                type="button"
                onClick={resetAll}
                className="press rounded-pill px-2 py-1 text-xs font-semibold text-primary-700"
              >
                Clear all
              </button>
            ) : undefined
          }
        />

        {/* Sort + quick filters — server-side via the extended products query. */}
        <div
          role="group"
          aria-label="Sort and filter products"
          className="no-scrollbar flex items-center gap-2 overflow-x-auto px-4 pb-3"
        >
          {SORTS.map((s) => (
            <FilterPill
              key={s.label}
              active={sort === s.value}
              onClick={() => setSort(s.value)}
              className="px-3.5"
            >
              {s.label}
            </FilterPill>
          ))}
          <span className="h-5 w-px shrink-0 bg-line" aria-hidden />
          <FilterPill
            active={inStockOnly}
            onClick={() => setInStockOnly((v) => !v)}
            className="px-3.5"
          >
            In stock
          </FilterPill>
          <FilterPill
            active={discountedOnly}
            onClick={() => setDiscountedOnly((v) => !v)}
            className="px-3.5"
          >
            On offer
          </FilterPill>
          <FilterPill
            active={rxFilter !== undefined}
            onClick={() =>
              setRxFilter((v) => (v === undefined ? false : v === false ? true : undefined))
            }
            className="px-3.5"
          >
            {rxFilter === undefined ? "Rx: all" : rxFilter ? "Rx only" : "No Rx"}
          </FilterPill>
        </div>

        <p aria-live="polite" className="sr-only">
          {productsQuery.isLoading
            ? "Loading products"
            : `${products.length} products shown for ${resultsTitle}`}
        </p>

        <div className="px-4">
          {productsQuery.isError ? (
            <ErrorState
              message={(productsQuery.error as Error).message}
              onRetry={() => productsQuery.refetch()}
            />
          ) : productsQuery.isLoading ? (
            <ProductGridSkeleton count={8} />
          ) : products.length === 0 ? (
            <EmptyState
              title="No products found"
              hint="Try a different search, category or health concern."
              icon={<SearchIcon className="h-8 w-8" />}
              action={
                filtersActive ? (
                  <Button variant="secondary" className="w-full" onClick={resetAll}>
                    Clear all filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3">
                {products.map((p) => (
                  <li key={p.id} className="relative grid">
                    <ProductCard product={p} />
                    <WishlistHeart
                      productId={p.id}
                      productName={p.name}
                      controller={wishlist}
                    />
                  </li>
                ))}
              </ul>
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
      </section>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  className,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  /** Accessible name when the visible text is an abbreviation (e.g. "All"). */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(PILL_BASE, active ? PILL_ON : PILL_OFF, className)}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- glyphs */

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 text-primary-600"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-[18px] w-[18px]", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 text-ink-400"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.6 13.4 12 4.8H4.8V12l8.6 8.6a1.7 1.7 0 0 0 2.4 0l4.8-4.8a1.7 1.7 0 0 0 0-2.4Z" />
      <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mt-px h-4 w-4 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.3 3.9 1.8 18.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
