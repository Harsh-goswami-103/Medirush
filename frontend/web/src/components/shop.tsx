"use client";

import Link from "next/link";
import type { ProductSummary } from "@medrush/contracts";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Skeleton } from "@/components/ui";

/** Square product image with a graceful placeholder (many dev products have none). */
export function ProductImage({ url, name, className }: { url: string | null; name: string; className?: string }) {
  if (url) {
    // Plain img — external CDN URLs need no next/image remote config.
    return <img src={url} alt={name} className={cn("h-full w-full object-cover", className)} />;
  }
  return (
    <div className={cn("flex h-full w-full items-center justify-center bg-surface-2 text-lg font-semibold text-ink-400", className)}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** Add button that becomes a −/+ stepper once the item is in the cart. */
export function AddOrStepper({ product, block }: { product: ProductSummary; block?: boolean }) {
  const { user } = useAuth();
  const { qtyOf, setItem } = useCart();
  const qty = qtyOf(product.id);

  if (!product.inStock) {
    return <span className="rounded-input px-2 py-1 text-xs font-medium text-ink-400">Out of stock</span>;
  }
  if (!user) {
    return (
      <Link
        href="/login"
        className={cn(
          "rounded-input border border-primary-600 px-3 py-1 text-sm font-medium text-primary-700",
          block && "w-full text-center",
        )}
      >
        Add
      </Link>
    );
  }
  if (qty === 0) {
    return (
      <button
        onClick={() => setItem.mutate({ productId: product.id, qty: 1 })}
        disabled={setItem.isPending}
        className={cn(
          "rounded-input border border-primary-600 px-3 py-1 text-sm font-medium text-primary-700 disabled:opacity-60",
          block && "w-full",
        )}
      >
        Add
      </button>
    );
  }
  return (
    <div className={cn("flex items-center gap-2 rounded-input bg-primary-600 text-white", block ? "justify-between px-3 py-1.5" : "px-1")}>
      <button aria-label="Decrease" className="px-1.5 text-lg leading-none" onClick={() => setItem.mutate({ productId: product.id, qty: qty - 1 })}>
        −
      </button>
      <span className="min-w-4 text-center text-sm font-semibold tabular-nums">{qty}</span>
      <button
        aria-label="Increase"
        className="px-1.5 text-lg leading-none disabled:opacity-50"
        disabled={qty >= product.maxPerOrder}
        onClick={() => setItem.mutate({ productId: product.id, qty: Math.min(qty + 1, product.maxPerOrder) })}
      >
        +
      </button>
    </div>
  );
}

/** Grid product card. */
export function ProductCard({ product }: { product: ProductSummary }) {
  const discounted = product.mrpPaise > product.pricePaise;
  return (
    <div className="flex flex-col rounded-card border border-line bg-surface p-2">
      <Link href={`/p/${product.slug}`} className="block">
        <div className="relative aspect-square overflow-hidden rounded-input">
          <ProductImage url={product.imageUrl} name={product.name} />
          {product.requiresRx && (
            <span className="absolute left-1 top-1">
              <Badge tone="violet">Rx</Badge>
            </span>
          )}
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-ink-900">{product.name}</p>
        <p className="text-xs text-ink-400">{product.packSize}</p>
      </Link>
      <div className="mt-auto flex items-end justify-between pt-1.5">
        <div className="leading-tight">
          <span className="text-sm font-semibold text-ink-900">{formatPaise(product.pricePaise)}</span>
          {discounted && (
            <span className="ml-1 text-xs text-ink-400 line-through">{formatPaise(product.mrpPaise)}</span>
          )}
        </div>
        <AddOrStepper product={product} />
      </div>
    </div>
  );
}

/** Loading placeholder that mirrors {@link ProductCard} to keep CLS≈0 (§20.4). */
export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col rounded-card border border-line bg-surface p-2">
      <Skeleton className="aspect-square rounded-input" />
      <Skeleton className="mt-2 h-3.5 w-11/12 rounded" />
      <Skeleton className="mt-1 h-3 w-1/2 rounded" />
      <div className="mt-auto flex items-end justify-between pt-2">
        <Skeleton className="h-4 w-14 rounded" />
        <Skeleton className="h-7 w-12 rounded-input" />
      </div>
    </div>
  );
}

/** A 2-column grid of card skeletons for first-load / pagination states. */
export function ProductGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  );
}
