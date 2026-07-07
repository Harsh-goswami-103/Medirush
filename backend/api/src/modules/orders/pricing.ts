import { CouponKind } from "@medrush/contracts";
import { AppError } from "../../core/errors";

/**
 * Checkout pricing (BLUEPRINT §9.2) — PURE. No I/O, no Date.now(), integer
 * paise only. Coupon *validity* (window, usage limits, per-user limit) is the
 * service's job; this module owns the arithmetic:
 *
 *   items    = Σ price × qty
 *   delivery = items ≥ freeDeliveryAbovePaise ? 0 : deliveryBasePaise
 *   discount = coupon (FLAT | PERCENT, capped)
 *   total    = items + delivery − discount
 *
 * Min order: items ≥ minOrderPaise, else 422 MIN_ORDER_NOT_MET.
 */

export interface PricedItem {
  /** Unit selling price in paise (server-side catalog price, never client). */
  pricePaise: number;
  qty: number;
}

/** The StoreConfig columns pricing needs (structural — pass the full row). */
export interface PricingStoreConfig {
  minOrderPaise: number;
  deliveryBasePaise: number;
  freeDeliveryAbovePaise: number;
}

/** The Coupon columns pricing needs (structural — pass the full row). */
export interface PricingCoupon {
  kind: CouponKind;
  /** FLAT → paise off · PERCENT → % off. */
  valuePaiseOrPct: number;
  maxDiscountPaise: number | null;
}

export interface OrderTotals {
  itemsPaise: number;
  deliveryPaise: number;
  discountPaise: number;
  totalPaise: number;
}

/**
 * Discount for a coupon against an item subtotal. FLAT is paise off, PERCENT
 * is % off (floored to whole paise); both are capped by `maxDiscountPaise`
 * when set, and always clamped to [0, itemsPaise] so totals never go negative.
 */
export function couponDiscountPaise(coupon: PricingCoupon, itemsPaise: number): number {
  let discount =
    coupon.kind === CouponKind.PERCENT
      ? Math.floor((itemsPaise * coupon.valuePaiseOrPct) / 100)
      : coupon.valuePaiseOrPct;
  if (coupon.maxDiscountPaise !== null) {
    discount = Math.min(discount, coupon.maxDiscountPaise);
  }
  return Math.max(0, Math.min(discount, itemsPaise));
}

/**
 * Recompute order totals server-side (§9.2 — client totals are ignored).
 * Throws 422 MIN_ORDER_NOT_MET when the item subtotal is below the store's
 * minimum order value.
 */
export function computeTotals(
  items: readonly PricedItem[],
  storeCfg: PricingStoreConfig,
  coupon?: PricingCoupon,
): OrderTotals {
  const itemsPaise = items.reduce((sum, item) => sum + item.pricePaise * item.qty, 0);

  if (itemsPaise < storeCfg.minOrderPaise) {
    throw new AppError(
      "MIN_ORDER_NOT_MET",
      `Minimum order value is ₹${(storeCfg.minOrderPaise / 100).toFixed(2)}`,
      422,
      { minOrderPaise: storeCfg.minOrderPaise, itemsPaise },
    );
  }

  const deliveryPaise =
    itemsPaise >= storeCfg.freeDeliveryAbovePaise ? 0 : storeCfg.deliveryBasePaise;
  const discountPaise = coupon ? couponDiscountPaise(coupon, itemsPaise) : 0;
  const totalPaise = itemsPaise + deliveryPaise - discountPaise;

  return { itemsPaise, deliveryPaise, discountPaise, totalPaise };
}
