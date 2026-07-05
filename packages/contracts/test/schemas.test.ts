import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorSchema,
  CreateOrderBodySchema,
  CreateOrderResponseSchema,
  CursorQuerySchema,
  ERROR_HTTP_STATUS,
  ErrorCode,
  OfferNewEventSchema,
  OPS_ROOM,
  OrderStatus,
  OrderStatusSchema,
  orderRoom,
  driverRoom,
  PaiseSchema,
  PaginationMetaSchema,
  PhoneSchema,
  Role,
  RoleSchema,
  RxReviewBodySchema,
  RxStatus,
  envelope,
  isValidOrderTransition,
  paginatedEnvelope,
} from "../src/index";

describe("common scalars", () => {
  it("accepts zero and positive integer paise", () => {
    expect(PaiseSchema.parse(0)).toBe(0);
    expect(PaiseSchema.parse(49_900)).toBe(49_900);
  });

  it("rejects negative paise", () => {
    expect(PaiseSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects fractional paise (no floats near money)", () => {
    expect(PaiseSchema.safeParse(10.5).success).toBe(false);
  });

  it("accepts E.164 phones and rejects local formats", () => {
    expect(PhoneSchema.parse("+919876543210")).toBe("+919876543210");
    expect(PhoneSchema.safeParse("9876543210").success).toBe(false);
    expect(PhoneSchema.safeParse("+0123456789").success).toBe(false);
    expect(PhoneSchema.safeParse("+91 98765 43210").success).toBe(false);
  });
});

describe("enums", () => {
  it("round-trips every Role value", () => {
    for (const value of Object.values(Role)) {
      expect(RoleSchema.parse(value)).toBe(value);
    }
  });

  it("round-trips every OrderStatus value", () => {
    for (const value of Object.values(OrderStatus)) {
      expect(OrderStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects values outside the enum", () => {
    expect(RoleSchema.safeParse("SUPERADMIN").success).toBe(false);
    expect(OrderStatusSchema.safeParse("SHIPPED").success).toBe(false);
  });
});

describe("order create", () => {
  it("parses a valid COD order body", () => {
    const body = CreateOrderBodySchema.parse({
      addressId: "ckaddr123",
      paymentMethod: "COD",
    });
    expect(body.couponCode).toBeUndefined();
  });

  it("parses a valid PREPAID order body with coupon", () => {
    const body = CreateOrderBodySchema.parse({
      addressId: "ckaddr123",
      paymentMethod: "PREPAID",
      couponCode: "WELCOME50",
    });
    expect(body.paymentMethod).toBe("PREPAID");
  });

  it("rejects an unknown payment method and a missing address", () => {
    expect(
      CreateOrderBodySchema.safeParse({ addressId: "x", paymentMethod: "WALLET" }).success,
    ).toBe(false);
    expect(CreateOrderBodySchema.safeParse({ paymentMethod: "COD" }).success).toBe(false);
  });

  it("create response: razorpay block optional (COD) but validated when present (PREPAID)", () => {
    const order = {
      id: "ckorder1",
      orderNo: "MR-250705-0042",
      status: "PLACED",
      paymentMethod: "COD",
      paymentStatus: "COD_DUE",
      addressSnapshot: {
        name: "Asha",
        phone: "+919876543210",
        line1: "12 MG Road",
        pincode: "452001",
        lat: 22.72,
        lng: 75.86,
      },
      distanceM: 2100,
      itemsPaise: 24_900,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 26_900,
      couponCode: null,
      requiresRx: false,
      rxStatus: "NA",
      deliveryOtp: null,
      cancelReason: null,
      invoiceNo: null,
      placedAt: "2026-07-05T10:00:00.000Z",
      packedAt: null,
      readyAt: null,
      deliveredAt: null,
      cancelledAt: null,
      createdAt: "2026-07-05T10:00:00.000Z",
      items: [
        {
          id: "ckitem1",
          productId: "ckprod1",
          nameSnap: "Paracetamol 650",
          packSizeSnap: "Strip of 10",
          pricePaise: 2490,
          mrpPaise: 3000,
          gstRatePct: 12,
          hsnSnap: null,
          requiresRx: false,
          qty: 10,
        },
      ],
      events: [],
      prescriptions: [],
      driver: null,
    };

    expect(CreateOrderResponseSchema.safeParse({ data: { order } }).success).toBe(true);

    const prepaid = CreateOrderResponseSchema.safeParse({
      data: {
        order,
        razorpay: {
          rzpOrderId: "order_ABC123",
          rzpKeyId: "rzp_test_xyz",
          amountPaise: 26_900,
          currency: "INR",
        },
      },
    });
    expect(prepaid.success).toBe(true);

    const badCurrency = CreateOrderResponseSchema.safeParse({
      data: {
        order,
        razorpay: {
          rzpOrderId: "order_ABC123",
          rzpKeyId: "rzp_test_xyz",
          amountPaise: 26_900,
          currency: "USD",
        },
      },
    });
    expect(badCurrency.success).toBe(false);
  });
});

describe("envelopes", () => {
  it("wraps data and rejects a missing data key", () => {
    const schema = envelope(z.object({ ping: z.literal("pong") }));
    expect(schema.parse({ data: { ping: "pong" } })).toEqual({ data: { ping: "pong" } });
    expect(schema.safeParse({ ping: "pong" }).success).toBe(false);
  });

  it("paginated envelope requires meta.nextCursor (nullable)", () => {
    const schema = paginatedEnvelope(z.object({ id: z.string() }));
    expect(schema.safeParse({ data: [{ id: "a" }], meta: { nextCursor: null } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ data: [{ id: "a" }], meta: { nextCursor: "a" } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ data: [{ id: "a" }] }).success).toBe(false);
    expect(PaginationMetaSchema.safeParse({}).success).toBe(false);
  });

  it("error envelope carries an enum'd code", () => {
    const parsed = ApiErrorSchema.parse({
      error: { code: "STOCK_INSUFFICIENT", message: "2 items short" },
    });
    expect(parsed.error.code).toBe(ErrorCode.STOCK_INSUFFICIENT);
    expect(
      ApiErrorSchema.safeParse({ error: { code: "NOPE", message: "x" } }).success,
    ).toBe(false);
  });

  it("every error code has a default HTTP status", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("pagination query", () => {
  it("defaults limit to 20 and coerces from query strings", () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(CursorQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("caps limit at 50 and floors at 1", () => {
    expect(CursorQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(CursorQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe("socket contract", () => {
  it("builds room names", () => {
    expect(orderRoom("ck123")).toBe("order:ck123");
    expect(driverRoom("ck456")).toBe("driver:ck456");
    expect(OPS_ROOM).toBe("ops");
  });

  it("validates an offer:new payload", () => {
    const payload = {
      offerId: "ckoffer1",
      orderId: "ckorder1",
      pickup: { lat: 22.7196, lng: 75.8577, address: "MedRush Store, MG Road" },
      drop: { lat: 22.7301, lng: 75.8802, address: "12 Palasia" },
      distanceM: 2800,
      commissionPaise: 4000,
      expiresInSec: 25,
    };
    expect(OfferNewEventSchema.parse(payload)).toEqual(payload);
    expect(OfferNewEventSchema.safeParse({ ...payload, expiresInSec: 0 }).success).toBe(false);
  });
});

describe("rx review body", () => {
  it("requires a note when rejecting, not when approving", () => {
    expect(RxReviewBodySchema.safeParse({ status: RxStatus.APPROVED }).success).toBe(true);
    expect(RxReviewBodySchema.safeParse({ status: RxStatus.REJECTED }).success).toBe(false);
    expect(
      RxReviewBodySchema.safeParse({ status: RxStatus.REJECTED, note: "illegible prescription" })
        .success,
    ).toBe(true);
    // trimmed-empty note is absent, so rejection still fails
    expect(RxReviewBodySchema.safeParse({ status: RxStatus.REJECTED, note: "   " }).success).toBe(
      false,
    );
  });
});

describe("state machine table", () => {
  it("allows the happy path and blocks illegal jumps", () => {
    expect(isValidOrderTransition(OrderStatus.PLACED, OrderStatus.PACKING)).toBe(true);
    expect(isValidOrderTransition(OrderStatus.READY, OrderStatus.ASSIGNED)).toBe(true);
    expect(isValidOrderTransition(OrderStatus.ASSIGNED, OrderStatus.READY)).toBe(true); // driver cancel
    expect(isValidOrderTransition(OrderStatus.PLACED, OrderStatus.DELIVERED)).toBe(false);
    expect(isValidOrderTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toBe(false);
  });
});
