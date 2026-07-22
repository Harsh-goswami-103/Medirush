"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cart, CartItem, WishlistEntry, WishlistStatus } from "@medrush/contracts";
import { api, ApiError, apiErrorMessage, type Envelope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { useStore } from "@/lib/store";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { ProductImage } from "@/components/shop";
import { Reveal } from "@/components/motion";
import { useToast } from "@/components/toast";

/** Teal-gradient CTA. `disabled:bg-none` lets the Button's disabled colour win. */
const CTA =
  "press bg-gradient-to-r from-primary-600 to-primary-500 shadow-glow hover:from-primary-700 hover:to-primary-600 disabled:bg-none disabled:shadow-none";

export default function CartPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, loading } = useAuth();
  const { cart, isLoading, isError, error, refetch, setItem, itemCount } = useCart();
  const { store } = useStore();
  const toast = useToast();

  // Auth gate — this screen is customer-only.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  /* ------------------------------------------------------------- wishlist */

  const wishlistQuery = useQuery({
    queryKey: ["wishlist"],
    queryFn: () => api.get<WishlistEntry[]>("/v1/wishlist"),
    enabled: Boolean(user),
  });
  const saved = wishlistQuery.data?.data ?? [];
  // A 404 means this deployment has no wishlist yet — a secondary shelf must not
  // shout about that on the cart; any other failure is worth a retry affordance.
  const wishlistUnavailable =
    wishlistQuery.error instanceof ApiError && wishlistQuery.error.status === 404;

  /** Save for later = wishlist the product, then drop the cart line. */
  const saveForLater = useMutation({
    mutationFn: async (productId: string) => {
      await api.post<WishlistStatus>("/v1/wishlist", { productId });
      return api.del<Cart>(`/v1/cart/items/${productId}`);
    },
    onSuccess: (res) => {
      qc.setQueryData<Envelope<Cart>>(["cart"], res);
      void qc.invalidateQueries({ queryKey: ["wishlist"] });
      toast.push({ type: "success", message: "Saved for later" });
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Couldn't save that item") }),
  });

  const moveToCart = useMutation({
    mutationFn: async (productId: string) => {
      const res = await api.put<Cart>("/v1/cart/items", { productId, qty: 1 });
      // The cart line is what the customer asked for; a failed wishlist cleanup
      // must not read as a failed move (the refetch below reconciles the shelf).
      await api.del<WishlistStatus>(`/v1/wishlist/${productId}`).catch(() => undefined);
      return res;
    },
    onSuccess: (res) => {
      qc.setQueryData<Envelope<Cart>>(["cart"], res);
      void qc.invalidateQueries({ queryKey: ["wishlist"] });
      toast.push({ type: "success", message: "Moved to cart" });
    },
    onError: (err) =>
      toast.push({ type: "error", message: apiErrorMessage(err, "Couldn't move that item") }),
  });

  // Set a line to exactly `qty` (0 removes). Surface any failure via toast.
  const changeQty = (productId: string, qty: number) =>
    setItem.mutate(
      { productId, qty },
      {
        onError: (err) =>
          toast.push({ type: "error", message: apiErrorMessage(err, "Couldn't update your cart") }),
      },
    );

  // Auth still resolving, or redirect in flight.
  if (loading || !user) {
    return (
      <div className="min-h-dvh bg-mesh">
        <TopBar title="Cart" />
        <div className="p-4">
          <CartSkeleton />
        </div>
      </div>
    );
  }

  const items = cart?.items ?? [];
  const isEmpty = items.length === 0;

  // Delivery-fee & min-order thresholds come straight off the public store
  // config — the values were already on the wire (§17 v1 free-delivery bar +
  // min-order nudge); the cart just never surfaced them.
  const itemsPaise = cart?.itemsPaise ?? 0;
  const minOrderPaise = store?.minOrderPaise ?? 0;
  const freeAbovePaise = store?.freeDeliveryAbovePaise ?? 0;
  const belowMin = !isEmpty && minOrderPaise > 0 && itemsPaise < minOrderPaise;
  const toMinPaise = Math.max(0, minOrderPaise - itemsPaise);
  const hasOutOfStock = items.some((i) => !i.product.inStock);

  return (
    <div className="min-h-dvh bg-mesh pb-2">
      <TopBar
        title="Cart"
        right={
          itemCount > 0 ? (
            <span className="rounded-pill bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-800">
              {itemCount} {itemCount === 1 ? "item" : "items"}
            </span>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="p-4">
          <CartSkeleton />
        </div>
      ) : isError ? (
        <div className="p-4">
          <ErrorState
            message={error instanceof Error ? error.message : "Couldn't load your cart"}
            onRetry={() => refetch()}
          />
        </div>
      ) : (
        <>
          <div className="space-y-3 p-4 pb-44">
            {isEmpty ? (
              <EmptyState
                icon={<CartGlyph />}
                title="Your cart is empty"
                hint="Add medicines and essentials — we deliver in minutes."
                action={
                  <Link href="/shop" className="block">
                    <Button className={cn("w-full", CTA)}>Browse products</Button>
                  </Link>
                }
              />
            ) : (
              <>
                {cart?.requiresRx && (
                  <div className="flex items-start gap-2.5 rounded-xl2 border border-rx/20 bg-rx/5 px-3.5 py-3 shadow-sm">
                    <RxGlyph />
                    <p className="text-sm text-rx">
                      This order needs a prescription — you can attach one from your locker at
                      checkout, or upload it after placing the order.
                    </p>
                  </div>
                )}

                {hasOutOfStock && (
                  <div
                    className="rounded-xl2 border border-danger/20 bg-danger/5 px-3.5 py-3 text-sm font-medium text-danger"
                    role="status"
                  >
                    Some items are out of stock. Remove or save them for later to continue.
                  </div>
                )}

                {freeAbovePaise > 0 && (
                  <FreeDeliveryBar itemsPaise={itemsPaise} thresholdPaise={freeAbovePaise} />
                )}

                <ul className="space-y-2.5">
                  {items.map((item) => (
                    <CartLine
                      key={item.productId}
                      item={item}
                      busy={setItem.isPending}
                      savingId={saveForLater.isPending ? (saveForLater.variables ?? null) : null}
                      onQty={changeQty}
                      onSave={(id) => saveForLater.mutate(id)}
                    />
                  ))}
                </ul>

                <div className="rounded-xl2 glass px-3.5 py-3 shadow-card2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-ink-600">Subtotal</span>
                    <span className="text-base font-semibold tabular-nums text-ink-900">
                      {formatPaise(itemsPaise)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-600">
                    Delivery &amp; taxes are calculated at checkout.
                  </p>
                </div>
              </>
            )}

            {/* ------------------------------------------- saved for later */}
            <SavedForLater
              entries={saved}
              isLoading={wishlistQuery.isLoading}
              isError={wishlistQuery.isError && !wishlistUnavailable}
              onRetry={() => void wishlistQuery.refetch()}
              movingId={moveToCart.isPending ? (moveToCart.variables ?? null) : null}
              onMove={(id) => moveToCart.mutate(id)}
            />
          </div>

          {/* Sticky action bar — sits above the bottom tab nav (bottom-16). */}
          <div className="fixed bottom-16 left-1/2 z-40 w-full max-w-md -translate-x-1/2 glass px-4 py-3 shadow-[0_-8px_28px_rgba(15,23,42,0.10)]">
            {belowMin && (
              <p
                className="mb-2 rounded-pill bg-warning/10 px-3 py-1.5 text-center text-xs font-semibold text-warning"
                aria-live="polite"
              >
                Add {formatPaise(toMinPaise)} more to reach the {formatPaise(minOrderPaise)} minimum
                order
              </p>
            )}
            <div className="flex items-center gap-3">
              <div className="min-w-0">
                <p className="text-xs text-ink-600">Subtotal</p>
                <p className="text-base font-semibold tabular-nums text-ink-900">
                  {formatPaise(itemsPaise)}
                </p>
              </div>
              <div className="ml-auto flex-1">
                {isEmpty || belowMin ? (
                  <Button className="w-full" disabled>
                    {belowMin ? `Add ${formatPaise(toMinPaise)} to checkout` : "Proceed to checkout"}
                  </Button>
                ) : (
                  <Link href="/checkout" className="block">
                    <Button className={cn("w-full", CTA)}>Proceed to checkout</Button>
                  </Link>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================== line item */

function CartLine({
  item,
  busy,
  savingId,
  onQty,
  onSave,
}: {
  item: CartItem;
  busy: boolean;
  savingId: string | null;
  onQty: (productId: string, qty: number) => void;
  onSave: (productId: string) => void;
}) {
  const { product } = item;
  const saving = savingId === item.productId;
  const mrpTotal = product.mrpPaise * item.qty;
  const discounted = mrpTotal > item.lineTotalPaise;

  return (
    <li className="glass rounded-xl2 p-3 shadow-card2">
      <div className="flex gap-3">
        <Link
          href={`/p/${product.slug}`}
          className="press h-[72px] w-[72px] shrink-0 overflow-hidden rounded-card bg-surface-2 ring-1 ring-line"
          tabIndex={-1}
          aria-hidden
        >
          <ProductImage url={product.imageUrl} name={product.name} />
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link
                href={`/p/${product.slug}`}
                className="press line-clamp-2 text-sm font-semibold leading-snug text-ink-900"
              >
                {product.name}
              </Link>
              <p className="mt-0.5 text-xs text-ink-600">{product.packSize}</p>
              {product.requiresRx && (
                <span className="mt-1 inline-flex">
                  <Badge tone="violet">Rx</Badge>
                </span>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold tabular-nums text-ink-900">
                {formatPaise(item.lineTotalPaise)}
              </p>
              {discounted && (
                <p className="text-[11px] tabular-nums text-ink-400 line-through">
                  {formatPaise(mrpTotal)}
                </p>
              )}
            </div>
          </div>

          {!product.inStock && (
            <p className="mt-1.5 text-xs font-semibold text-danger">
              Out of stock — remove it or save it for later
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <div className="flex items-center rounded-pill bg-gradient-to-r from-primary-600 to-primary-500 text-white shadow-glow">
              <button
                type="button"
                aria-label={`Decrease quantity of ${product.name}`}
                className="press flex h-11 w-11 items-center justify-center rounded-pill text-xl leading-none disabled:opacity-50"
                disabled={busy || saving}
                onClick={() => onQty(item.productId, item.qty - 1)}
              >
                −
              </button>
              <span
                className="min-w-5 text-center text-sm font-semibold tabular-nums"
                aria-live="polite"
                aria-label={`Quantity ${item.qty}`}
              >
                {item.qty}
              </span>
              <button
                type="button"
                aria-label={`Increase quantity of ${product.name}`}
                className="press flex h-11 w-11 items-center justify-center rounded-pill text-xl leading-none disabled:opacity-50"
                disabled={busy || saving || !product.inStock || item.qty >= product.maxPerOrder}
                onClick={() => onQty(item.productId, Math.min(item.qty + 1, product.maxPerOrder))}
              >
                +
              </button>
            </div>

            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="press inline-flex min-h-[44px] items-center gap-1.5 rounded-pill px-2.5 text-xs font-semibold text-primary-700 hover:bg-primary-50 disabled:opacity-50"
                disabled={busy || saving}
                onClick={() => onSave(item.productId)}
              >
                <HeartGlyph />
                {saving ? "Saving…" : "Save for later"}
              </button>
              <button
                type="button"
                className="press inline-flex min-h-[44px] items-center rounded-pill px-2.5 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
                disabled={busy || saving}
                onClick={() => onQty(item.productId, 0)}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/* ========================================================= saved for later */

function SavedForLater({
  entries,
  isLoading,
  isError,
  onRetry,
  movingId,
  onMove,
}: {
  entries: WishlistEntry[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  movingId: string | null;
  onMove: (productId: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="pt-2">
        <Skeleton className="h-4 w-32 rounded" />
        <div className="mt-2 space-y-2">
          <Skeleton className="h-16 rounded-xl2" />
          <Skeleton className="h-16 rounded-xl2" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-2 flex items-center justify-between gap-3 rounded-xl2 border border-line bg-surface px-3.5 py-3">
        <p className="text-xs text-ink-600">Couldn’t load your saved items.</p>
        <button
          type="button"
          onClick={onRetry}
          className="press min-h-[44px] shrink-0 px-2 text-xs font-semibold text-primary-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (entries.length === 0) return null;

  return (
    <Reveal as="section" className="pt-4">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-ink-900">Saved for later</h2>
        <span className="text-xs text-ink-600">{entries.length} saved</span>
      </div>
      <ul className="space-y-2">
        {entries.map((entry) => {
          const p = entry.product;
          const moving = movingId === p.id;
          return (
            <li key={entry.id} className="glass flex items-center gap-3 rounded-xl2 p-2.5 shadow-sm">
              <Link
                href={`/p/${p.slug}`}
                className="press h-12 w-12 shrink-0 overflow-hidden rounded-card bg-surface-2 ring-1 ring-line"
                tabIndex={-1}
                aria-hidden
              >
                <ProductImage url={p.imageUrl} name={p.name} />
              </Link>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/p/${p.slug}`}
                  className="press line-clamp-1 text-sm font-medium text-ink-900"
                >
                  {p.name}
                </Link>
                <p className="text-xs tabular-nums text-ink-600">
                  {formatPaise(p.pricePaise)}
                  {!p.inStock && <span className="ml-1.5 text-danger">Out of stock</span>}
                </p>
              </div>
              <Button
                variant="secondary"
                className="press min-h-[44px] shrink-0 border-primary-600/30 text-primary-700"
                loading={moving}
                disabled={!p.inStock}
                onClick={() => onMove(p.id)}
              >
                {p.inStock ? "Move to cart" : "Unavailable"}
              </Button>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}

/* ====================================================== free-delivery bar */

/**
 * Progress toward free delivery (§17 v1). Reads the store's
 * `freeDeliveryAbovePaise` threshold vs the current item subtotal and shows how
 * much more unlocks free delivery — a proven basket-nudge. The fill animates
 * from 0 on mount and on every subtotal change (reduced motion strips it).
 */
function FreeDeliveryBar({
  itemsPaise,
  thresholdPaise,
}: {
  itemsPaise: number;
  thresholdPaise: number;
}) {
  const unlocked = itemsPaise >= thresholdPaise;
  const remaining = Math.max(0, thresholdPaise - itemsPaise);
  const pct = Math.min(100, Math.round((itemsPaise / thresholdPaise) * 100));
  const [fill, setFill] = useState(0);

  useEffect(() => {
    const id = window.setTimeout(() => setFill(pct), 60);
    return () => window.clearTimeout(id);
  }, [pct]);

  return (
    <div
      className={cn(
        "rounded-xl2 border px-3.5 py-3 shadow-card2",
        unlocked ? "border-success/25 bg-success/5" : "border-primary-600/20 bg-primary-50",
      )}
    >
      <p className="text-sm font-medium text-ink-900" aria-live="polite">
        {unlocked ? (
          <span className="font-semibold text-success">🎉 Free delivery unlocked!</span>
        ) : (
          <>
            Add <span className="font-semibold text-primary-800">{formatPaise(remaining)}</span> more
            for <span className="font-semibold text-primary-800">free delivery</span>
          </>
        )}
      </p>
      <div
        className="mt-2 h-2 overflow-hidden rounded-pill bg-primary-600/10"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progress toward free delivery"
      >
        <div
          className={cn(
            "h-full rounded-pill bg-[length:200%_100%] transition-[width] duration-700 ease-out animate-gradient-pan",
            unlocked
              ? "bg-gradient-to-r from-success via-primary-500 to-success"
              : "bg-gradient-to-r from-primary-600 via-primary-500 to-primary-600",
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
    </div>
  );
}

/* ================================================================ skeleton */

function CartSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden>
      <Skeleton className="h-16 rounded-xl2" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-[104px] rounded-xl2" />
      ))}
    </div>
  );
}

/* ================================================================== glyphs */

function CartGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 5h2l2.4 11.2a1 1 0 001 .8h7.7a1 1 0 001-.8L21 8H7" />
      <circle cx="9" cy="20" r="1.2" />
      <circle cx="17" cy="20" r="1.2" />
    </svg>
  );
}

function RxGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mt-0.5 h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 20V5h4a3 3 0 010 6H5m6 0l7 9m0-9l-7 9" />
    </svg>
  );
}

function HeartGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.8 6.6a5 5 0 00-7.1 0L12 8.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 22l8.8-8.3a5 5 0 000-7.1z" />
    </svg>
  );
}
