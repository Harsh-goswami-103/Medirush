"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Category, ProductSummary } from "@medrush/contracts";
import { api, qs } from "@/lib/api";
import { useStore } from "@/lib/store";
import { ProductCard } from "@/components/shop";
import { NotificationBell } from "@/components/AppShell";
import { EmptyState, ErrorState, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";

export default function Home() {
  const { store } = useStore();
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search box so keystrokes don't fire a query each.
  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const catsQuery = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/v1/categories"),
    staleTime: 5 * 60_000,
  });
  const productsQuery = useQuery({
    queryKey: ["products", category ?? "", search],
    queryFn: () =>
      api.get<ProductSummary[]>(
        `/v1/products${qs({ category, search: search || undefined, limit: 50 })}`,
      ),
  });

  const categories = catsQuery.data?.data ?? [];
  const products = productsQuery.data?.data ?? [];

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
            onChange={(e) => {
              setRawSearch(e.target.value);
              setCategory(undefined);
            }}
          />
        </div>
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
            onClick={() => {
              setCategory(c.slug);
              setRawSearch("");
            }}
          >
            {c.name}
          </Chip>
        ))}
      </div>

      <div className="px-4 pb-6">
        {productsQuery.isError ? (
          <ErrorState message={(productsQuery.error as Error).message} onRetry={() => productsQuery.refetch()} />
        ) : productsQuery.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6 text-primary-600" />
          </div>
        ) : products.length === 0 ? (
          <EmptyState title="No products found" hint="Try a different search or category." />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
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
