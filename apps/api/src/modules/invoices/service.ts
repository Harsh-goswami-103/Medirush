import type { Prisma } from "@prisma/client";
import { OrderStatus, type AddressSnapshot, type OrderInvoice } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { logger } from "../../core/logger";
import { renderInvoicePdf, type InvoicePdfData } from "../../core/pdf";
import { presignPrivateGet, putPrivateObject } from "../../core/storage";
import { getStoreConfig } from "../../core/storeInfo";

/**
 * Invoice service (BLUEPRINT §9.7, §13). Post-DELIVERED an order gets an
 * FY-sequential GST invoice number from the `InvoiceCounter` row, a pdfkit PDF
 * (store identity + GSTIN/Drug License/Pharmacist + per-line HSN + CGST/SGST
 * back-compute + Rx batch numbers), and an upload to the private R2 bucket.
 *
 * Money-safety & isolation rules carried from the phase briefs:
 * - the FY number is minted inside a transaction under a row lock (never reused);
 * - the external R2 upload happens OUTSIDE any DB transaction (§14);
 * - generation is idempotent — a second run for an already-invoiced order no-ops.
 */

/** Presigned invoice-GET TTL (§13: private bucket, short-lived URLs). */
export const INVOICE_URL_TTL_SEC = 600;

/**
 * Indian financial year label for `now`, computed in IST: FY starts April 1, so
 * Apr 2025–Mar 2026 → "25-26".
 */
export function financialYear(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? "0");
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "0"); // 1–12
  const startYear = month >= 4 ? year : year - 1;
  const two = (y: number): string => String(y % 100).padStart(2, "0");
  return `${two(startYear)}-${two(startYear + 1)}`;
}

/**
 * Mint the next invoice number for the current FY inside the caller's tx.
 * `INSERT … ON CONFLICT DO NOTHING` seeds the counter atomically (first invoice
 * of a new FY), then `UPDATE … RETURNING` takes+increments `next` under the row
 * lock so concurrent minters serialise and never reuse a number. Format:
 * `MR/{fy}/{next padded 6}` (e.g. `MR/25-26/000123`).
 */
export async function nextInvoiceNo(
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<string> {
  const fy = financialYear(now);
  await tx.$executeRaw`
    INSERT INTO "InvoiceCounter" ("fy", "next") VALUES (${fy}, 1)
    ON CONFLICT ("fy") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ seq: number }>>`
    UPDATE "InvoiceCounter" SET "next" = "next" + 1 WHERE "fy" = ${fy}
    RETURNING "next" - 1 AS "seq"
  `;
  const seq = Number(rows[0]?.seq ?? 1);
  return `MR/${fy}/${String(seq).padStart(6, "0")}`;
}

/* -------------------------------------------------------------- generation */

const invoiceInclude = {
  items: { include: { allocations: true }, orderBy: { id: "asc" } },
} satisfies Prisma.OrderInclude;

type InvoiceOrder = Prisma.OrderGetPayload<{ include: typeof invoiceInclude }>;

function buildInvoiceData(
  order: InvoiceOrder,
  store: Awaited<ReturnType<typeof getStoreConfig>>,
  invoiceNo: string,
  invoiceDate: Date,
): InvoicePdfData {
  const snap = order.addressSnapshot as unknown as AddressSnapshot;
  const customerAddress = [snap.line1, snap.line2, snap.landmark, snap.pincode]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");

  return {
    store: {
      name: store.name,
      address: store.address,
      gstin: store.gstin,
      drugLicenseNo: store.drugLicenseNo,
      pharmacistName: store.pharmacistName,
      pharmacistRegNo: store.pharmacistRegNo,
      fssaiNo: store.fssaiNo,
    },
    invoiceNo,
    invoiceDate,
    orderNo: order.orderNo,
    customer: { name: snap.name, address: customerAddress },
    lines: order.items.map((item) => ({
      name: item.nameSnap,
      hsn: item.hsnSnap,
      qty: item.qty,
      unitPricePaise: item.pricePaise,
      gstRatePct: item.gstRatePct,
      // Batch traceability is printed for Rx items (§9.7); allocations exist post-READY.
      batchNos: item.requiresRx ? item.allocations.map((a) => a.batchNoSnap) : [],
    })),
    itemsPaise: order.itemsPaise,
    deliveryPaise: order.deliveryPaise,
    discountPaise: order.discountPaise,
    totalPaise: order.totalPaise,
  };
}

/**
 * Generate (or complete) the invoice for a DELIVERED order. Called by the
 * invoice-pdf job after the deliver commit.
 *
 * 1. Load the order + items + allocations + StoreConfig.
 * 2. In a tx, lock the order row, and if `invoiceNo` is unset, mint one from the
 *    FY counter and persist it (so concurrent runs / retries never double-number).
 * 3. OUTSIDE the tx, render the PDF and `putPrivateObject inv/{fy}/{invoiceNo}.pdf`,
 *    then set `Order.invoiceKey`.
 *
 * Idempotent: a fully-invoiced order (both `invoiceNo` and `invoiceKey` set) is a
 * no-op; a partial state (number set, upload failed) is completed on retry.
 */
export async function generateInvoiceForOrder(orderId: string): Promise<void> {
  const prisma = getPrisma();

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: invoiceInclude });
  if (!order) throw new AppError("NOT_FOUND", "Order not found", 404);

  if (order.status !== OrderStatus.DELIVERED) {
    // Defensive: the job is only enqueued from the deliver path. Skip quietly.
    logger.warn(
      { orderId, status: order.status },
      "invoice generation skipped — order is not DELIVERED",
    );
    return;
  }

  // Fully done already → nothing to do (§9.7 idempotency).
  if (order.invoiceNo && order.invoiceKey) return;

  const now = new Date();

  // Assign the FY number atomically under the order row lock. Concurrent runs
  // for the same order block here, then observe the committed number.
  const invoiceNo = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ invoiceNo: string | null }>>`
      SELECT "invoiceNo" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
    `;
    const existing = locked[0]?.invoiceNo ?? null;
    if (existing) return existing;

    const minted = await nextInvoiceNo(tx, now);
    await tx.order.update({ where: { id: orderId }, data: { invoiceNo: minted } });
    return minted;
  });

  // Key fy comes from the number itself (`MR/{fy}/{seq}`) so it always matches,
  // even if a retry crosses an FY boundary. Slashes are flattened for a clean key.
  const fy = invoiceNo.split("/")[1] ?? financialYear(now);
  const key = `inv/${fy}/${invoiceNo.replace(/\//g, "-")}.pdf`;

  const store = await getStoreConfig();
  const pdf = await renderInvoicePdf(buildInvoiceData(order, store, invoiceNo, now));

  // External call OUTSIDE any DB transaction (§14).
  await putPrivateObject(key, pdf, "application/pdf");
  await prisma.order.update({ where: { id: orderId }, data: { invoiceKey: key } });

  logger.info({ orderId, invoiceNo, key }, "invoice generated");
}

/* --------------------------------------------------------------- customer */

/**
 * GET /v1/orders/:id/invoice → a short-lived presigned URL for the owner's
 * invoice PDF. Ownership-checked (§8.3); 404 when not the owner or not yet
 * DELIVERED; 409 while the invoice PDF is still being generated.
 */
export async function getInvoiceUrl(orderId: string, userId: string): Promise<OrderInvoice> {
  const order = await getPrisma().order.findUnique({
    where: { id: orderId },
    select: { userId: true, status: true, invoiceKey: true },
  });
  if (!order || order.userId !== userId) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  if (order.status !== OrderStatus.DELIVERED) {
    throw new AppError("NOT_FOUND", "No invoice is available for this order yet", 404);
  }
  if (!order.invoiceKey) {
    throw new AppError("CONFLICT", "Invoice is still being generated — try again shortly", 409);
  }

  const url = await presignPrivateGet(order.invoiceKey, INVOICE_URL_TTL_SEC);
  return { url, expiresInSec: INVOICE_URL_TTL_SEC };
}
