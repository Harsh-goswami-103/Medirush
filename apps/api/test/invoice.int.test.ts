import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Post-delivery GST invoice (BLUEPRINT §9.7, §13; phase-2 brief §7). Real
 * Postgres, R2 stub. Covers: the invoice job mints an FY-sequential number,
 * renders a real PDF and uploads it; the FY counter never reuses a number; and
 * GET /invoice presigns the PDF (409 until generated).
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.R2_ACCOUNT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { generateInvoiceForOrder } = await import("../src/modules/invoices/service");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

const STORAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", ".storage", "private");
const INVOICE_NO_RE = /^MR\/\d{2}-\d{2}\/\d{6}$/;

let seq = 0;
async function makeDeliveredOrder(userId: string) {
  seq += 1;
  const p = await product({ pricePaise: 10000, gstRatePct: 12, stock: 100 });
  return prisma.order.create({
    data: {
      orderNo: `MR-INV-${seq}`,
      userId,
      status: "DELIVERED",
      paymentMethod: "COD",
      paymentStatus: "COD_COLLECTED",
      addressSnapshot: {
        name: "Asha Rao",
        phone: "+919000000000",
        line1: "42 MG Road",
        landmark: "Near Metro",
        pincode: "560001",
        lat: 12.97,
        lng: 77.59,
      } as Prisma.InputJsonValue,
      distanceM: 1200,
      itemsPaise: 20000,
      deliveryPaise: 2000,
      discountPaise: 0,
      totalPaise: 22000,
      requiresRx: false,
      rxStatus: "NA",
      placedAt: new Date(),
      deliveredAt: new Date(),
      items: {
        create: [
          {
            productId: p.id,
            nameSnap: p.name,
            packSizeSnap: p.packSize,
            pricePaise: 10000,
            mrpPaise: 12000,
            gstRatePct: 12,
            hsnSnap: "3004",
            requiresRx: false,
            qty: 2,
          },
        ],
      },
    },
  });
}

const seqOf = (invoiceNo: string): number => Number(invoiceNo.slice(-6));

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
  await storeConfig({
    gstin: "29ABCDE1234F1Z5",
    drugLicenseNo: "KA-B-20-123456",
    pharmacistName: "Dr. Neha Sharma",
    pharmacistRegNo: "KA-PH-45678",
    fssaiNo: "12345678901234",
  });
  await appSettings();
});

describe("invoice generation job", () => {
  it("mints an FY-sequential number, renders a real PDF, and sets invoiceNo + invoiceKey", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeDeliveredOrder(customer.id);

    await generateInvoiceForOrder(order.id);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated?.invoiceNo).toMatch(INVOICE_NO_RE);
    expect(updated?.invoiceKey).toBeTruthy();

    // The rendered bytes are a real PDF (start with the %PDF magic).
    const pdf = await readFile(join(STORAGE_ROOT, updated!.invoiceKey!));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });

  it("is idempotent — a second run does not re-number the order", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeDeliveredOrder(customer.id);

    await generateInvoiceForOrder(order.id);
    const first = (await prisma.order.findUnique({ where: { id: order.id } }))?.invoiceNo;
    await generateInvoiceForOrder(order.id);
    const second = (await prisma.order.findUnique({ where: { id: order.id } }))?.invoiceNo;

    expect(second).toBe(first);
  });

  it("increments the FY counter across two invoices without reuse", async () => {
    const customer = await user("CUSTOMER");
    const a = await makeDeliveredOrder(customer.id);
    const b = await makeDeliveredOrder(customer.id);

    await generateInvoiceForOrder(a.id);
    await generateInvoiceForOrder(b.id);

    const noA = (await prisma.order.findUnique({ where: { id: a.id } }))?.invoiceNo ?? "";
    const noB = (await prisma.order.findUnique({ where: { id: b.id } }))?.invoiceNo ?? "";
    expect(noA).toMatch(INVOICE_NO_RE);
    expect(noB).toMatch(INVOICE_NO_RE);
    expect(noA).not.toBe(noB);
    expect(seqOf(noB)).toBe(seqOf(noA) + 1);
  });
});

describe("GET /v1/orders/:id/invoice", () => {
  it("409s before generation, then returns a presigned URL once available", async () => {
    const customer = await user("CUSTOMER");
    const order = await makeDeliveredOrder(customer.id);
    const headers = authHeaders(customer);

    const before = await app.inject({ method: "GET", url: `/v1/orders/${order.id}/invoice`, headers });
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe("CONFLICT");

    await generateInvoiceForOrder(order.id);

    const after = await app.inject({ method: "GET", url: `/v1/orders/${order.id}/invoice`, headers });
    expect(after.statusCode, after.body).toBe(200);
    const body = after.json().data;
    expect(body.url).toMatch(/^https?:\/\//);
    expect(body.expiresInSec).toBeGreaterThan(0);
  });

  it("404s for a non-owner", async () => {
    const owner = await user("CUSTOMER");
    const other = await user("CUSTOMER");
    const order = await makeDeliveredOrder(owner.id);
    await generateInvoiceForOrder(order.id);

    const res = await app.inject({
      method: "GET",
      url: `/v1/orders/${order.id}/invoice`,
      headers: authHeaders(other),
    });
    expect(res.statusCode).toBe(404);
  });
});
