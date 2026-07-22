import { randomUUID } from "node:crypto";
import type { Address, Prisma, Product } from "@prisma/client";
import {
  ActorType,
  AdjustReason,
  AlertKind,
  CUSTOMER_CANCELABLE_STATUSES,
  CUSTOMER_CANCEL_REQUEST_STATUSES,
  COD_REFUSAL_DISABLE_THRESHOLD,
  CancelOrderOutcome,
  CouponKind,
  MAX_ORDERS_PER_HOUR,
  NEW_ACCOUNT_COD_CAP_PAISE,
  OrderStatus,
  PAYMENT_TIMEOUT_MIN,
  PaymentMethod,
  PaymentStatus,
  RiskFlag,
  Role,
  RxStatus,
  type AddressSnapshot,
  type CancelOrderResult,
  type CreateOrderResult,
  type GstRate,
  type Order,
  type OrderDetail,
  type OrderDriver,
  type OrderEvent,
  type OrderItem,
  type OrderListQuery,
  type OrderSummary,
  type Prescription,
  type RetryPaymentResult,
  type TrackOrderResult,
  type TrackTimelineEntry,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { getFlag } from "../../core/flags";
import { logger } from "../../core/logger";
import { emitOpsAlert, emitOrderNew, emitOrderStatus } from "../../core/realtime";
import { getStoreConfig, haversineM, isStoreOpenNow } from "../../core/storeInfo";
import { clearDriverLocation, getDriverLocation } from "../../core/locationStore";
import { notifyUser } from "../notifications/service";
import { createRazorpayOrder, razorpayKeyId } from "../../core/razorpay";
import { enqueuePaymentTimeout } from "../../jobs/paymentTimeout";
import { initiateRefund } from "../payments/service";
import { computeTotals, type PricedItem, type PricingCoupon } from "./pricing";
import { makeOrderNo } from "./orderNo";
import { assertTransition } from "./stateMachine";

/**
 * Customer order service (BLUEPRINT §9.1-§9.4, §10.3, §18.3).
 *
 * Ownership lives here (§8.3): every entry point takes the authenticated
 * `userId`; a customer only ever touches their own orders. Status legality is
 * asserted via the state machine INSIDE the transaction, exactly one OrderEvent
 * is written per transition, money is integer paise, and socket emits happen
 * only AFTER the DB transaction commits.
 *
 * The cross-agent surface (pinned in the phase-1 brief) is `restockOrder`,
 * consumed by agent D's ops cancel.
 */

/** Shared note marker for a customer cancel that ops must approve (§18.3). */
const CANCEL_REQUESTED_NOTE = "cancel-requested";

/* --------------------------------------------------------------- mappers */

/** Narrow structural views of the Prisma rows the mappers read (decoupled from
 * generated generics — a fetched row with extra fields is assignable). */
interface MappableItem {
  id: string;
  productId: string;
  nameSnap: string;
  packSizeSnap: string;
  pricePaise: number;
  mrpPaise: number;
  gstRatePct: number;
  hsnSnap: string | null;
  requiresRx: boolean;
  qty: number;
}
interface MappableEvent {
  from: OrderStatus | null;
  to: OrderStatus;
  actorType: ActorType;
  note: string | null;
  createdAt: Date;
}
interface MappablePrescription {
  id: string;
  status: RxStatus;
  mimeType: string;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}
interface MappableDelivery {
  driver: {
    vehicleType: string;
    vehicleNo: string | null;
    user: { name: string | null; phone: string };
  };
}
interface MappablePayment {
  refundId: string | null;
  amountPaise: number;
  updatedAt: Date;
}
interface MappableOrder {
  id: string;
  orderNo: string;
  userId: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  addressSnapshot: unknown;
  distanceM: number;
  itemsPaise: number;
  deliveryPaise: number;
  discountPaise: number;
  totalPaise: number;
  couponCode: string | null;
  deliveryNote: string | null;
  contactless: boolean;
  patientId: string | null;
  /** Joined when the query includes `patient`; absent on lighter selects. */
  patient?: { name: string } | null;
  requiresRx: boolean;
  rxStatus: RxStatus;
  deliveryOtp: string | null;
  cancelReason: string | null;
  invoiceNo: string | null;
  placedAt: Date | null;
  packedAt: Date | null;
  readyAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  items: MappableItem[];
}

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

function mapItem(item: MappableItem): OrderItem {
  return {
    id: item.id,
    productId: item.productId,
    nameSnap: item.nameSnap,
    packSizeSnap: item.packSizeSnap,
    pricePaise: item.pricePaise,
    mrpPaise: item.mrpPaise,
    gstRatePct: item.gstRatePct as GstRate,
    hsnSnap: item.hsnSnap,
    requiresRx: item.requiresRx,
    qty: item.qty,
  };
}

/** Common `OrderSchema` fields. `deliveryOtp` is exposed only to the owner (§9.7). */
function baseOrder(order: MappableOrder, isOwner: boolean): Order {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    addressSnapshot: order.addressSnapshot as AddressSnapshot,
    distanceM: order.distanceM,
    itemsPaise: order.itemsPaise,
    deliveryPaise: order.deliveryPaise,
    discountPaise: order.discountPaise,
    totalPaise: order.totalPaise,
    couponCode: order.couponCode,
    deliveryNote: order.deliveryNote,
    contactless: order.contactless,
    patientId: order.patientId,
    patientName: order.patient?.name ?? null,
    requiresRx: order.requiresRx,
    rxStatus: order.rxStatus,
    // Non-null only for the owning customer once READY (OTP is set at READY).
    deliveryOtp: isOwner ? (order.deliveryOtp ?? null) : null,
    cancelReason: order.cancelReason,
    invoiceNo: order.invoiceNo,
    placedAt: isoOrNull(order.placedAt),
    packedAt: isoOrNull(order.packedAt),
    readyAt: isoOrNull(order.readyAt),
    deliveredAt: isoOrNull(order.deliveredAt),
    cancelledAt: isoOrNull(order.cancelledAt),
    createdAt: order.createdAt.toISOString(),
    items: order.items.map(mapItem),
  };
}

function mapEvent(event: MappableEvent): OrderEvent {
  return {
    from: event.from,
    to: event.to,
    actorType: event.actorType,
    note: event.note,
    createdAt: event.createdAt.toISOString(),
  };
}

function mapPrescription(rx: MappablePrescription): Prescription {
  return {
    id: rx.id,
    status: rx.status,
    mimeType: rx.mimeType,
    reviewNote: rx.reviewNote,
    createdAt: rx.createdAt.toISOString(),
    reviewedAt: isoOrNull(rx.reviewedAt),
  };
}

function toOrderDetail(
  order: MappableOrder & {
    events: MappableEvent[];
    prescriptions: MappablePrescription[];
    delivery: MappableDelivery | null;
    payment: MappablePayment | null;
  },
  isOwner: boolean,
): OrderDetail {
  // Refund visibility (Batch 2): the block appears only once a refund is in
  // flight or settled — refundId stays null while initiation is being claimed.
  const refundVisible =
    order.paymentStatus === PaymentStatus.REFUND_INITIATED ||
    order.paymentStatus === PaymentStatus.REFUNDED;
  return {
    ...baseOrder(order, isOwner),
    events: order.events.map(mapEvent),
    prescriptions: order.prescriptions.map(mapPrescription),
    driver: order.delivery
      ? {
          name: order.delivery.driver.user.name,
          phone: order.delivery.driver.user.phone,
          vehicleType: order.delivery.driver.vehicleType,
          vehicleNo: order.delivery.driver.vehicleNo,
        }
      : null,
    refund:
      refundVisible && order.payment
        ? {
            refundId: order.payment.refundId,
            amountPaise: order.payment.amountPaise,
            updatedAt: order.payment.updatedAt.toISOString(),
          }
        : null,
  };
}

const detailInclude = {
  items: { orderBy: { id: "asc" } },
  events: { orderBy: { createdAt: "asc" } },
  prescriptions: { orderBy: { createdAt: "asc" } },
  patient: { select: { name: true } },
  delivery: {
    include: { driver: { include: { user: { select: { name: true, phone: true } } } } },
  },
  payment: { select: { refundId: true, amountPaise: true, updatedAt: true } },
} satisfies Prisma.OrderInclude;

/* ------------------------------------------------------------- create (§9.2) */

/**
 * COD checkout (§9.2 validation order → §9.4 reservation). PREPAID is Phase 2.
 * Returns the wire-shaped `CreateOrderResult`; the route wraps this in
 * `withIdempotency` (24h replay) and answers 201 (new) / 200 (replayed).
 */
export async function createOrder(userId: string, body: CreateOrderInput): Promise<CreateOrderResult> {
  const ctx = await prepareCheckout(userId, body);
  return body.paymentMethod === PaymentMethod.PREPAID
    ? createPrepaidOrder(userId, ctx)
    : createCodOrder(userId, ctx);
}

/** Shared, payment-method-agnostic checkout context (§9.2 validation output). */
interface CheckoutContext {
  storeConfig: Awaited<ReturnType<typeof getStoreConfig>>;
  address: Address;
  distanceM: number;
  lineItems: { product: Product; qty: number }[];
  totals: ReturnType<typeof computeTotals>;
  requiresRx: boolean;
  couponRow: CouponRow | null;
  cart: { id: string };
  deliveryNote: string | null;
  contactless: boolean;
  patientId: string | null;
  patientName: string | null;
}

/**
 * Steps 1–5 of §9.2 (store open, address in-radius, cart valid, totals from PG
 * prices, coupon) — identical for COD and PREPAID; the payment-method branch
 * adds its own gates + reservation after.
 */
async function prepareCheckout(userId: string, body: CreateOrderInput): Promise<CheckoutContext> {
  const prisma = getPrisma();

  // 1) Store open: manual kill-switch + hours + maintenance flag off (§9.2).
  const storeConfig = await getStoreConfig();
  const maintenance = await getFlag<unknown>("maintenance_banner", false);
  if (maintenance) {
    throw new AppError("STORE_CLOSED", "The store is temporarily closed for maintenance", 422);
  }
  if (!isStoreOpenNow(storeConfig)) {
    throw new AppError("STORE_CLOSED", "The store is currently closed", 422);
  }

  // 2) Address belongs to the user + within the service radius (haversine).
  const address = await prisma.address.findUnique({ where: { id: body.addressId } });
  if (!address || address.userId !== userId) {
    throw new AppError("NOT_FOUND", "Delivery address not found", 404);
  }

  // 2b) Optional dependent profile — must belong to the caller (404 rather
  // than 403 so a stranger's profile id is indistinguishable from a typo).
  let patient: { id: string; name: string } | null = null;
  if (body.patientId !== undefined) {
    const row = await prisma.patient.findUnique({ where: { id: body.patientId } });
    if (!row || row.userId !== userId) {
      throw new AppError("NOT_FOUND", "Patient profile not found", 404);
    }
    patient = { id: row.id, name: row.name };
  }
  const distanceM = haversineM(
    { lat: storeConfig.lat, lng: storeConfig.lng },
    { lat: address.lat, lng: address.lng },
  );
  if (distanceM > storeConfig.serviceRadiusM) {
    throw new AppError("OUT_OF_SERVICE_AREA", "This address is outside our delivery area", 422, {
      distanceM,
      serviceRadiusM: storeConfig.serviceRadiusM,
    });
  }

  // 3) Cart non-empty; each item active, qty ≤ maxPerOrder (§9.2).
  const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: true } });
  if (!cart || cart.items.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Your cart is empty", 422);
  }
  const products = await prisma.product.findMany({
    where: { id: { in: cart.items.map((line) => line.productId) } },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const lineItems = cart.items.map((line) => {
    const product = productById.get(line.productId);
    if (!product || !product.isActive) {
      throw new AppError("VALIDATION_ERROR", "A product in your cart is no longer available", 422, {
        productId: line.productId,
      });
    }
    if (line.qty > product.maxPerOrder) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Quantity ${line.qty} exceeds the per-order limit of ${product.maxPerOrder}`,
        422,
        { productId: line.productId, requestedQty: line.qty, maxPerOrder: product.maxPerOrder },
      );
    }
    return { product, qty: line.qty };
  });

  // 4) Totals recomputed from PG prices (client totals ignored, §9.2).
  const pricedItems: PricedItem[] = lineItems.map((li) => ({
    pricePaise: li.product.pricePaise,
    qty: li.qty,
  }));
  const itemsPaise = pricedItems.reduce((sum, li) => sum + li.pricePaise * li.qty, 0);

  // Store min-order gate runs BEFORE coupon validation (§9.2 check order): a
  // below-minimum cart must surface MIN_ORDER_NOT_MET, not a coupon error.
  if (itemsPaise < storeConfig.minOrderPaise) {
    throw new AppError(
      "MIN_ORDER_NOT_MET",
      `Minimum order value is ₹${(storeConfig.minOrderPaise / 100).toFixed(2)}`,
      422,
      { minOrderPaise: storeConfig.minOrderPaise, itemsPaise },
    );
  }

  // 5) Coupon (active, window, usageLimit, perUserLimit, minOrder).
  let couponRow: CouponRow | null = null;
  let pricingCoupon: PricingCoupon | undefined;
  if (body.couponCode) {
    couponRow = await validateCoupon(body.couponCode.toUpperCase(), itemsPaise, userId);
    pricingCoupon = {
      kind: couponRow.kind as CouponKind,
      valuePaiseOrPct: couponRow.valuePaiseOrPct,
      maxDiscountPaise: couponRow.maxDiscountPaise,
    };
  }

  // Arithmetic + store min-order (throws MIN_ORDER_NOT_MET below the threshold).
  const totals = computeTotals(pricedItems, storeConfig, pricingCoupon);
  const requiresRx = lineItems.some((li) => li.product.requiresRx);

  return {
    storeConfig,
    address,
    distanceM,
    lineItems,
    totals,
    requiresRx,
    couponRow,
    cart: { id: cart.id },
    // Already trimmed + length-bounded by the contract; absent → null/false.
    deliveryNote: body.deliveryNote ?? null,
    contactless: body.contactless ?? false,
    patientId: patient ? patient.id : null,
    patientName: patient ? patient.name : null,
  };
}

/**
 * COD checkout (§9.2 #6 gates → §9.4 reservation): lands PLACED (or RX_REVIEW),
 * paymentStatus COD_DUE, and pings the ops board. Body unchanged from Phase 1.
 */
async function createCodOrder(userId: string, ctx: CheckoutContext): Promise<CreateOrderResult> {
  const prisma = getPrisma();
  const { storeConfig, address, distanceM, lineItems, totals, requiresRx, couponRow, cart } = ctx;
  const { deliveryNote, contactless, patientId } = ctx;

  // 6) COD gates (§10.3) then velocity rule (§10.3). These pre-TX checks are a
  // fast-fail optimisation only — the authoritative re-check runs INSIDE the
  // transaction under the User row lock (assertFraudGatesInTx).
  await assertCodAllowed(userId, totals.totalPaise, storeConfig.codLimitPaise);
  await assertVelocity(userId);

  // 7) Reserve stock (§9.4) + create the order atomically. A generous timeout
  // covers the row-lock contention exercised by the parallel stock-race test.
  const orderId = await prisma.$transaction(
    async (tx) => {
      // Authoritative fraud gates first (§10.3 TOCTOU fix) — takes the User row
      // lock, so same-account checkouts serialise before any stock is touched.
      await assertFraudGatesInTx(tx, userId, { totalPaise: totals.totalPaise });

      const shortages: { productId: string; requestedQty: number }[] = [];
      for (const li of lineItems) {
        const affected = await tx.$executeRaw`
          UPDATE "Product" SET "stockQty" = "stockQty" - ${li.qty}
          WHERE "id" = ${li.product.id} AND "stockQty" >= ${li.qty}
        `;
        if (affected !== 1) shortages.push({ productId: li.product.id, requestedQty: li.qty });
      }
      if (shortages.length > 0) {
        const fresh = await tx.product.findMany({
          where: { id: { in: shortages.map((s) => s.productId) } },
          select: { id: true, stockQty: true },
        });
        const stockById = new Map(fresh.map((p) => [p.id, p.stockQty]));
        throw new AppError("STOCK_INSUFFICIENT", "Some items are no longer in stock", 409, {
          items: shortages.map((s) => ({
            productId: s.productId,
            requestedQty: s.requestedQty,
            availableQty: stockById.get(s.productId) ?? 0,
          })),
        });
      }

      const status = requiresRx ? OrderStatus.RX_REVIEW : OrderStatus.PLACED;
      const rxStatus = requiresRx ? RxStatus.PENDING : RxStatus.NA;
      const now = new Date();
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true, phone: true },
      });
      const addressSnapshot: AddressSnapshot = {
        name: user.name ?? "",
        phone: user.phone,
        label: address.label,
        line1: address.line1,
        line2: address.line2,
        landmark: address.landmark,
        pincode: address.pincode,
        lat: address.lat,
        lng: address.lng,
      };

      const created = await tx.order.create({
        data: {
          // Placeholder — the real MR-… number is set below from the autoincrement seq.
          orderNo: `TMP-${randomUUID()}`,
          userId,
          status,
          paymentMethod: PaymentMethod.COD,
          paymentStatus: PaymentStatus.COD_DUE,
          addressSnapshot: addressSnapshot as unknown as Prisma.InputJsonValue,
          distanceM,
          itemsPaise: totals.itemsPaise,
          deliveryPaise: totals.deliveryPaise,
          discountPaise: totals.discountPaise,
          totalPaise: totals.totalPaise,
          couponCode: couponRow ? couponRow.code : null,
          deliveryNote,
          contactless,
          patientId,
          requiresRx,
          rxStatus,
          placedAt: now,
          items: {
            create: lineItems.map((li) => ({
              productId: li.product.id,
              nameSnap: li.product.name,
              packSizeSnap: li.product.packSize,
              pricePaise: li.product.pricePaise,
              mrpPaise: li.product.mrpPaise,
              gstRatePct: li.product.gstRatePct,
              hsnSnap: li.product.hsnCode,
              requiresRx: li.product.requiresRx,
              qty: li.qty,
            })),
          },
        },
        select: { id: true, seq: true, createdAt: true },
      });

      await tx.order.update({
        where: { id: created.id },
        data: { orderNo: makeOrderNo(created.seq, created.createdAt) },
      });

      await tx.stockAdjustment.createMany({
        data: lineItems.map((li) => ({
          productId: li.product.id,
          delta: -li.qty,
          reason: AdjustReason.SALE,
          refOrderId: created.id,
          actorId: userId,
        })),
      });

      // Clear the cart (§9.4) — the order is now the source of truth.
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // Exactly one OrderEvent for the create transition (null → status).
      await tx.orderEvent.create({
        data: {
          orderId: created.id,
          from: null,
          to: status,
          actorType: ActorType.CUSTOMER,
          actorId: userId,
        },
      });

      if (couponRow) {
        // Re-check limits under a coupon-row lock before recording the redemption
        // (closes the pre-TX check-then-insert race). Over-limit → rollback,
        // which also releases the stock reserved above.
        await assertCouponRedeemableInTx(tx, couponRow, userId);
        await tx.couponRedemption.create({
          data: { couponId: couponRow.id, userId, orderId: created.id },
        });
      }

      return created.id;
    },
    { timeout: 15_000, maxWait: 10_000 },
  );

  const detail = await loadOrderDetail(orderId, userId);

  // Socket emit AFTER commit (§9.1) — the ops board plays the new-order sound.
  emitOrderNew({
    id: detail.id,
    orderNo: detail.orderNo,
    status: detail.status,
    paymentMethod: detail.paymentMethod,
    requiresRx: detail.requiresRx,
    rxStatus: detail.rxStatus,
    totalPaise: detail.totalPaise,
    placedAt: detail.placedAt,
  });
  await notifyUser({
    userId,
    type: "ORDER_PLACED",
    title: "Order placed",
    body: `We've received your order ${detail.orderNo} and started getting it ready.`,
    data: { orderId: detail.id },
  });

  return { order: detail };
}

/**
 * PREPAID checkout (phase-2 brief §1). Reserves stock at create (same §9.4
 * conditional UPDATE as COD), creates a Razorpay order + a Payment row, and
 * lands the order at PENDING_PAYMENT (paymentStatus PENDING, not yet placed),
 * then enqueues the 15-min payment-timeout. The order stays invisible to ops
 * until the `payment.captured` webhook promotes it — so NO order:new emit here.
 * Returns the Razorpay checkout handoff for the client sheet.
 */
async function createPrepaidOrder(userId: string, ctx: CheckoutContext): Promise<CreateOrderResult> {
  const prisma = getPrisma();
  const { address, distanceM, lineItems, totals, requiresRx, couponRow, cart } = ctx;
  const { deliveryNote, contactless, patientId } = ctx;

  // Velocity rule (§10.3) — applies to every checkout, prepaid included. Fast
  // fail only; the authoritative re-check runs in-TX (assertFraudGatesInTx).
  await assertVelocity(userId);

  // Razorpay order created BEFORE the tx (external, §14). Keeping the DB mutation
  // one atomic tx preserves idempotency: a reservation failure rolls everything
  // back and a retry is safe; the orphaned Razorpay order simply expires unpaid.
  const receipt = `rcpt_${randomUUID().replace(/-/g, "").slice(0, 34)}`;
  const rzp = await createRazorpayOrder(totals.totalPaise, receipt);

  const orderId = await prisma.$transaction(
    async (tx) => {
      // Authoritative velocity re-check under the User row lock (§10.3 TOCTOU
      // fix) — the first-order COD cap does not apply to PREPAID.
      await assertFraudGatesInTx(tx, userId);

      await reserveStockOrThrow(tx, lineItems);

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true, phone: true },
      });
      const addressSnapshot: AddressSnapshot = {
        name: user.name ?? "",
        phone: user.phone,
        label: address.label,
        line1: address.line1,
        line2: address.line2,
        landmark: address.landmark,
        pincode: address.pincode,
        lat: address.lat,
        lng: address.lng,
      };

      const created = await tx.order.create({
        data: {
          orderNo: `TMP-${randomUUID()}`,
          userId,
          status: OrderStatus.PENDING_PAYMENT,
          paymentMethod: PaymentMethod.PREPAID,
          paymentStatus: PaymentStatus.PENDING,
          addressSnapshot: addressSnapshot as unknown as Prisma.InputJsonValue,
          distanceM,
          itemsPaise: totals.itemsPaise,
          deliveryPaise: totals.deliveryPaise,
          discountPaise: totals.discountPaise,
          totalPaise: totals.totalPaise,
          couponCode: couponRow ? couponRow.code : null,
          deliveryNote,
          contactless,
          patientId,
          requiresRx,
          rxStatus: requiresRx ? RxStatus.PENDING : RxStatus.NA,
          // placedAt stays null until payment.captured promotes the order.
          items: {
            create: lineItems.map((li) => ({
              productId: li.product.id,
              nameSnap: li.product.name,
              packSizeSnap: li.product.packSize,
              pricePaise: li.product.pricePaise,
              mrpPaise: li.product.mrpPaise,
              gstRatePct: li.product.gstRatePct,
              hsnSnap: li.product.hsnCode,
              requiresRx: li.product.requiresRx,
              qty: li.qty,
            })),
          },
        },
        select: { id: true, seq: true, createdAt: true },
      });

      await tx.order.update({
        where: { id: created.id },
        data: { orderNo: makeOrderNo(created.seq, created.createdAt) },
      });

      // Payment row — the rzpOrderId links the webhook back to this order.
      await tx.payment.create({
        data: { orderId: created.id, rzpOrderId: rzp.id, amountPaise: totals.totalPaise },
      });

      await tx.stockAdjustment.createMany({
        data: lineItems.map((li) => ({
          productId: li.product.id,
          delta: -li.qty,
          reason: AdjustReason.SALE,
          refOrderId: created.id,
          actorId: userId,
        })),
      });

      // Clear the cart (§9.4) — the order snapshot is now the source of truth.
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // Exactly one OrderEvent for the create transition (null → PENDING_PAYMENT).
      await tx.orderEvent.create({
        data: {
          orderId: created.id,
          from: null,
          to: OrderStatus.PENDING_PAYMENT,
          actorType: ActorType.CUSTOMER,
          actorId: userId,
        },
      });

      if (couponRow) {
        await assertCouponRedeemableInTx(tx, couponRow, userId);
        await tx.couponRedemption.create({
          data: { couponId: couponRow.id, userId, orderId: created.id },
        });
      }

      return created.id;
    },
    { timeout: 15_000, maxWait: 10_000 },
  );

  // Best-effort AFTER commit (§9.3): a miss is covered by the watchdog + job.
  await enqueuePaymentTimeout(orderId).catch((err) =>
    logger.warn({ err, orderId }, "payment-timeout enqueue failed (best-effort)"),
  );

  const detail = await loadOrderDetail(orderId, userId);
  return {
    order: detail,
    razorpay: {
      rzpOrderId: rzp.id,
      rzpKeyId: razorpayKeyId(),
      amountPaise: totals.totalPaise,
      currency: "INR",
    },
  };
}

/**
 * Conditional stock reservation (§9.4) inside the caller's tx — one guarded
 * `UPDATE … WHERE stockQty >= qty` per line; any miss throws STOCK_INSUFFICIENT
 * with live availability, rolling back every reservation made in the tx.
 */
async function reserveStockOrThrow(
  tx: Prisma.TransactionClient,
  lineItems: { product: Product; qty: number }[],
): Promise<void> {
  const shortages: { productId: string; requestedQty: number }[] = [];
  for (const li of lineItems) {
    const affected = await tx.$executeRaw`
      UPDATE "Product" SET "stockQty" = "stockQty" - ${li.qty}
      WHERE "id" = ${li.product.id} AND "stockQty" >= ${li.qty}
    `;
    if (affected !== 1) shortages.push({ productId: li.product.id, requestedQty: li.qty });
  }
  if (shortages.length > 0) {
    const fresh = await tx.product.findMany({
      where: { id: { in: shortages.map((s) => s.productId) } },
      select: { id: true, stockQty: true },
    });
    const stockById = new Map(fresh.map((p) => [p.id, p.stockQty]));
    throw new AppError("STOCK_INSUFFICIENT", "Some items are no longer in stock", 409, {
      items: shortages.map((s) => ({
        productId: s.productId,
        requestedQty: s.requestedQty,
        availableQty: stockById.get(s.productId) ?? 0,
      })),
    });
  }
}

/** Fields the create route hands the service (from `CreateOrderBodySchema`). */
export interface CreateOrderInput {
  addressId: string;
  paymentMethod: PaymentMethod;
  couponCode?: string;
  deliveryNote?: string;
  contactless?: boolean;
  /** Dependent profile the order is for; validated against the caller. */
  patientId?: string;
}

/* ------------------------------------------------------------- COD + fraud */

async function assertCodAllowed(
  userId: string,
  totalPaise: number,
  codLimitPaise: number,
): Promise<void> {
  const prisma = getPrisma();

  const codEnabled = await getFlag<boolean>("cod_enabled", true);
  if (!codEnabled) {
    throw new AppError("COD_DISABLED", "Cash on delivery is currently unavailable", 422);
  }
  if (totalPaise > codLimitPaise) {
    throw new AppError(
      "COD_LIMIT_EXCEEDED",
      `Cash on delivery is available only up to ₹${(codLimitPaise / 100).toFixed(2)}`,
      422,
      { totalPaise, codLimitPaise },
    );
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { codRefusalCount: true, riskFlag: true },
  });
  if (
    user.codRefusalCount >= COD_REFUSAL_DISABLE_THRESHOLD ||
    user.riskFlag === RiskFlag.COD_BLOCKED ||
    user.riskFlag === RiskFlag.BLOCKED
  ) {
    throw new AppError(
      "COD_DISABLED",
      "Cash on delivery is disabled on this account — please pay online",
      422,
    );
  }

  // New-account guard: the first ever order is COD-capped (§10.3).
  await assertFirstOrderCodCap(userId, totalPaise);
}

/**
 * New-account guard (§10.3): the first ever order is COD-capped. CANCELLED
 * orders don't count — otherwise a throwaway placed-then-cancelled order would
 * lift the cap for the "real" first order. Runs pre-TX (fast fail, default
 * client) AND in-TX under the User row lock (authoritative — pass `db`).
 */
async function assertFirstOrderCodCap(
  userId: string,
  totalPaise: number,
  db: Prisma.TransactionClient = getPrisma(),
): Promise<void> {
  const priorOrders = await db.order.count({
    where: { userId, status: { not: OrderStatus.CANCELLED } },
  });
  if (priorOrders > 0) return;
  const cap = await getFlag<number>("new_account_cod_cap", NEW_ACCOUNT_COD_CAP_PAISE);
  if (totalPaise > cap) {
    throw new AppError(
      "COD_LIMIT_EXCEEDED",
      `Your first cash-on-delivery order is limited to ₹${(cap / 100).toFixed(
        2,
      )} — please pay online for higher amounts`,
      422,
      { totalPaise, newAccountCapPaise: cap },
    );
  }
}

/** Velocity rule (§10.3): >3 orders/hour/user → 429 + ops alert (no order to
 * hang an OrderEvent on, so the hit lands as a FRAUD_VELOCITY ops alert + log).
 * Runs pre-TX (fast fail, default client) AND in-TX under the User row lock
 * (authoritative — pass `db`). `emitOpsAlert` persists via the ROOT client,
 * fire-and-forget, so an in-TX trip keeps its alert row after the rollback. */
async function assertVelocity(
  userId: string,
  db: Prisma.TransactionClient = getPrisma(),
): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db.order.count({
    where: { userId, createdAt: { gte: since } },
  });
  if (recent >= MAX_ORDERS_PER_HOUR) {
    emitOpsAlert(
      AlertKind.FRAUD_VELOCITY,
      `Order velocity limit tripped for user ${userId} (${recent} orders in the last hour)`,
    );
    logger.warn({ userId, recent }, "checkout velocity limit tripped");
    throw new AppError("RATE_LIMITED", "Too many orders in a short period — please try again later", 429, {
      limit: MAX_ORDERS_PER_HOUR,
    });
  }
}

/**
 * Authoritative fraud-gate enforcement — runs INSIDE the order-create
 * transaction (mirrors `assertCouponRedeemableInTx`). The pre-TX
 * `assertVelocity` / `assertCodAllowed` counts are a fast-fail optimisation but
 * race (check-then-insert TOCTOU): N parallel checkouts from one account can
 * each read a passing count before any of them commits, collectively exceeding
 * the 3-orders/hour velocity rule or the first-order COD cap. Here we
 * `SELECT … FOR UPDATE` the User row so all concurrent checkouts from the same
 * account serialise on it, then re-count under the lock — a loser sees the
 * committed orders and rolls back (releasing anything reserved after this
 * point; it runs FIRST in the tx, so normally nothing is). Throws the same
 * error codes/envelopes as the pre-TX checks.
 */
async function assertFraudGatesInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  cod?: { totalPaise: number },
): Promise<void> {
  // Row lock held until the transaction commits/rolls back; blocks competing txns.
  await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  await assertVelocity(userId, tx);
  if (cod) await assertFirstOrderCodCap(userId, cod.totalPaise, tx);
}

interface CouponRow {
  id: string;
  code: string;
  kind: string;
  valuePaiseOrPct: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  usageLimit: number | null;
  perUserLimit: number;
}

export async function validateCoupon(
  code: string,
  itemsPaise: number,
  userId: string,
): Promise<CouponRow> {
  const prisma = getPrisma();
  const coupon = await prisma.coupon.findUnique({ where: { code } });
  if (!coupon || !coupon.isActive) {
    throw new AppError("COUPON_INVALID", "This coupon is not valid", 422);
  }
  // Personal coupons (referral reward / welcome offer) are bound to one
  // account. Same message as "not valid" so a code can't be probed for
  // existence by a stranger.
  if (coupon.userId !== null && coupon.userId !== userId) {
    throw new AppError("COUPON_INVALID", "This coupon is not valid", 422);
  }
  const now = new Date();
  if (now < coupon.startsAt || now > coupon.endsAt) {
    throw new AppError("COUPON_INVALID", "This coupon is not currently active", 422);
  }
  if (itemsPaise < coupon.minOrderPaise) {
    throw new AppError(
      "COUPON_INVALID",
      `This coupon needs a minimum order of ₹${(coupon.minOrderPaise / 100).toFixed(2)}`,
      422,
    );
  }
  if (coupon.usageLimit !== null) {
    const total = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
    if (total >= coupon.usageLimit) {
      throw new AppError("COUPON_INVALID", "This coupon has reached its usage limit", 422);
    }
  }
  const perUser = await prisma.couponRedemption.count({
    where: { couponId: coupon.id, userId },
  });
  if (perUser >= coupon.perUserLimit) {
    throw new AppError("COUPON_INVALID", "You have already used this coupon", 422);
  }
  return coupon;
}

/**
 * Authoritative coupon-limit enforcement — runs INSIDE the create transaction.
 * The pre-TX `validateCoupon` counts are a fast-fail optimisation but race
 * (check-then-insert TOCTOU): two concurrent checkouts can both read count=0 and
 * each redeem a one-time coupon. Here we `SELECT … FOR UPDATE` the Coupon row so
 * all concurrent redeemers of the same coupon serialise on it, then re-count
 * under the lock — the loser sees the committed redemption and is rejected. This
 * handles any usageLimit / perUserLimit value (no schema change, unlike a
 * `@@unique([couponId,userId])` which would only fit perUserLimit=1).
 */
async function assertCouponRedeemableInTx(
  tx: Prisma.TransactionClient,
  coupon: CouponRow,
  userId: string,
): Promise<void> {
  // Row lock held until the transaction commits/rolls back; blocks competing txns.
  await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${coupon.id} FOR UPDATE`;
  if (coupon.usageLimit !== null) {
    const total = await tx.couponRedemption.count({ where: { couponId: coupon.id } });
    if (total >= coupon.usageLimit) {
      throw new AppError("COUPON_INVALID", "This coupon has reached its usage limit", 422);
    }
  }
  const perUser = await tx.couponRedemption.count({
    where: { couponId: coupon.id, userId },
  });
  if (perUser >= coupon.perUserLimit) {
    throw new AppError("COUPON_INVALID", "You have already used this coupon", 422);
  }
}

/* ---------------------------------------------------------------- reads */

async function loadOrderDetail(id: string, viewerUserId: string): Promise<OrderDetail> {
  const order = await getPrisma().order.findUnique({ where: { id }, include: detailInclude });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
  return toOrderDetail(order, order.userId === viewerUserId);
}

/** GET /v1/orders/:id — own, or INVENTORY/ADMIN. OTP only for the owner (§9.7). */
export async function getOrder(userId: string, role: Role, id: string): Promise<OrderDetail> {
  const order = await getPrisma().order.findUnique({ where: { id }, include: detailInclude });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
  const isStaff = role === Role.INVENTORY || role === Role.ADMIN;
  if (order.userId !== userId && !isStaff) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  return toOrderDetail(order, order.userId === userId);
}

/**
 * GET /v1/orders/:id/payment — re-serve the Razorpay checkout handoff for an
 * owned PREPAID order still at PENDING_PAYMENT. The customer dismissed the
 * sheet and navigated away: the cart was already consumed by the create TX, so
 * without this the order is stranded (detail shows only "Cancel"). Returns the
 * SAME rzpOrderId minted at create — a Razorpay order stays payable until it is
 * paid or expires — plus the auto-cancel deadline (createdAt + §9.3 payment
 * timeout) for the client countdown. Owner-scoped 404 (IDOR convention);
 * 409 CONFLICT for COD orders and for orders no longer awaiting payment.
 */
export async function getPaymentHandoff(userId: string, id: string): Promise<RetryPaymentResult> {
  const order = await getPrisma().order.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      paymentMethod: true,
      totalPaise: true,
      createdAt: true,
      payment: { select: { rzpOrderId: true } },
    },
  });
  if (!order || order.userId !== userId) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  if (order.paymentMethod !== PaymentMethod.PREPAID) {
    throw new AppError("CONFLICT", "This order has no online payment to retry", 409, {
      paymentMethod: order.paymentMethod,
    });
  }
  // A PREPAID order gets its Payment row in the create TX, so `payment` is only
  // null on data corruption — treat it like the not-awaiting-payment conflict.
  if (order.status !== OrderStatus.PENDING_PAYMENT || !order.payment) {
    throw new AppError("CONFLICT", "This order is no longer awaiting payment", 409, {
      status: order.status,
    });
  }
  return {
    razorpay: {
      rzpOrderId: order.payment.rzpOrderId,
      rzpKeyId: razorpayKeyId(),
      amountPaise: order.totalPaise,
      currency: "INR",
    },
    expiresAt: new Date(order.createdAt.getTime() + PAYMENT_TIMEOUT_MIN * 60_000).toISOString(),
  };
}

/** GET /v1/orders — cursor-paginated history for the caller (own only). */
export async function listOrders(
  userId: string,
  query: OrderListQuery,
): Promise<{ orders: OrderSummary[]; nextCursor: string | null }> {
  const rows = await getPrisma().order.findMany({
    where: { userId, ...(query.status ? { status: query.status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { _count: { select: { items: true } } },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    orders: page.map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      totalPaise: order.totalPaise,
      itemCount: order._count.items,
      requiresRx: order.requiresRx,
      rxStatus: order.rxStatus,
      createdAt: order.createdAt.toISOString(),
      deliveredAt: isoOrNull(order.deliveredAt),
    })),
    nextCursor: hasMore && last ? last.id : null,
  };
}

/**
 * GET /v1/orders/:id/track — the live-tracking payload (§3.5, §18.1) and the
 * polling fallback when the socket is down. Carries the map anchors (store +
 * destination), the assigned-driver card, the last known driver ping (in-memory
 * §11), the status timeline, and a heuristic ETA. Ownership 404 for non-owners.
 */
export async function trackOrder(userId: string, role: Role, id: string): Promise<TrackOrderResult> {
  const order = await getPrisma().order.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      addressSnapshot: true,
      events: { orderBy: { createdAt: "asc" }, select: { to: true, createdAt: true } },
      delivery: {
        select: {
          driver: {
            select: {
              vehicleType: true,
              vehicleNo: true,
              user: { select: { name: true, phone: true } },
            },
          },
        },
      },
    },
  });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);
  const isStaff = role === Role.INVENTORY || role === Role.ADMIN;
  if (order.userId !== userId && !isStaff) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }

  const store = await getStoreConfig();
  const snap = order.addressSnapshot as unknown as AddressSnapshot;
  const destination = { lat: snap.lat, lng: snap.lng };

  // Assigned-driver card — same shape as OrderDetail; null before ASSIGNED.
  const driver: OrderDriver | null = order.delivery
    ? {
        name: order.delivery.driver.user.name,
        phone: order.delivery.driver.user.phone,
        vehicleType: order.delivery.driver.vehicleType,
        vehicleNo: order.delivery.driver.vehicleNo,
      }
    : null;

  // Live position from the in-memory store (§11), fed by the driver's pings;
  // null before ASSIGNED or when no ping has arrived (and cleared on terminal).
  const driverLocation = getDriverLocation(id);

  // Status timeline, oldest→newest, collapsing consecutive duplicate statuses.
  const timeline: TrackTimelineEntry[] = [];
  for (const event of order.events) {
    const prev = timeline[timeline.length - 1];
    if (prev && prev.status === event.to) continue;
    timeline.push({ status: event.to, at: event.createdAt.toISOString() });
  }

  // Heuristic minutes-to-doorstep from the live ping at ~5 m/s (≈18 km/h); null
  // once terminal or before any ping exists.
  const isTerminal =
    order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED;
  const etaMinutes =
    driverLocation && !isTerminal
      ? Math.max(1, Math.ceil(haversineM(driverLocation, destination) / 5 / 60))
      : null;

  return {
    orderId: id,
    status: order.status,
    store: { lat: store.lat, lng: store.lng },
    destination,
    driver,
    driverLocation,
    timeline,
    etaMinutes,
  };
}

/* --------------------------------------------------------------- cancel */

/**
 * Customer cancel (§18.3): PENDING_PAYMENT/PLACED/RX_REVIEW → immediate
 * CANCELLED + restock; PACKING/READY → a cancel REQUEST ops must approve
 * (status unchanged); ASSIGNED+ / terminal → 422.
 */
export async function cancelOrder(
  userId: string,
  id: string,
  reason: string,
): Promise<CancelOrderResult> {
  const prisma = getPrisma();

  const existing = await prisma.order.findUnique({
    where: { id },
    select: { userId: true, status: true, orderNo: true },
  });
  if (!existing || existing.userId !== userId) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  const status = existing.status;

  if ((CUSTOMER_CANCELABLE_STATUSES as readonly OrderStatus[]).includes(status)) {
    await prisma.$transaction(async (tx) => {
      assertTransition(status, OrderStatus.CANCELLED, ActorType.CUSTOMER);
      const updated = await tx.order.updateMany({
        where: { id, status },
        data: { status: OrderStatus.CANCELLED, cancelReason: reason, cancelledAt: new Date() },
      });
      if (updated.count !== 1) {
        throw new AppError("CONFLICT", "Order changed concurrently — reload and retry", 409);
      }
      await restockOrder(tx, id);
      await tx.orderEvent.create({
        data: {
          orderId: id,
          from: status,
          to: OrderStatus.CANCELLED,
          actorType: ActorType.CUSTOMER,
          actorId: userId,
          note: reason,
        },
      });
    });

    emitOrderStatus({ id, status: OrderStatus.CANCELLED });
    clearDriverLocation(id);
    await notifyUser({
      userId,
      type: "ORDER_CANCELLED",
      title: "Order cancelled",
      body: `Your order ${existing.orderNo} was cancelled: ${reason}`,
      data: { orderId: id },
    });
    // Refund a paid PREPAID order (external, post-commit, §14). No-op for COD and
    // for still-unpaid PENDING_PAYMENT orders (initiateRefund guards on PAID).
    await initiateRefund(id);
    return { outcome: CancelOrderOutcome.CANCELLED, order: await loadOrder(id, userId) };
  }

  if ((CUSTOMER_CANCEL_REQUEST_STATUSES as readonly OrderStatus[]).includes(status)) {
    // Record the request as an OrderEvent (status unchanged); ops sees the
    // marker on the order detail. The from/to both carry the current status.
    await prisma.orderEvent.create({
      data: {
        orderId: id,
        from: status,
        to: status,
        actorType: ActorType.CUSTOMER,
        actorId: userId,
        note: CANCEL_REQUESTED_NOTE,
      },
    });
    emitOpsAlert(AlertKind.GENERIC, `Customer requested cancellation for order ${id}`, id);
    return { outcome: CancelOrderOutcome.CANCEL_REQUESTED, order: await loadOrder(id, userId) };
  }

  throw new AppError(
    "VALIDATION_ERROR",
    "This order can no longer be cancelled — please contact support",
    422,
    { status },
  );
}

async function loadOrder(id: string, viewerUserId: string): Promise<Order> {
  const order = await getPrisma().order.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { id: "asc" } }, patient: { select: { name: true } } },
  });
  return baseOrder(order, order.userId === viewerUserId);
}

/* -------------------------------------------------------------- restock */

/**
 * Reverse an order's stock reservation inside the caller's transaction
 * (pinned cross-agent signature — agent D's ops cancel consumes this):
 * - add each item's qty back to `Product.stockQty` + a CANCEL_RESTOCK adjustment;
 * - when the order was already allocated (READY+ cancels), restore the
 *   `Batch.qtyAvailable` decremented at packing from the ItemBatchAlloc rows.
 * Status flip + OrderEvent are the CALLER's responsibility (§18.3).
 */
export async function restockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    include: { allocations: true },
  });

  for (const item of items) {
    await tx.$executeRaw`
      UPDATE "Product" SET "stockQty" = "stockQty" + ${item.qty} WHERE "id" = ${item.productId}
    `;
    await tx.stockAdjustment.create({
      data: {
        productId: item.productId,
        delta: item.qty,
        reason: AdjustReason.CANCEL_RESTOCK,
        refOrderId: orderId,
      },
    });

    for (const alloc of item.allocations) {
      await tx.$executeRaw`
        UPDATE "Batch" SET "qtyAvailable" = "qtyAvailable" + ${alloc.qty} WHERE "id" = ${alloc.batchId}
      `;
    }
  }
}
