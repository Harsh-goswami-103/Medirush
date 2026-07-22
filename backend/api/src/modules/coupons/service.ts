import type { CouponKind, CouponQuote, PublicCoupon } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { getStoreConfig } from "../../core/storeInfo";
import { getOrCreateCart, hydrate } from "../cart/service";
import { computeTotals, type PricedItem, type PricingCoupon } from "../orders/pricing";
import { validateCoupon } from "../orders/service";

/**
 * Customer coupons (feature-gap Batch 2): the public offers list and the
 * apply-preview quote. Validation and arithmetic reuse the exact code paths
 * order create runs (§9.2), so a quote always matches what checkout charges.
 */

/**
 * Active, `isPublic`, in-window coupons — soonest-expiring first.
 * `userId: null` keeps personal coupons (referral/welcome) off the shared
 * offers surface even if one were ever flagged public by mistake.
 */
export async function listPublicCoupons(): Promise<PublicCoupon[]> {
  const now = new Date();
  const rows = await getPrisma().coupon.findMany({
    where: {
      isActive: true,
      isPublic: true,
      userId: null,
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    orderBy: { endsAt: "asc" },
  });
  return rows.map((row) => ({
    code: row.code,
    description: row.description,
    kind: row.kind as CouponKind,
    valuePaiseOrPct: row.valuePaiseOrPct,
    minOrderPaise: row.minOrderPaise,
    maxDiscountPaise: row.maxDiscountPaise,
    endsAt: row.endsAt.toISOString(),
  }));
}

/**
 * Priced preview of `code` against the caller's CURRENT server cart.
 * `validateCoupon` throws 422 COUPON_INVALID with a human reason when the code
 * is unusable; `computeTotals` throws MIN_ORDER_NOT_MET below the store minimum
 * — both propagate so the preview fails exactly where checkout would.
 */
export async function quoteCoupon(userId: string, code: string): Promise<CouponQuote> {
  const cart = await hydrate(await getOrCreateCart(userId));
  if (cart.items.length === 0) {
    throw new AppError("COUPON_INVALID", "Your cart is empty", 422);
  }
  const items: PricedItem[] = cart.items.map((line) => ({
    pricePaise: line.product.pricePaise,
    qty: line.qty,
  }));
  const storeConfig = await getStoreConfig();

  const coupon = await validateCoupon(code.toUpperCase(), cart.itemsPaise, userId);
  const pricingCoupon: PricingCoupon = {
    kind: coupon.kind as CouponKind,
    valuePaiseOrPct: coupon.valuePaiseOrPct,
    maxDiscountPaise: coupon.maxDiscountPaise,
  };
  const totals = computeTotals(items, storeConfig, pricingCoupon);

  return {
    code: coupon.code,
    discountPaise: totals.discountPaise,
    itemsPaise: totals.itemsPaise,
    deliveryPaise: totals.deliveryPaise,
    totalPaise: totals.totalPaise,
  };
}
