"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Product, ProductSummary } from "@medrush/contracts";
import { api, ApiError } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { formatPaise } from "@/lib/format";
import { TopBar } from "@/components/AppShell";
import { AddOrStepper, ProductImage } from "@/components/shop";
import { Badge, EmptyState, ErrorState, Spinner } from "@/components/ui";

export default function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { qtyOf } = useCart();

  const productQuery = useQuery({
    queryKey: ["product", slug],
    queryFn: () => api.get<Product>(`/v1/products/${encodeURIComponent(slug)}`),
  });

  const product = productQuery.data?.data;
  const error = productQuery.error;

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
  if (error instanceof ApiError && error.code === "NOT_FOUND") {
    return (
      <div>
        <TopBar title="Not found" back />
        <div className="p-4">
          <EmptyState title="Product not found" hint="This item may no longer be available." />
          <Link
            href="/"
            className="mt-4 inline-flex w-full items-center justify-center rounded-input bg-primary-600 px-3.5 py-2 text-sm font-medium text-white"
          >
            Browse products
          </Link>
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
            message={error instanceof Error ? error.message : "Could not load this product"}
            onRetry={() => productQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const discounted = product.mrpPaise > product.pricePaise;
  const heroUrl = product.images[0] ?? product.imageUrl;
  const inCart = qtyOf(product.id) > 0;

  return (
    <div>
      <TopBar title={product.name} back />

      <div className="px-4 pb-40">
        <div className="mt-3 aspect-square w-full overflow-hidden rounded-card border border-line bg-surface">
          <ProductImage url={heroUrl} name={product.name} />
        </div>

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
        </div>
        <p className="mt-1 text-xs text-ink-400">Incl. GST {product.gstRatePct}%</p>

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
      </div>

      {/* Sticky action bar — sits above the bottom tab nav (clears it via bottom-16). */}
      <div className="fixed bottom-16 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
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
      </div>
    </div>
  );
}
