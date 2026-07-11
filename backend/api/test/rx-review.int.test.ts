import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Ops Rx review (BLUEPRINT §7.2, §9.1; phase-2 brief §6). Real Postgres, stub
 * Razorpay/R2. Covers: APPROVE → rxStatus APPROVED (start-packing then succeeds);
 * REJECT of a PAID prepaid order → CANCELLED + restock + refund initiated;
 * REJECT without a note → 422 (contract-enforced).
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.R2_ACCOUNT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

let seq = 0;
interface ReviewOrderOpts {
  paymentMethod?: Prisma.OrderUncheckedCreateInput["paymentMethod"];
  paymentStatus?: Prisma.OrderUncheckedCreateInput["paymentStatus"];
  withPaidPayment?: boolean;
  stock?: number;
  qty?: number;
}

async function makeReviewOrder(opts: ReviewOrderOpts = {}) {
  seq += 1;
  const customer = await user("CUSTOMER");
  const qty = opts.qty ?? 3;
  const p = await product({ stock: opts.stock ?? 7, requiresRx: true, pricePaise: 10000 });
  const order = await prisma.order.create({
    data: {
      orderNo: `MR-REV-${seq}`,
      userId: customer.id,
      status: "RX_REVIEW",
      paymentMethod: opts.paymentMethod ?? "COD",
      paymentStatus: opts.paymentStatus ?? "COD_DUE",
      addressSnapshot: {
        name: "Test",
        phone: "+919000000000",
        line1: "1 Test Rd",
        pincode: "560001",
        lat: 12.97,
        lng: 77.59,
      } as Prisma.InputJsonValue,
      distanceM: 100,
      itemsPaise: 10000 * qty,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 10000 * qty + 2000,
      requiresRx: true,
      rxStatus: "PENDING",
      placedAt: new Date(),
      items: {
        create: [
          {
            productId: p.id,
            nameSnap: p.name,
            packSizeSnap: p.packSize,
            pricePaise: p.pricePaise,
            mrpPaise: p.mrpPaise,
            gstRatePct: p.gstRatePct,
            hsnSnap: p.hsnCode,
            requiresRx: true,
            qty,
          },
        ],
      },
    },
  });
  await prisma.prescription.create({
    data: { orderId: order.id, fileKey: `rx/${order.id}/seed.png`, mimeType: "image/png", status: "PENDING" },
  });
  if (opts.withPaidPayment) {
    await prisma.payment.create({
      data: {
        orderId: order.id,
        rzpOrderId: `order_${seq}rev`,
        rzpPaymentId: `pay_${seq}rev`,
        amountPaise: order.totalPaise,
      },
    });
  }
  return { customer, order, product: p, qty };
}

function rxReview(headers: Record<string, string>, orderId: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/ops/orders/${orderId}/rx-review`, headers, payload: body });
}

let opsHeaders: Record<string, string>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  clearAuthCaches();
  bustStoreConfigCache();
  bustFlagCache();
  await storeConfig();
  await appSettings();
  const ops = await user("INVENTORY");
  opsHeaders = authHeaders(ops);
});

describe("POST /v1/ops/orders/:id/rx-review", () => {
  it("APPROVE is idempotent — a repeat approve writes no duplicate notification/audit", async () => {
    const { order, customer } = await makeReviewOrder();

    const first = await rxReview(opsHeaders, order.id, { status: "APPROVED" });
    expect(first.statusCode, first.body).toBe(200);
    // A retry / double-click: the order is still RX_REVIEW (only rxStatus flipped),
    // so this must be a no-op, not a second notification + audit + socket emit.
    const second = await rxReview(opsHeaders, order.id, { status: "APPROVED" });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.rxStatus).toBe("APPROVED");

    expect(
      await prisma.notification.count({ where: { userId: customer.id, type: "ORDER_RX_APPROVED" } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { entityId: order.id, action: "RX_APPROVED" } }),
    ).toBe(1);
  });

  it("APPROVE sets rxStatus APPROVED and unblocks start-packing", async () => {
    const { order } = await makeReviewOrder();

    const res = await rxReview(opsHeaders, order.id, {
      status: "APPROVED",
      patientName: "Asha Rao",
      doctorName: "Dr. Mehta",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.rxStatus).toBe("APPROVED");
    expect(res.json().data.status).toBe("RX_REVIEW");

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.rxStatus).toBe("APPROVED");
    expect(updated?.status).toBe("RX_REVIEW");

    const rx = await prisma.prescription.findFirst({ where: { orderId: order.id } });
    expect(rx?.status).toBe("APPROVED");
    expect(rx?.patientName).toBe("Asha Rao");
    expect(rx?.doctorName).toBe("Dr. Mehta");

    // The H1 register capture is audited.
    const audit = await prisma.auditLog.findFirst({ where: { entityId: order.id, action: "RX_APPROVED" } });
    expect(audit).toBeTruthy();

    // start-packing now succeeds (P1 gate requires rxStatus APPROVED).
    const pack = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/start-packing`,
      headers: opsHeaders,
    });
    expect(pack.statusCode, pack.body).toBe(200);
    expect(pack.json().data.status).toBe("PACKING");
  });

  it("REJECT of a PAID prepaid order cancels it, restocks, and initiates a refund", async () => {
    const { order, product: p, qty } = await makeReviewOrder({
      paymentMethod: "PREPAID",
      paymentStatus: "PAID",
      withPaidPayment: true,
      stock: 7,
      qty: 3,
    });

    const res = await rxReview(opsHeaders, order.id, {
      status: "REJECTED",
      note: "Prescription is illegible — please re-upload",
    });
    expect(res.statusCode, res.body).toBe(200);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.rxStatus).toBe("REJECTED");
    // Refund kicked off (webhook later flips REFUNDED).
    expect(updated?.paymentStatus).toBe("REFUND_INITIATED");

    // Stock restored for the cancelled order.
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh?.stockQty).toBe(7 + qty);

    // Prescription marked REJECTED with the note; refund id recorded on Payment.
    const rx = await prisma.prescription.findFirst({ where: { orderId: order.id } });
    expect(rx?.status).toBe("REJECTED");
    expect(rx?.reviewNote).toContain("illegible");

    const payment = await prisma.payment.findUnique({ where: { orderId: order.id } });
    expect(payment?.refundId).toMatch(/^rfnd_/);
  });

  it("REJECT of a COD order cancels it with no refund", async () => {
    const { order, product: p, qty } = await makeReviewOrder({ stock: 4, qty: 2 });

    const res = await rxReview(opsHeaders, order.id, { status: "REJECTED", note: "Not a valid Rx" });
    expect(res.statusCode).toBe(200);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.paymentStatus).toBe("COD_DUE"); // untouched — nothing to refund
    expect((await prisma.product.findUnique({ where: { id: p.id } }))?.stockQty).toBe(4 + qty);
  });

  it("REJECT without a note is rejected by the contract (schema validation → 400)", async () => {
    const { order } = await makeReviewOrder();

    // RxReviewBodySchema.superRefine requires `note` on REJECTED; the schema
    // validator rejects the body before the handler runs (§7.1 → 400).
    const res = await rxReview(opsHeaders, order.id, { status: "REJECTED" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // No state change.
    expect((await prisma.order.findUnique({ where: { id: order.id } }))?.status).toBe("RX_REVIEW");
  });
});
