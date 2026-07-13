import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { AlertKind, OrderStatus, PaymentStatus } from "@medrush/contracts";

/**
 * Stale-refund sweep (stuck-order watchdog). If a process dies after claiming
 * PAID → REFUND_INITIATED but BEFORE the Razorpay call, the order sits
 * REFUND_INITIATED with Payment.refundId null forever — every initiateRefund
 * call site is a one-shot transition, so nothing re-invokes it. A claim KEPT
 * after a Razorpay TIMEOUT (ambiguous — no revert, refundId null) leaves the
 * same shape and is swept the same way when no refund.processed ever arrives.
 * The watchdog re-drives the SAME claim-first `initiateRefund` once the claim
 * is 5 min stale. Real Postgres; Razorpay in STUB mode with
 * `createRazorpayRefund` spy-wrapped (same pattern as payments-refund-races)
 * so tests can count external refund attempts and inject failures.
 */

// Env before app import → config parses eagerly. No keys ⇒ deterministic stubs.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;
delete process.env.R2_ACCOUNT_ID;

// Spy-wrap the refund call (stub behaviour preserved: resolves { id: "rfnd_…" })
// so tests can assert exactly-one external call and mock one-shot failures.
vi.mock("../src/core/razorpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/razorpay")>();
  return { ...actual, createRazorpayRefund: vi.fn(actual.createRazorpayRefund) };
});

const { createRazorpayRefund, RazorpayTimeoutError } = await import("../src/core/razorpay");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { flushOpsAlertWrites } = await import("../src/core/realtime");
const { runStuckOrderScan } = await import("../src/jobs/stuckOrders");
const { initiateRefund } = await import("../src/modules/payments/service");
const { setupTestDb } = await import("./helpers/db");
const { user } = await import("./helpers/factories");

const prisma = getPrisma();
const refundSpy = vi.mocked(createRazorpayRefund);

const minsAgo = (mins: number): Date => new Date(Date.now() - mins * 60_000);

/** Seed a CANCELLED PREPAID order still PAID, with a captured payment on file. */
async function paidRefundableOrder() {
  const customer = await user("CUSTOMER");
  const n = randomUUID().slice(0, 8);
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-SWEEP-${n}`,
      userId: customer.id,
      status: OrderStatus.CANCELLED,
      paymentMethod: "PREPAID",
      paymentStatus: PaymentStatus.PAID,
      cancelReason: "out of stock",
      cancelledAt: new Date(),
      addressSnapshot: {
        name: "Cust",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: 12.97,
        lng: 77.59,
      } as Prisma.InputJsonValue,
      distanceM: 100,
      itemsPaise: 20000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 22000,
      requiresRx: false,
      rxStatus: "NA",
      placedAt: new Date(),
    },
  });
  const rzpPaymentId = `pay_sweep_${n}`;
  await prisma.payment.create({
    data: {
      orderId: order.id,
      rzpOrderId: `order_sweep_${n}`,
      rzpPaymentId,
      amountPaise: 22000,
    },
  });
  return { order, rzpPaymentId };
}

/**
 * Seed a CANCELLED PREPAID order whose refund claim was taken (REFUND_INITIATED,
 * refundId null) `claimedMinsAgo` minutes ago — exactly the state a process
 * that died between the claim and the Razorpay call leaves behind.
 */
async function crashedRefundClaim(claimedMinsAgo: number) {
  const seeded = await paidRefundableOrder();
  // The crash: claim taken (PAID → REFUND_INITIATED), refundId never written.
  await prisma.order.update({
    where: { id: seeded.order.id },
    data: { paymentStatus: PaymentStatus.REFUND_INITIATED, updatedAt: minsAgo(claimedMinsAgo) },
  });
  return seeded;
}

const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const paymentRow = (orderId: string) => prisma.payment.findUniqueOrThrow({ where: { orderId } });

afterAll(async () => {
  await disconnectPrisma();
});
beforeEach(async () => {
  await setupTestDb();
  refundSpy.mockClear();
});

describe("stuck-order watchdog — stale REFUND_INITIATED sweep", () => {
  it("re-drives a stale crashed claim (one Razorpay call, refundId recorded); leaves a fresh claim alone", async () => {
    const stale = await crashedRefundClaim(6); // > 5 min sweep threshold
    const fresh = await crashedRefundClaim(0); // a live initiator claimed moments ago

    const count = await runStuckOrderScan();
    expect(count).toBe(1);

    // Exactly one external refund call, for the stale claim's captured payment.
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy).toHaveBeenCalledWith(stale.rzpPaymentId, 22000);

    // The claim is now completable: refundId on file, refund.processed → REFUNDED.
    expect((await orderRow(stale.order.id)).paymentStatus).toBe(PaymentStatus.REFUND_INITIATED);
    expect((await paymentRow(stale.order.id)).refundId).toMatch(/^rfnd_/);

    // The fresh claim belongs to a live initiator — untouched.
    expect((await orderRow(fresh.order.id)).paymentStatus).toBe(PaymentStatus.REFUND_INITIATED);
    expect((await paymentRow(fresh.order.id)).refundId).toBeNull();

    // Idempotent: with the refundId recorded, a second pass finds nothing.
    expect(await runStuckOrderScan()).toBe(0);
    expect(refundSpy).toHaveBeenCalledTimes(1);
  });

  it("a DEFINITIVE Razorpay failure reverts that order to PAID + pages ops, and does not stop the sweep", async () => {
    const a = await crashedRefundClaim(10);
    const b = await crashedRefundClaim(10);
    refundSpy.mockRejectedValueOnce(new Error("razorpay 502"));

    // Both stale claims are acted on; the one Razorpay failure is contained.
    await expect(runStuckOrderScan()).resolves.toBe(2);
    expect(refundSpy).toHaveBeenCalledTimes(2);

    // Scan order is unspecified — exactly one order hit the failure (reverted
    // to PAID, nothing recorded) and the other completed its claim.
    const rows = await Promise.all(
      [a, b].map(async ({ order }) => ({
        order: await orderRow(order.id),
        payment: await paymentRow(order.id),
      })),
    );
    const reverted = rows.filter((r) => r.order.paymentStatus === PaymentStatus.PAID);
    const swept = rows.filter((r) => r.order.paymentStatus === PaymentStatus.REFUND_INITIATED);
    expect(reverted).toHaveLength(1);
    expect(swept).toHaveLength(1);
    expect(reverted[0]?.payment.refundId).toBeNull();
    expect(swept[0]?.payment.refundId).toMatch(/^rfnd_/);

    // The failure paged ops durably (initiateRefund's own failure path).
    await flushOpsAlertWrites();
    const alerts = await prisma.opsAlert.findMany({
      where: { kind: AlertKind.MANUAL_REFUND_REQUIRED },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.refId).toBe(reverted[0]?.order.id);
    expect(alerts[0]?.meta).toMatchObject({ amountPaise: 22000 });
  });

  it("re-drives a claim KEPT after a Razorpay TIMEOUT once it goes stale", async () => {
    const { order, rzpPaymentId } = await paidRefundableOrder();
    refundSpy.mockRejectedValueOnce(new RazorpayTimeoutError("refund"));

    // A timeout is ambiguous — initiateRefund KEEPS the REFUND_INITIATED claim
    // (no revert to PAID) so an eventual refund.processed can complete it.
    await expect(initiateRefund(order.id)).rejects.toBeInstanceOf(RazorpayTimeoutError);
    expect((await orderRow(order.id)).paymentStatus).toBe(PaymentStatus.REFUND_INITIATED);
    expect((await paymentRow(order.id)).refundId).toBeNull();
    await flushOpsAlertWrites();
    const alert = await prisma.opsAlert.findFirstOrThrow({
      where: { kind: AlertKind.MANUAL_REFUND_REQUIRED, refId: order.id },
    });
    expect(alert.meta).toMatchObject({ reason: "timeout-ambiguous" });

    // Freshly touched → the sweep leaves it alone (the webhook may still land).
    expect(await runStuckOrderScan()).toBe(0);
    expect(refundSpy).toHaveBeenCalledTimes(1);

    // No refund.processed ever arrived (the abandoned call really died). Once
    // the kept claim is stale the sweep re-drives the SAME claim-first
    // initiateRefund, whose stale-claim arm reclaims it — this retry IS the
    // recovery path for timed-out refunds.
    await prisma.order.update({ where: { id: order.id }, data: { updatedAt: minsAgo(6) } });
    expect(await runStuckOrderScan()).toBe(1);
    expect(refundSpy).toHaveBeenCalledTimes(2);
    expect(refundSpy).toHaveBeenLastCalledWith(rzpPaymentId, 22000);

    // Completable again: refundId on file, refund.processed → REFUNDED.
    expect((await orderRow(order.id)).paymentStatus).toBe(PaymentStatus.REFUND_INITIATED);
    expect((await paymentRow(order.id)).refundId).toMatch(/^rfnd_/);

    // Idempotent: nothing left to sweep.
    expect(await runStuckOrderScan()).toBe(0);
    expect(refundSpy).toHaveBeenCalledTimes(2);
  });
});
