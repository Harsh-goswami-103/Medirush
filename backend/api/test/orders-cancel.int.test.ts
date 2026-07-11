import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { IDEMPOTENCY_KEY_HEADER } from "@medrush/contracts";

/**
 * Cancellation matrix (§18.3) + idempotency replay (§7.1). Real Postgres.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { address, appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

function postOrder(
  headers: Record<string, string>,
  addressId: string,
  key: string = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: key },
    payload: { addressId, paymentMethod: "COD" },
  });
}

/** Place a COD order over HTTP and return the fixtures + parsed order. */
async function placeCod(opts: { pricePaise?: number; stock?: number; qty?: number } = {}) {
  const customer = await user("CUSTOMER");
  const headers = authHeaders(customer);
  const addr = await address(customer.id);
  const p = await product({ stock: opts.stock ?? 10, pricePaise: opts.pricePaise ?? 12000 });
  const cart = await prisma.cart.create({ data: { userId: customer.id } });
  await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: opts.qty ?? 1 } });

  const res = await postOrder(headers, addr.id);
  expect(res.statusCode, res.body).toBe(201);
  return { customer, headers, product: p, addressId: addr.id, order: res.json().data.order };
}

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
});

describe("POST /v1/orders/:id/cancel", () => {
  it("PLACED → CANCELLED, stock restored, one restock adjustment + event", async () => {
    const { headers, product: p, order } = await placeCod({ qty: 2 });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(8);

    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/cancel`,
      headers,
      payload: { reason: "changed my mind" },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json().data;
    expect(body.outcome).toBe("CANCELLED");
    expect(body.order.status).toBe("CANCELLED");
    expect(body.order.cancelReason).toBe("changed my mind");

    // Stock restored to the pre-order level.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(10);
    const restock = await prisma.stockAdjustment.findMany({
      where: { refOrderId: order.id, reason: "CANCEL_RESTOCK" },
    });
    expect(restock).toHaveLength(1);
    expect(restock[0]?.delta).toBe(2);

    // Final transition event: PLACED → CANCELLED by the customer.
    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "asc" },
    });
    const last = events[events.length - 1];
    expect(last?.from).toBe("PLACED");
    expect(last?.to).toBe("CANCELLED");
    expect(last?.actorType).toBe("CUSTOMER");

    expect(await prisma.order.count({ where: { status: "CANCELLED" } })).toBe(1);
  });

  it("PACKING → CANCEL_REQUESTED, status unchanged, marker event recorded", async () => {
    const { headers, product: p, order } = await placeCod();
    // Simulate ops moving the order into packing.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "PACKING", packedAt: new Date() },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/cancel`,
      headers,
      payload: { reason: "please cancel this" },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json().data;
    expect(body.outcome).toBe("CANCEL_REQUESTED");
    expect(body.order.status).toBe("PACKING");

    // Status is genuinely unchanged and stock is NOT restored.
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(dbOrder.status).toBe("PACKING");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).stockQty).toBe(9);
    expect(
      await prisma.stockAdjustment.count({ where: { refOrderId: order.id, reason: "CANCEL_RESTOCK" } }),
    ).toBe(0);

    // A cancel-requested marker event exists for ops to pick up.
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events.some((e) => e.note === "cancel-requested")).toBe(true);
  });

  it("idempotent create replay → identical orderNo, single order row", async () => {
    const customer = await user("CUSTOMER");
    const headers = authHeaders(customer);
    const addr = await address(customer.id);
    const p = await product({ stock: 10, pricePaise: 12000 });
    const cart = await prisma.cart.create({ data: { userId: customer.id } });
    await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, qty: 1 } });

    const key = randomUUID();
    const first = await postOrder(headers, addr.id, key);
    expect(first.statusCode, first.body).toBe(201);
    const firstOrder = first.json().data.order;

    // Same key + same user → replay the stored response (200), no new order.
    const second = await postOrder(headers, addr.id, key);
    expect(second.statusCode, second.body).toBe(200);
    const secondOrder = second.json().data.order;

    expect(secondOrder.id).toBe(firstOrder.id);
    expect(secondOrder.orderNo).toBe(firstOrder.orderNo);
    expect(await prisma.order.count()).toBe(1);
  });
});

describe("POST /v1/ops/orders/:id/cancel", () => {
  it("cancelling a PAID prepaid order refunds the customer (§18.3)", async () => {
    const customer = await user("CUSTOMER");
    const ops = await user("INVENTORY");
    const p = await product({ stock: 10, pricePaise: 20000 });
    const order = await prisma.order.create({
      data: {
        orderNo: "MR-OPSCXL-1",
        userId: customer.id,
        status: "PACKING",
        paymentMethod: "PREPAID",
        paymentStatus: "PAID",
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
        packedAt: new Date(),
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
              requiresRx: false,
              qty: 1,
            },
          ],
        },
      },
    });
    await prisma.payment.create({
      data: { orderId: order.id, rzpOrderId: "order_opscxl", rzpPaymentId: "pay_opscxl", amountPaise: 22000 },
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/ops/orders/${order.id}/cancel`,
      headers: authHeaders(ops),
      payload: { reason: "out of stock" },
    });
    expect(res.statusCode, res.body).toBe(200);

    // CANCELLED + refund initiated (the bug: opsCancel used to skip initiateRefund).
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.status).toBe("CANCELLED");
    expect(updated?.paymentStatus).toBe("REFUND_INITIATED");
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment?.refundId).toMatch(/^rfnd_/);
  });
});
