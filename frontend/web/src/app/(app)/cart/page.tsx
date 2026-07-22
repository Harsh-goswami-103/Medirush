"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { useStore } from "@/lib/store";
import { ApiError } from "@/lib/api";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { Button, Card, EmptyState, ErrorState, Spinner } from "@/components/ui";
import { ProductImage } from "@/components/shop";
import { useToast } from "@/components/toast";

export default function CartPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { cart, isLoading, isError, error, refetch, setItem } = useCart();
  const { store } = useStore();
  const toast = useToast();

  // Auth gate — this screen is customer-only.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // Set a line to exactly `qty` (0 removes). Surface any failure via toast.
  const changeQty = (productId: string, qty: number) =>
    setItem.mutate(
      { productId, qty },
      {
        onError: (err) =>
          toast.push({
            type: "error",
            message: err instanceof ApiError ? err.message : "Couldn't update your cart",
          }),
      },
    );

  // Auth still resolving, or redirect in flight.
  if (loading || !user) {
    return (
      <div>
        <TopBar title="Cart" />
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
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

  return (
    <div>
      <TopBar title="Cart" />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6 text-primary-600" />
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
          <div className="space-y-3 p-4 pb-40">
            {isEmpty ? (
              <div className="space-y-4">
                <EmptyState title="Your cart is empty" hint="Add products to get started." />
                <Link
                  href="/"
                  className="block rounded-input border border-primary-600 px-3.5 py-2 text-center text-sm font-medium text-primary-700"
                >
                  Browse products
                </Link>
              </div>
            ) : (
              <>
                {cart?.requiresRx && (
                  <div className="rounded-card border border-rx/20 bg-rx/10 px-3 py-2.5 text-sm text-rx">
                    This order needs a prescription — you&apos;ll upload it after placing the order.
                  </div>
                )}

                {freeAbovePaise > 0 && (
                  <FreeDeliveryBar itemsPaise={itemsPaise} thresholdPaise={freeAbovePaise} />
                )}

                <Card className="divide-y divide-line">
                  {items.map((item) => {
                    const { product } = item;
                    return (
                      <div key={item.productId} className="flex gap-3 p-3">
                        <Link
                          href={`/p/${product.slug}`}
                          className="h-16 w-16 shrink-0 overflow-hidden rounded-input bg-surface-2"
                        >
                          <ProductImage url={product.imageUrl} name={product.name} />
                        </Link>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <Link
                                href={`/p/${product.slug}`}
                                className="line-clamp-2 text-sm font-medium text-ink-900"
                              >
                                {product.name}
                              </Link>
                              <p className="text-xs text-ink-400">{product.packSize}</p>
                              {!product.inStock && (
                                <p className="mt-0.5 text-xs font-medium text-danger">
                                  Out of stock — remove to checkout
                                </p>
                              )}
                            </div>
                            <p className="shrink-0 text-sm font-semibold text-ink-900">
                              {formatPaise(item.lineTotalPaise)}
                            </p>
                          </div>

                          <div className="mt-2 flex items-center justify-between">
                            <div className="flex items-center gap-3 rounded-input bg-primary-600 px-2 py-1 text-white">
                              <button
                                type="button"
                                aria-label="Decrease quantity"
                                className="px-1 text-lg leading-none disabled:opacity-50"
                                disabled={setItem.isPending}
                                onClick={() => changeQty(item.productId, item.qty - 1)}
                              >
                                −
                              </button>
                              <span className="min-w-4 text-center text-sm font-semibold tabular-nums">
                                {item.qty}
                              </span>
                              <button
                                type="button"
                                aria-label="Increase quantity"
                                className="px-1 text-lg leading-none disabled:opacity-50"
                                disabled={
                                  setItem.isPending ||
                                  !product.inStock ||
                                  item.qty >= product.maxPerOrder
                                }
                                onClick={() =>
                                  changeQty(item.productId, Math.min(item.qty + 1, product.maxPerOrder))
                                }
                              >
                                +
                              </button>
                            </div>

                            <button
                              type="button"
                              className="text-xs font-medium text-danger disabled:opacity-50"
                              disabled={setItem.isPending}
                              onClick={() => changeQty(item.productId, 0)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </Card>

                <div className="flex items-center justify-between px-1 pt-1">
                  <span className="text-sm text-ink-600">Subtotal</span>
                  <span className="text-base font-semibold text-ink-900">
                    {formatPaise(cart?.itemsPaise ?? 0)}
                  </span>
                </div>
                <p className="px-1 text-xs text-ink-400">
                  Delivery &amp; taxes are calculated at checkout.
                </p>
              </>
            )}
          </div>

          {/* Sticky action bar — sits above the bottom tab nav (bottom-16). */}
          <div className="fixed bottom-16 left-1/2 z-40 w-full max-w-md -translate-x-1/2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
            {belowMin && (
              <p className="mb-2 rounded-input bg-warning/10 px-3 py-1.5 text-center text-xs font-medium text-warning">
                Add {formatPaise(toMinPaise)} more to reach the {formatPaise(minOrderPaise)} minimum
                order
              </p>
            )}
            <div className="flex items-center gap-3">
              <div className="min-w-0">
                <p className="text-xs text-ink-400">Subtotal</p>
                <p className="text-base font-semibold text-ink-900">{formatPaise(itemsPaise)}</p>
              </div>
              <div className="ml-auto flex-1">
                {isEmpty || belowMin ? (
                  <Button className="w-full" disabled>
                    {belowMin ? `Add ${formatPaise(toMinPaise)} to checkout` : "Proceed to checkout"}
                  </Button>
                ) : (
                  <Link href="/checkout" className="block">
                    <Button className="w-full">Proceed to checkout</Button>
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

/**
 * Progress toward free delivery (§17 v1). Reads the store's
 * `freeDeliveryAbovePaise` threshold vs the current item subtotal and shows how
 * much more unlocks free delivery — a proven basket-nudge.
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

  return (
    <div
      className={cn(
        "rounded-card border px-3 py-2.5",
        unlocked ? "border-success/20 bg-success/5" : "border-primary-600/20 bg-primary-600/5",
      )}
    >
      <p className={cn("text-sm font-medium", unlocked ? "text-success" : "text-ink-900")}>
        {unlocked ? (
          <>🎉 You&apos;ve unlocked free delivery!</>
        ) : (
          <>
            Add <span className="font-semibold">{formatPaise(remaining)}</span> more for{" "}
            <span className="font-semibold">free delivery</span>
          </>
        )}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-pill bg-line">
        <div
          className={cn(
            "h-full rounded-pill transition-[width] duration-300",
            unlocked ? "bg-success" : "bg-primary-600",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
