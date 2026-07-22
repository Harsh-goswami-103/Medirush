"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { PublicCoupon } from "@medrush/contracts";
import { api } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { formatPaise } from "@/lib/format";
import { TopBar } from "@/components/AppShell";
import { Button, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { useToast } from "@/components/toast";

/** Handed to checkout, which prefills its coupon input from it (one-shot).
    Keep in sync with the literal in checkout/page.tsx. */
const PENDING_COUPON_KEY = "medrush.web.pendingCoupon";

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
      router.push("/");
    }
  }

  return (
    <div>
      <TopBar title="Offers" back />
      <div className="space-y-3 p-4">
        {couponsQuery.isError ? (
          <ErrorState
            message={(couponsQuery.error as Error).message}
            onRetry={() => couponsQuery.refetch()}
          />
        ) : couponsQuery.isLoading ? (
          <>
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <Skeleton className="h-5 w-28 rounded" />
                <Skeleton className="mt-2 h-3.5 w-3/4 rounded" />
                <Skeleton className="mt-3 h-8 w-full rounded-input" />
              </Card>
            ))}
          </>
        ) : coupons.length === 0 ? (
          <EmptyState
            title="No offers right now"
            hint="Check back soon — new deals drop regularly."
          />
        ) : (
          coupons.map((c) => <OfferCard key={c.code} coupon={c} onUse={useCode} />)
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
    <Card className="overflow-hidden">
      <div className="border-b border-dashed border-line bg-accent/5 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-base font-bold text-ink-900">{headline}</p>
          <span className="rounded-input border border-dashed border-accent bg-surface px-2 py-0.5 font-mono text-sm font-semibold tracking-wide text-accent">
            {coupon.code}
          </span>
        </div>
        {coupon.description && <p className="mt-1 text-sm text-ink-600">{coupon.description}</p>}
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-xs text-ink-400">
          {coupon.minOrderPaise > 0 ? `On orders above ${formatPaise(coupon.minOrderPaise)} · ` : ""}
          Valid till {validTill}
        </p>
        <Button variant="secondary" onClick={() => onUse(coupon.code)}>
          Use code
        </Button>
      </div>
    </Card>
  );
}
