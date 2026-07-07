import { describe, expect, it } from "vitest";
import { AppError } from "../src/core/errors";
import {
  computeTotals,
  couponDiscountPaise,
  type PricingCoupon,
  type PricingStoreConfig,
} from "../src/modules/orders/pricing";

/**
 * Unit tests for the pure checkout pricing module (BLUEPRINT §9.2). No DB.
 * Money is integer paise throughout — every assertion is exact.
 */

const store: PricingStoreConfig = {
  minOrderPaise: 9900,
  deliveryBasePaise: 2000,
  freeDeliveryAbovePaise: 49900,
};

const flat = (valuePaise: number, maxDiscountPaise: number | null = null): PricingCoupon => ({
  kind: "FLAT",
  valuePaiseOrPct: valuePaise,
  maxDiscountPaise,
});
const percent = (pct: number, maxDiscountPaise: number | null = null): PricingCoupon => ({
  kind: "PERCENT",
  valuePaiseOrPct: pct,
  maxDiscountPaise,
});

function caught(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("computeTotals", () => {
  it("sums line totals and adds the base delivery fee below the free threshold", () => {
    const totals = computeTotals([{ pricePaise: 4550, qty: 2 }, { pricePaise: 12005, qty: 3 }], store);
    // 9100 + 36015 = 45115 (< 49900 free threshold → base fee applies)
    expect(totals.itemsPaise).toBe(45115);
    expect(totals.deliveryPaise).toBe(2000);
    expect(totals.discountPaise).toBe(0);
    expect(totals.totalPaise).toBe(47115);
  });

  it("waives delivery at/above the free-delivery threshold", () => {
    const atThreshold = computeTotals([{ pricePaise: 49900, qty: 1 }], store);
    expect(atThreshold.deliveryPaise).toBe(0);
    expect(atThreshold.totalPaise).toBe(49900);

    const above = computeTotals([{ pricePaise: 25000, qty: 3 }], store);
    expect(above.itemsPaise).toBe(75000);
    expect(above.deliveryPaise).toBe(0);
    expect(above.totalPaise).toBe(75000);
  });

  it("throws 422 MIN_ORDER_NOT_MET below the store minimum", () => {
    const err = caught(() => computeTotals([{ pricePaise: 5000, qty: 1 }], store));
    expect(err.code).toBe("MIN_ORDER_NOT_MET");
    expect(err.statusCode).toBe(422);
  });

  it("accepts an order exactly at the minimum", () => {
    const totals = computeTotals([{ pricePaise: 9900, qty: 1 }], store);
    expect(totals.itemsPaise).toBe(9900);
    expect(totals.totalPaise).toBe(9900 + 2000);
  });

  it("applies a FLAT coupon and keeps delivery in the total", () => {
    const totals = computeTotals([{ pricePaise: 10000, qty: 2 }], store, flat(5000));
    // items 20000, delivery 2000, discount 5000 → total 17000
    expect(totals.discountPaise).toBe(5000);
    expect(totals.totalPaise).toBe(17000);
  });

  it("applies a PERCENT coupon floored to whole paise", () => {
    const totals = computeTotals([{ pricePaise: 20005, qty: 1 }], store, percent(12.5));
    // items 20005 (≥ 9900), delivery 2000, discount floor(20005*0.125)=2500 → total 19505
    expect(totals.discountPaise).toBe(2500);
    expect(totals.totalPaise).toBe(19505);
  });
});

describe("couponDiscountPaise", () => {
  it("FLAT is a straight paise discount", () => {
    expect(couponDiscountPaise(flat(5000), 20000)).toBe(5000);
  });

  it("PERCENT floors to whole paise", () => {
    // 12.5% of 20005 = 2500.625 → 2500
    expect(couponDiscountPaise(percent(12.5), 20005)).toBe(2500);
  });

  it("caps at maxDiscountPaise when set", () => {
    // 50% of 20000 = 10000, capped to 3000
    expect(couponDiscountPaise(percent(50, 3000), 20000)).toBe(3000);
    // FLAT above the cap is also clamped
    expect(couponDiscountPaise(flat(9999, 4000), 20000)).toBe(4000);
  });

  it("never exceeds the item subtotal and never goes negative", () => {
    expect(couponDiscountPaise(flat(999999), 5000)).toBe(5000);
    expect(couponDiscountPaise(flat(-100), 5000)).toBe(0);
    expect(couponDiscountPaise(percent(200), 5000)).toBe(5000);
  });
});
