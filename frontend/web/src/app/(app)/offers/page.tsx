"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { PublicCoupon } from "@medrush/contracts";
import { api, apiErrorMessage } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { formatPaise } from "@/lib/format";
import { TopBar } from "@/components/AppShell";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { useToast } from "@/components/toast";

/** Handed to checkout, which prefills its coupon input from it (one-shot).
    Keep in sync with the literal in checkout/page.tsx. */
const PENDING_COUPON_KEY = "medrush.web.pendingCoupon";

const CTA =
  "press inline-flex min-h-11 items-center justify-center gap-2 rounded-input bg-gradient-to-br from-primary-700 to-primary-800 px-4 text-sm font-semibold text-white shadow-glow transition-colors hover:from-primary-800 hover:to-primary-900";

/** Height of the ticket stub; the perforation (and the notches) sit on its top edge. */
const STUB_PX = 60;

/**
 * Real ticket notches without a matching-background hack: two half-width
 * background layers, each punching a hole at its own outer edge. Neither layer
 * can fill the other's hole, so the page mesh shows through both cut-outs.
 */
const TICKET: CSSProperties = {
  backgroundImage: [
    `radial-gradient(circle 10px at left 0px bottom ${STUB_PX}px, rgba(255,255,255,0) 10px, #fff 10.5px)`,
    `radial-gradient(circle 10px at right 0px bottom ${STUB_PX}px, rgba(255,255,255,0) 10px, #fff 10.5px)`,
  ].join(","),
  backgroundSize: "51% 100%, 51% 100%",
  backgroundPosition: "left center, right center",
  backgroundRepeat: "no-repeat",
};

function TagIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V5a2 2 0 012-2h7a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

/** Deals surface — GET /v1/coupons (active, public, in-window). */
export default function OffersPage() {
  const router = useRouter();
  const toast = useToast();
  const { itemCount } = useCart();

  const couponsQuery = useQuery({
    queryKey: ["public-coupons"],
    queryFn: () => api.get<PublicCoupon[]>("/v1/coupons"),
    staleTime: 60_000,
  });
  const coupons = couponsQuery.data?.data ?? [];

  function useCode(code: string) {
    try {
      sessionStorage.setItem(PENDING_COUPON_KEY, code);
    } catch {
      // Storage blocked — the customer can still type the code.
    }
    if (itemCount > 0) {
      router.push("/checkout");
    } else {
      toast.push({ type: "info", message: `${code} saved — add items and it applies at checkout` });
      router.push("/shop");
    }
  }

  return (
    <div className="min-h-dvh bg-mesh">
      <TopBar title="Offers" back />

      <div className="space-y-3 p-4">
        {coupons.length > 0 && (
          <Reveal as="section">
            <div className="glass flex items-center gap-3 rounded-xl2 p-4 shadow-glass">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-warning">
                <TagIcon className="h-5 w-5" />
              </span>
              <p className="text-sm text-ink-600" aria-live="polite">
                <span className="font-semibold text-ink-900">
                  {coupons.length} {coupons.length === 1 ? "offer" : "offers"} live
                </span>{" "}
                — tap “Use code” and we&apos;ll apply it at checkout.
              </p>
            </div>
          </Reveal>
        )}

        {couponsQuery.isError ? (
          <ErrorState
            message={apiErrorMessage(couponsQuery.error, "Could not load offers")}
            onRetry={() => void couponsQuery.refetch()}
          />
        ) : couponsQuery.isLoading ? (
          <ul className="space-y-3">
            {[0, 1, 2].map((i) => (
              <li key={i} className="rounded-xl2 bg-surface p-4 shadow-card2">
                <Skeleton className="h-20 w-full rounded-xl2" />
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-dashed border-line pt-4">
                  <Skeleton className="h-3.5 w-1/2 rounded" />
                  <Skeleton className="h-11 w-24 rounded-input" />
                </div>
              </li>
            ))}
          </ul>
        ) : coupons.length === 0 ? (
          <EmptyState
            icon={<TagIcon className="h-10 w-10" />}
            title="No offers right now"
            hint="Check back soon — new deals drop regularly."
            action={
              <Link href="/shop" className={`${CTA} w-full`}>
                Browse medicines
              </Link>
            }
          />
        ) : (
          <ul className="space-y-3">
            {coupons.map((c, i) => (
              <Reveal as="li" key={c.code} delayMs={(i % 6) * 60}>
                <OfferCard coupon={c} onUse={useCode} />
              </Reveal>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OfferCard({ coupon, onUse }: { coupon: PublicCoupon; onUse: (code: string) => void }) {
  const headline =
    coupon.kind === "PERCENT"
      ? `${coupon.valuePaiseOrPct}% off${coupon.maxDiscountPaise ? ` up to ${formatPaise(coupon.maxDiscountPaise)}` : ""}`
      : `${formatPaise(coupon.valuePaiseOrPct)} off`;
  const validTill = new Date(coupon.endsAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });

  return (
    <article className="relative overflow-hidden rounded-xl2 shadow-card2" style={TICKET}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 rounded-xl2 bg-accent/10 p-3">
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight text-ink-900">{headline}</p>
            {coupon.description && (
              <p className="mt-1 line-clamp-2 text-sm text-ink-600">{coupon.description}</p>
            )}
          </div>
          <span className="shrink-0 rounded-input border border-dashed border-accent bg-surface px-2.5 py-1 font-mono text-sm font-semibold tracking-wide text-ink-900">
            {coupon.code}
          </span>
        </div>
      </div>

      <div
        className="flex items-center justify-between gap-3 border-t border-dashed border-line px-4"
        style={{ height: STUB_PX }}
      >
        <p className="min-w-0 flex-1 text-[11px] leading-tight text-ink-600">
          {coupon.minOrderPaise > 0
            ? `On orders above ${formatPaise(coupon.minOrderPaise)} · `
            : ""}
          Valid till {validTill}
        </p>
        <button type="button" className={CTA} onClick={() => onUse(coupon.code)}>
          Use code
        </button>
      </div>
    </article>
  );
}
