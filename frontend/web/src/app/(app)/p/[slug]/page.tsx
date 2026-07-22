"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Category, Product, ProductSummary, StockAlertStatus } from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { AddOrStepper, ProductCard, ProductImage } from "@/components/shop";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

export default function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { user } = useAuth();
  const { qtyOf } = useCart();
  const qc = useQueryClient();
  const toast = useToast();
  const [imgIdx, setImgIdx] = useState(0);

  const productQuery = useQuery({
    queryKey: ["product", slug],
    queryFn: () => api.get<Product>(`/v1/products/${encodeURIComponent(slug)}`),
  });
  const product = productQuery.data?.data;

  // Same-salt substitutes (server endpoint, Rx-parity enforced).
  const substitutesQuery = useQuery({
    queryKey: ["substitutes", slug],
    queryFn: () => api.get<ProductSummary[]>(`/v1/products/${encodeURIComponent(slug)}/substitutes`),
    enabled: Boolean(product),
    staleTime: 60_000,
  });
  const substitutes = substitutesQuery.data?.data ?? [];

  // Back-in-stock alert state — only meaningful for a signed-in user on an OOS product.
  const stockAlertEnabled = Boolean(user && product && !product.inStock);
  const stockAlertQuery = useQuery({
    queryKey: ["stock-alert", slug],
    queryFn: () =>
      api.get<StockAlertStatus>(`/v1/products/${encodeURIComponent(slug)}/stock-alert`),
    enabled: stockAlertEnabled,
  });
  const subscribed = stockAlertQuery.data?.data.subscribed ?? false;

  const toggleAlert = useMutation({
    mutationFn: () =>
      subscribed
        ? api.del<StockAlertStatus>(`/v1/products/${encodeURIComponent(slug)}/stock-alert`)
        : api.post<StockAlertStatus>(`/v1/products/${encodeURIComponent(slug)}/stock-alert`),
    onSuccess: (res) => {
      qc.setQueryData(["stock-alert", slug], res);
      toast.push({
        type: "success",
        message: res.data.subscribed
          ? "We'll notify you when it's back"
          : "Alert removed",
      });
    },
    onError: () => toast.push({ type: "error", message: "Couldn't update the alert — try again" }),
  });

  // "Similar products" — the product carries a categoryId (not a slug), so map
  // it through the categories list to the slug the products endpoint expects.
  // Both endpoints already exist; no backend work.
  const catsQuery = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/v1/categories"),
    staleTime: 5 * 60_000,
  });
  const categorySlug = product
    ? catsQuery.data?.data.find((c) => c.id === product.categoryId)?.slug
    : undefined;
  const similarQuery = useQuery({
    queryKey: ["similar", categorySlug ?? ""],
    queryFn: () => api.get<ProductSummary[]>(`/v1/products${qs({ category: categorySlug, limit: 12 })}`),
    enabled: Boolean(categorySlug),
    staleTime: 60_000,
  });
  const similar = (similarQuery.data?.data ?? []).filter((p) => p.id !== product?.id).slice(0, 10);

  if (productQuery.isLoading) {
    return (
      <div>
        <TopBar title="Product" back />
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
        </div>
      </div>
    );
  }

  // 404 → friendly empty state (the slug doesn't resolve to a live product).
  if (productQuery.error instanceof ApiError && productQuery.error.code === "NOT_FOUND") {
    return (
      <div>
        <TopBar title="Not found" back />
        <div className="p-4">
          <EmptyState
            title="Product not found"
            hint="This item may no longer be available."
            action={
              <Link
                href="/"
                className="inline-flex w-full items-center justify-center rounded-input bg-primary-600 px-3.5 py-2 text-sm font-medium text-white"
              >
                Browse products
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  if (productQuery.isError || !product) {
    return (
      <div>
        <TopBar title="Product" back />
        <div className="p-4">
          <ErrorState
            message={productQuery.error instanceof Error ? productQuery.error.message : "Could not load this product"}
            onRetry={() => productQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const discounted = product.mrpPaise > product.pricePaise;
  const discountPct = discounted
    ? Math.round(((product.mrpPaise - product.pricePaise) / product.mrpPaise) * 100)
    : 0;
  // Gallery sources: full images[] when present, else the single summary image.
  const gallery = product.images.length > 0 ? product.images : product.imageUrl ? [product.imageUrl] : [];
  const heroUrl = gallery[imgIdx] ?? gallery[0] ?? null;
  const inCart = qtyOf(product.id) > 0;

  const shareName = product.name; // `product` is narrowed here; capture for the async closure below
  async function share() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const data = { title: shareName, text: `${shareName} on MedRush`, url };
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share(data);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        toast.push({ type: "success", message: "Link copied to clipboard" });
      }
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }

  return (
    <div>
      <TopBar
        title={product.name}
        back
        right={
          <button
            type="button"
            onClick={() => void share()}
            aria-label="Share product"
            className="-mr-1 shrink-0 p-1 text-ink-600"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
            </svg>
          </button>
        }
      />

      <div className="px-4 pb-40">
        {/* Image gallery — main image + thumbnail strip when there are several. */}
        <div className="relative mt-3 aspect-square w-full overflow-hidden rounded-card border border-line bg-surface">
          <ProductImage url={heroUrl} name={product.name} />
          {discounted && (
            <span className="absolute left-2 top-2 rounded-pill bg-accent px-2 py-0.5 text-xs font-semibold text-white">
              {discountPct}% OFF
            </span>
          )}
        </div>
        {gallery.length > 1 && (
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {gallery.map((url, i) => (
              <button
                key={url}
                type="button"
                onClick={() => setImgIdx(i)}
                aria-label={`View image ${i + 1}`}
                className={cn(
                  "h-14 w-14 shrink-0 overflow-hidden rounded-input border-2",
                  i === imgIdx ? "border-primary-600" : "border-line",
                )}
              >
                <ProductImage url={url} name={product.name} />
              </button>
            ))}
          </div>
        )}

        <div className="mt-4">
          <h1 className="text-lg font-semibold leading-snug text-ink-900">{product.name}</h1>
          {product.brand && <p className="mt-0.5 text-sm text-ink-600">{product.brand}</p>}
          <p className="text-xs text-ink-400">{product.packSize}</p>
        </div>

        {(product.requiresRx || product.isColdChain) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {product.requiresRx && <Badge tone="violet">Rx</Badge>}
            {product.isColdChain && <Badge tone="blue">Cold chain</Badge>}
          </div>
        )}

        <div className="mt-4 flex items-end gap-2">
          <span className="text-2xl font-bold text-ink-900">{formatPaise(product.pricePaise)}</span>
          {discounted && (
            <span className="pb-0.5 text-sm text-ink-400 line-through">{formatPaise(product.mrpPaise)}</span>
          )}
          {discounted && <span className="pb-0.5 text-sm font-medium text-success">{discountPct}% off</span>}
        </div>
        <p className="mt-1 text-xs text-ink-400">Incl. GST {product.gstRatePct}%</p>

        {/* Out of stock → back-in-stock alert (signed-in) or sign-in nudge. */}
        {product.inStock === false && (
          <div className="mt-4 rounded-card border border-warning/30 bg-warning/5 px-3 py-3">
            <p className="text-sm font-semibold text-warning">Currently out of stock</p>
            {user ? (
              <Button
                variant="secondary"
                className="mt-2 w-full"
                loading={toggleAlert.isPending || (stockAlertEnabled && stockAlertQuery.isLoading)}
                onClick={() => toggleAlert.mutate()}
              >
                {subscribed ? "✓ We'll notify you — tap to cancel" : "Notify me when it's back"}
              </Button>
            ) : (
              <Link
                href="/login"
                className="mt-2 block rounded-input border border-primary-600 px-3.5 py-2 text-center text-sm font-medium text-primary-700"
              >
                Sign in to get a back-in-stock alert
              </Link>
            )}
          </div>
        )}

        {/* Rx explanatory banner — reduces checkout drop-off by setting the
            expectation upfront that a prescription is needed (§18.1). */}
        {product.requiresRx && (
          <div className="mt-4 rounded-card border border-rx/20 bg-rx/5 px-3 py-3">
            <p className="text-sm font-semibold text-rx">Prescription required</p>
            <p className="mt-1 text-sm text-ink-600">
              This is a prescription medicine. You can add it to your cart now and upload a valid
              prescription after placing the order — our pharmacist will verify it before dispatch.
            </p>
          </div>
        )}

        {product.composition && (
          <div className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Composition</h2>
            <p className="mt-1 text-sm text-ink-900">{product.composition}</p>
          </div>
        )}

        {product.description && (
          <div className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">Description</h2>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-600">
              {product.description}
            </p>
          </div>
        )}

        {/* Same-salt substitutes — the §17 v1.1 generics play; price-led. */}
        {substitutes.length > 0 && (
          <div className="mt-6">
            <h2 className="mb-1 text-sm font-semibold text-ink-900">
              Substitutes with the same salt
            </h2>
            <p className="mb-2 text-xs text-ink-400">
              Same composition ({product.composition}) — always confirm with your doctor before
              switching.
            </p>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4">
              {substitutes.map((p) => (
                <div key={p.id} className="w-36 shrink-0">
                  <ProductCard product={p} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Similar products rail — same category (substitutes excluded). */}
        {similar.filter((p) => !substitutes.some((s) => s.id === p.id)).length > 0 && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-ink-900">Similar products</h2>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4">
              {similar
                .filter((p) => !substitutes.some((s) => s.id === p.id))
                .map((p) => (
                  <div key={p.id} className="w-36 shrink-0">
                    <ProductCard product={p} />
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Sticky action bar — sits above the bottom tab nav (clears it via bottom-16).
          data-testid anchors e2e: rails above add sibling "Add" buttons, so the
          specs must scope to THIS bar's button. */}
      <div
        data-testid="pdp-action-bar"
        className="fixed bottom-16 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <AddOrStepper product={product as ProductSummary} block />
          </div>
          {inCart && (
            <Link
              href="/cart"
              className="whitespace-nowrap rounded-input bg-primary-600 px-4 py-2 text-sm font-medium text-white"
            >
              Go to cart
            </Link>
          )}
        </div>
        {product.inStock && product.maxPerOrder <= 10 && (
          <p className="mt-1 text-center text-[11px] text-ink-400">
            Max {product.maxPerOrder} per order
          </p>
        )}
      </div>
    </div>
  );
}
