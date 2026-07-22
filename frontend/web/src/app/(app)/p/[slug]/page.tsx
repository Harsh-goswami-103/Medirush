"use client";

import { use, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Category,
  Product,
  ProductSummary,
  RefillReminder,
  StockAlertStatus,
  ToggleWishlistBody,
  WishlistEntry,
  WishlistStatus,
} from "@medrush/contracts";
import { api, ApiError, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { formatPaise } from "@/lib/format";
import { cn } from "@/lib/cn";
import { TopBar } from "@/components/AppShell";
import { AddOrStepper, ProductCard, ProductImage } from "@/components/shop";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { useToast } from "@/components/toast";

const REFILL_INTERVALS = [30, 60, 90] as const;

export default function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { user } = useAuth();
  const { qtyOf } = useCart();
  const qc = useQueryClient();
  const toast = useToast();
  const [imgIdx, setImgIdx] = useState(0);
  const [refillOpen, setRefillOpen] = useState(false);

  const productQuery = useQuery({
    queryKey: ["product", slug],
    queryFn: () => api.get<Product>(`/v1/products/${encodeURIComponent(slug)}`),
  });
  const product = productQuery.data?.data;
  const productId = product?.id ?? "";

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
        message: res.data.subscribed ? "We'll notify you when it's back" : "Alert removed",
      });
    },
    onError: () => toast.push({ type: "error", message: "Couldn't update the alert — try again" }),
  });

  // Wishlist status. There is no per-product status endpoint, so page through the
  // owner-scoped list (bounded) and look for this product.
  const wishlistQuery = useQuery({
    queryKey: ["wishlist-status", productId],
    queryFn: async () => {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const res = await api.get<WishlistEntry[]>(`/v1/wishlist${qs({ cursor, limit: 50 })}`);
        if (res.data.some((e) => e.product.id === productId)) return true;
        const next = res.meta?.nextCursor;
        if (!next) break;
        cursor = next;
      }
      return false;
    },
    enabled: Boolean(user && productId),
    staleTime: 30_000,
  });
  const wishlisted = wishlistQuery.data ?? false;

  const toggleWishlist = useMutation({
    mutationFn: (next: boolean) =>
      next
        ? api.post<WishlistStatus>("/v1/wishlist", { productId } satisfies ToggleWishlistBody)
        : api.del<WishlistStatus>(`/v1/wishlist/${productId}`),
    onSuccess: (res) => {
      qc.setQueryData(["wishlist-status", productId], res.data.wishlisted);
      void qc.invalidateQueries({ queryKey: ["wishlist"] });
      toast.push({
        type: "success",
        message: res.data.wishlisted ? "Saved to your wishlist" : "Removed from your wishlist",
      });
    },
    onError: () => toast.push({ type: "error", message: "Couldn't update your wishlist — try again" }),
  });

  // Refill reminders are listed whole (no per-product read) — match on productId.
  const refillsQuery = useQuery({
    queryKey: ["refills"],
    queryFn: () => api.get<RefillReminder[]>("/v1/refills"),
    enabled: Boolean(user),
    staleTime: 30_000,
  });
  const refill = refillsQuery.data?.data.find((r) => r.product.id === productId && r.isActive);

  const saveRefill = useMutation({
    mutationFn: (intervalDays: number) =>
      api.post<RefillReminder>("/v1/refills", { productId, intervalDays }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["refills"] });
      setRefillOpen(false);
      toast.push({
        type: "success",
        message: `Reminder set — we'll nudge you every ${res.data.intervalDays} days`,
      });
    },
    onError: () => toast.push({ type: "error", message: "Couldn't set the reminder — try again" }),
  });

  const cancelRefill = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/v1/refills/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["refills"] });
      setRefillOpen(false);
      toast.push({ type: "success", message: "Refill reminder turned off" });
    },
    onError: () => toast.push({ type: "error", message: "Couldn't remove the reminder — try again" }),
  });

  // "Similar products" — the product carries a categoryId (not a slug), so map
  // it through the categories list to the slug the products endpoint expects.
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
      <div className="min-h-dvh bg-mesh">
        <TopBar title="Product" back />
        <PdpSkeleton />
      </div>
    );
  }

  // 404 → friendly empty state (the slug doesn't resolve to a live product).
  if (productQuery.error instanceof ApiError && productQuery.error.code === "NOT_FOUND") {
    return (
      <div className="min-h-dvh bg-mesh">
        <TopBar title="Not found" back />
        <div className="p-4">
          <EmptyState
            title="Product not found"
            hint="This item may no longer be available."
            action={
              <Link
                href="/shop"
                className="press inline-flex w-full items-center justify-center rounded-input bg-gradient-to-b from-primary-500 to-primary-700 px-3.5 py-2.5 text-sm font-semibold text-white shadow-glow"
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
      <div className="min-h-dvh bg-mesh">
        <TopBar title="Product" back />
        <div className="p-4">
          <ErrorState
            message={
              productQuery.error instanceof Error
                ? productQuery.error.message
                : "Could not load this product"
            }
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

  const medicalSections = [
    { key: "description", title: "Description", body: product.description, open: true },
    { key: "uses", title: "Uses", body: product.uses, open: true },
    { key: "directions", title: "Directions for use", body: product.directions, open: false },
    { key: "sideEffects", title: "Side effects", body: product.sideEffects, open: false },
    { key: "storageInfo", title: "Storage", body: product.storageInfo, open: false },
  ].filter((s) => s.body.trim().length > 0);

  const hasMedicalInfo =
    medicalSections.length > 0 ||
    product.warnings.trim().length > 0 ||
    Boolean(product.manufacturer);

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
    <div className="min-h-dvh bg-mesh">
      <TopBar
        title={product.name}
        back
        right={
          <div className="flex shrink-0 items-center">
            {user ? (
              <button
                type="button"
                onClick={() => toggleWishlist.mutate(!wishlisted)}
                disabled={toggleWishlist.isPending}
                aria-pressed={wishlisted}
                aria-label={wishlisted ? "Remove from wishlist" : "Save to wishlist"}
                className={cn(
                  "press flex h-11 w-11 items-center justify-center rounded-pill transition-colors disabled:opacity-60",
                  wishlisted ? "text-danger" : "text-ink-600 hover:bg-surface-2",
                )}
              >
                <HeartIcon filled={wishlisted} className={cn("h-6 w-6", wishlisted && "animate-pop")} />
              </button>
            ) : (
              <Link
                href="/login"
                aria-label="Sign in to save to wishlist"
                className="press flex h-11 w-11 items-center justify-center rounded-pill text-ink-600 hover:bg-surface-2"
              >
                <HeartIcon className="h-6 w-6" />
              </Link>
            )}
            <button
              type="button"
              onClick={() => void share()}
              aria-label="Share product"
              className="press flex h-11 w-11 items-center justify-center rounded-pill text-ink-600 hover:bg-surface-2"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
              </svg>
            </button>
          </div>
        }
      />

      <div className="px-4 pb-44">
        {/* Image gallery — main image + thumbnail strip when there are several. */}
        <div className="relative mt-3 aspect-square w-full overflow-hidden rounded-xl2 border border-white/70 bg-surface shadow-card2">
          <ProductImage url={heroUrl} name={product.name} />
          {discounted && (
            <span className="absolute left-3 top-3 rounded-pill bg-gradient-to-b from-accent to-[#D97706] px-2.5 py-1 text-xs font-bold text-white shadow-md">
              {discountPct}% OFF
            </span>
          )}
          {!product.inStock && (
            <span className="absolute right-3 top-3 rounded-pill bg-ink-900/80 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
              Out of stock
            </span>
          )}
        </div>
        {gallery.length > 1 && (
          <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
            {gallery.map((url, i) => (
              <button
                key={url}
                type="button"
                onClick={() => setImgIdx(i)}
                aria-label={`View image ${i + 1} of ${gallery.length}`}
                aria-current={i === imgIdx}
                className={cn(
                  "press h-14 w-14 shrink-0 overflow-hidden rounded-card border-2 bg-surface transition-colors",
                  i === imgIdx ? "border-primary-600 shadow-glow" : "border-line",
                )}
              >
                <ProductImage url={url} name={product.name} />
              </button>
            ))}
          </div>
        )}

        {/* Identity + price — one raised card so the buy decision reads as a unit. */}
        <section className="mt-4 rounded-xl2 border border-white/70 bg-surface p-4 shadow-card2">
          <h1 className="text-lg font-semibold leading-snug text-ink-900">{product.name}</h1>
          {product.brand && <p className="mt-0.5 text-sm text-ink-600">{product.brand}</p>}
          <p className="text-xs text-ink-400">{product.packSize}</p>

          {(product.requiresRx || product.isColdChain) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {product.requiresRx && <Badge tone="violet">Rx</Badge>}
              {product.isColdChain && <Badge tone="blue">Cold chain</Badge>}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-x-2 gap-y-1">
            <span className="text-3xl font-bold tracking-tight text-ink-900">
              {formatPaise(product.pricePaise)}
            </span>
            {discounted && (
              <span className="pb-1 text-sm text-ink-400 line-through">
                {formatPaise(product.mrpPaise)}
              </span>
            )}
            {discounted && (
              <span className="mb-1 rounded-pill bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">
                Save {formatPaise(product.mrpPaise - product.pricePaise)}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-400">Incl. GST {product.gstRatePct}%</p>

          {product.composition && (
            <div className="mt-4 rounded-card bg-mint px-3 py-2.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-primary-800">
                Composition
              </h2>
              <p className="mt-0.5 text-sm font-medium text-ink-900">{product.composition}</p>
            </div>
          )}
        </section>

        {/* Refill reminder — repeat meds are the retention loop (§17 v1.1). */}
        {user ? (
          <button
            type="button"
            onClick={() => setRefillOpen(true)}
            className={cn(
              "press mt-3 flex w-full items-center gap-3 rounded-xl2 border p-3.5 text-left shadow-card2 transition-colors",
              refill
                ? "border-primary-200 bg-primary-50"
                : "border-white/70 bg-surface hover:bg-surface-2",
            )}
          >
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-pill",
                refill ? "bg-primary-600 text-white" : "bg-primary-50 text-primary-700",
              )}
            >
              <ClockIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink-900">
                {refill ? `Refill reminder — every ${refill.intervalDays} days` : "Remind me to refill"}
              </span>
              <span className="block text-xs text-ink-600">
                {refill
                  ? "Tap to change the interval or turn it off"
                  : "Never run out — we'll nudge you before it does"}
              </span>
            </span>
            <ChevronIcon className="h-4 w-4 shrink-0 -rotate-90 text-ink-400" />
          </button>
        ) : (
          <Link
            href="/login"
            className="press mt-3 flex w-full items-center gap-3 rounded-xl2 border border-white/70 bg-surface p-3.5 text-left shadow-card2"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-primary-50 text-primary-700">
              <ClockIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink-900">Remind me to refill</span>
              <span className="block text-xs text-ink-600">Sign in to set a refill reminder</span>
            </span>
            <ChevronIcon className="h-4 w-4 shrink-0 -rotate-90 text-ink-400" />
          </Link>
        )}

        {/* Out of stock → back-in-stock alert (signed-in) or sign-in nudge. */}
        {product.inStock === false && (
          <div className="mt-3 rounded-xl2 border border-warning/30 bg-warning/5 px-4 py-3.5 shadow-card2">
            <p className="text-sm font-semibold text-warning">Currently out of stock</p>
            {user ? (
              <Button
                variant="secondary"
                className="press mt-2 w-full py-2.5"
                loading={toggleAlert.isPending || (stockAlertEnabled && stockAlertQuery.isLoading)}
                onClick={() => toggleAlert.mutate()}
              >
                {subscribed ? "✓ We'll notify you — tap to cancel" : "Notify me when it's back"}
              </Button>
            ) : (
              <Link
                href="/login"
                className="press mt-2 block rounded-input border border-primary-600 px-3.5 py-2.5 text-center text-sm font-semibold text-primary-700"
              >
                Sign in to get a back-in-stock alert
              </Link>
            )}
            <p className="sr-only" aria-live="polite">
              {subscribed ? "Back-in-stock alert on" : "Back-in-stock alert off"}
            </p>
          </div>
        )}

        {/* Rx explanatory banner — reduces checkout drop-off by setting the
            expectation upfront that a prescription is needed (§18.1). */}
        {product.requiresRx && (
          <div className="mt-3 rounded-xl2 border border-rx/20 bg-rx/5 px-4 py-3.5 shadow-card2">
            <p className="flex items-center gap-2 text-sm font-semibold text-rx">
              <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-rx/10 text-[11px] font-bold">
                Rx
              </span>
              Prescription required
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
              This is a prescription medicine. You can add it to your cart now and upload a valid
              prescription after placing the order — our pharmacist will verify it before dispatch.
            </p>
          </div>
        )}

        {/* Safety-critical warnings are never collapsed (§17 PDP). */}
        {product.warnings.trim().length > 0 && (
          <div className="mt-3 rounded-xl2 border border-warning/40 bg-warning/10 px-4 py-3.5 shadow-card2">
            <p className="flex items-center gap-2 text-sm font-bold text-warning">
              <WarningIcon className="h-5 w-5" />
              Warnings &amp; precautions
            </p>
            <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-ink-900">
              {product.warnings}
            </p>
          </div>
        )}

        {hasMedicalInfo && (
          <Reveal as="section" className="mt-6">
            <h2 className="mb-2 text-sm font-semibold text-ink-900">Product information</h2>
            {medicalSections.length > 0 && (
              <div className="divide-y divide-line overflow-hidden rounded-xl2 border border-white/70 bg-surface shadow-card2">
                {medicalSections.map((s) => (
                  <InfoAccordion key={s.key} title={s.title} body={s.body} defaultOpen={s.open} />
                ))}
              </div>
            )}
            {product.manufacturer && (
              <p className="mt-2 px-1 text-xs text-ink-600">
                <span className="font-medium text-ink-900">Manufacturer:</span> {product.manufacturer}
              </p>
            )}
            <p className="mt-2 px-1 text-xs leading-relaxed text-ink-400">
              Information is for reference; follow your doctor&apos;s advice.
            </p>
          </Reveal>
        )}

        {/* Same-salt substitutes — the §17 v1.1 generics play; price-led. */}
        {substitutes.length > 0 && (
          <Reveal as="section" className="mt-6">
            <h2 className="mb-1 text-sm font-semibold text-ink-900">Substitutes with the same salt</h2>
            <p className="mb-2.5 text-xs text-ink-600">
              Same composition ({product.composition}) — always confirm with your doctor before
              switching.
            </p>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {substitutes.map((p) => (
                <div key={p.id} className="w-36 shrink-0">
                  <ProductCard product={p} />
                </div>
              ))}
            </div>
          </Reveal>
        )}

        {/* Similar products rail — same category (substitutes excluded). */}
        {similar.filter((p) => !substitutes.some((s) => s.id === p.id)).length > 0 && (
          <Reveal as="section" className="mt-6">
            <h2 className="mb-2.5 text-sm font-semibold text-ink-900">Similar products</h2>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {similar
                .filter((p) => !substitutes.some((s) => s.id === p.id))
                .map((p) => (
                  <div key={p.id} className="w-36 shrink-0">
                    <ProductCard product={p} />
                  </div>
                ))}
            </div>
          </Reveal>
        )}
      </div>

      {/* Sticky action bar — sits above the bottom tab nav (clears it via bottom-16).
          data-testid anchors e2e: rails above add sibling "Add" buttons, so the
          specs must scope to THIS bar's button. */}
      <div
        data-testid="pdp-action-bar"
        className="glass fixed bottom-16 left-1/2 z-30 w-full max-w-md -translate-x-1/2 rounded-t-sheet2 px-4 py-3 shadow-glass"
      >
        <div className="flex items-center gap-3">
          <div className="press flex-1">
            <AddOrStepper product={product as ProductSummary} block />
          </div>
          {inCart && (
            <Link
              href="/cart"
              className="press whitespace-nowrap rounded-input bg-gradient-to-b from-primary-500 to-primary-700 px-4 py-2.5 text-sm font-semibold text-white shadow-glow"
            >
              Go to cart
            </Link>
          )}
        </div>
        {product.inStock && product.maxPerOrder <= 10 && (
          <p className="mt-1.5 text-center text-[11px] text-ink-600">
            Max {product.maxPerOrder} per order
          </p>
        )}
      </div>

      {refillOpen && (
        <RefillSheet
          productName={product.name}
          current={refill}
          saving={saveRefill.isPending}
          cancelling={cancelRefill.isPending}
          onSave={(days) => saveRefill.mutate(days)}
          onCancel={(id) => cancelRefill.mutate(id)}
          onClose={() => setRefillOpen(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- accordion */

function InfoAccordion({
  title,
  body,
  defaultOpen,
}: {
  title: string;
  body: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const panelId = useId();
  const buttonId = useId();

  return (
    <div>
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-sm font-semibold text-ink-900 hover:bg-surface-2"
        >
          {title}
          <ChevronIcon
            className={cn("h-4 w-4 shrink-0 text-primary-700 transition-transform", open && "rotate-180")}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="px-4 pb-4 pt-0"
      >
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink-600">{body}</p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- refill sheet */

function RefillSheet({
  productName,
  current,
  saving,
  cancelling,
  onSave,
  onCancel,
  onClose,
}: {
  productName: string;
  current?: RefillReminder;
  saving: boolean;
  cancelling: boolean;
  onSave: (intervalDays: number) => void;
  onCancel: (id: string) => void;
  onClose: () => void;
}) {
  const [days, setDays] = useState<number>(current?.intervalDays ?? 30);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-ink-900/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative mb-16 w-full max-w-md animate-reveal-up rounded-t-sheet2 border-t border-line bg-surface p-5 pb-6 shadow-glass"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-ink-900">
              Refill reminder
            </h2>
            <p className="mt-0.5 truncate text-sm text-ink-600">{productName}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close refill reminder"
            className="press -mr-1 -mt-1 flex h-11 w-11 items-center justify-center rounded-pill text-ink-600 hover:bg-surface-2"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Remind me every
          </legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {REFILL_INTERVALS.map((d) => (
              <label
                key={d}
                className={cn(
                  "press flex cursor-pointer flex-col items-center justify-center rounded-card border-2 py-3 text-sm font-semibold transition-colors",
                  days === d
                    ? "border-primary-600 bg-primary-50 text-primary-800"
                    : "border-line bg-surface text-ink-600",
                )}
              >
                <input
                  type="radio"
                  name="refill-interval"
                  value={d}
                  checked={days === d}
                  onChange={() => setDays(d)}
                  className="sr-only"
                />
                {d}
                <span className="text-[11px] font-medium">days</span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="mt-3 text-xs leading-relaxed text-ink-600">
          We&apos;ll send a reminder {days} days from today, then every {days} days after that.
        </p>

        <Button
          className="press mt-4 w-full bg-gradient-to-b from-primary-500 to-primary-700 py-3 text-base shadow-glow hover:brightness-95"
          loading={saving}
          onClick={() => onSave(days)}
        >
          {current ? "Update reminder" : "Set reminder"}
        </Button>
        {current && (
          <Button
            variant="ghost"
            className="press mt-2 w-full py-2.5 text-danger"
            loading={cancelling}
            onClick={() => onCancel(current.id)}
          >
            Turn off reminder
          </Button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- skeleton */

function PdpSkeleton() {
  return (
    <div className="px-4 pb-40" aria-busy>
      <Skeleton className="mt-3 aspect-square w-full rounded-xl2" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-14 w-14 rounded-card" />
        <Skeleton className="h-14 w-14 rounded-card" />
        <Skeleton className="h-14 w-14 rounded-card" />
      </div>
      <div className="mt-4 rounded-xl2 border border-white/70 bg-surface p-4 shadow-card2">
        <Skeleton className="h-5 w-3/4 rounded" />
        <Skeleton className="mt-2 h-3.5 w-1/3 rounded" />
        <Skeleton className="mt-4 h-8 w-1/2 rounded" />
        <Skeleton className="mt-3 h-12 w-full rounded-card" />
      </div>
      <Skeleton className="mt-3 h-[70px] w-full rounded-xl2" />
      <Skeleton className="mt-6 h-40 w-full rounded-xl2" />
    </div>
  );
}

/* ----------------------------------------------------------------- icons */

function HeartIcon({ filled, className }: { filled?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.8 8.8-8.8a5 5 0 0 0 0-7.1Z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}
