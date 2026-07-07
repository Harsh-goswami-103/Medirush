import {
  OrderStatus,
  PaymentMethod,
  RxStatus,
  type GstRate,
  type GstReport,
  type GstReportRow,
  type H1Register,
  type H1RegisterRow,
  type ReportQuery,
  type SalesReport,
  type SalesReportRow,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { backComputeGst } from "../../core/pdf";
import { istDateString, istRangeToUtc } from "./dashboardService";

/**
 * Statutory + management reports (BLUEPRINT §9.2, §9.7, §19). All three roll up
 * DELIVERED orders over an inclusive IST calendar range; each also serialises to
 * a `text/csv` export. GST is back-computed per line with core/pdf.ts so the
 * report and the printed invoice agree to the paise. Read-only — no mutations.
 */

/* ----------------------------------------------------------------- CSV */

/** RFC-4180 cell: quote when it contains a comma, quote or newline; double `"`. */
export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header + rows → a CRLF-delimited CSV document (trailing newline included). */
export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
): string {
  const lines = [header.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/* --------------------------------------------------------- sales report */

interface SalesAccum {
  orders: number;
  itemsPaise: number;
  deliveryPaise: number;
  discountPaise: number;
  totalPaise: number;
  codPaise: number;
  prepaidPaise: number;
}

function emptySalesAccum(): SalesAccum {
  return {
    orders: 0,
    itemsPaise: 0,
    deliveryPaise: 0,
    discountPaise: 0,
    totalPaise: 0,
    codPaise: 0,
    prepaidPaise: 0,
  };
}

function addSale(
  accum: SalesAccum,
  order: {
    paymentMethod: PaymentMethod;
    itemsPaise: number;
    deliveryPaise: number;
    discountPaise: number;
    totalPaise: number;
  },
): void {
  accum.orders += 1;
  accum.itemsPaise += order.itemsPaise;
  accum.deliveryPaise += order.deliveryPaise;
  accum.discountPaise += order.discountPaise;
  accum.totalPaise += order.totalPaise;
  if (order.paymentMethod === PaymentMethod.COD) accum.codPaise += order.totalPaise;
  else accum.prepaidPaise += order.totalPaise;
}

/**
 * Per-IST-day rollup of DELIVERED orders (grouped by delivery date), plus grand
 * totals. Days with no deliveries produce no row; rows are date-ascending.
 */
export async function salesReport(query: ReportQuery): Promise<SalesReport> {
  const { gte, lt } = istRangeToUtc(query.from, query.to);
  const orders = await getPrisma().order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte, lt } },
    select: {
      deliveredAt: true,
      paymentMethod: true,
      itemsPaise: true,
      deliveryPaise: true,
      discountPaise: true,
      totalPaise: true,
    },
    orderBy: { deliveredAt: "asc" },
  });

  const byDay = new Map<string, SalesAccum>();
  const totals = emptySalesAccum();
  for (const order of orders) {
    // deliveredAt is guaranteed non-null by the range filter above.
    const day = istDateString(order.deliveredAt as Date);
    const accum = byDay.get(day) ?? emptySalesAccum();
    addSale(accum, order);
    addSale(totals, order);
    byDay.set(day, accum);
  }

  const rows: SalesReportRow[] = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, accum]) => ({ date, ...accum }));

  return { rows, totals };
}

export async function salesReportCsv(query: ReportQuery): Promise<string> {
  const report = await salesReport(query);
  const header = [
    "date",
    "orders",
    "itemsPaise",
    "deliveryPaise",
    "discountPaise",
    "totalPaise",
    "codPaise",
    "prepaidPaise",
  ];
  const rows: Array<Array<string | number | null>> = report.rows.map((row) => [
    row.date,
    row.orders,
    row.itemsPaise,
    row.deliveryPaise,
    row.discountPaise,
    row.totalPaise,
    row.codPaise,
    row.prepaidPaise,
  ]);
  const t = report.totals;
  rows.push([
    "TOTAL",
    t.orders,
    t.itemsPaise,
    t.deliveryPaise,
    t.discountPaise,
    t.totalPaise,
    t.codPaise,
    t.prepaidPaise,
  ]);
  return toCsv(header, rows);
}

/* ----------------------------------------------------------- GST report */

/**
 * GST summary grouped by (hsnCode, gstRatePct) over DELIVERED order items. Each
 * line is back-computed (`round(line / (1 + r/100))`, CGST=SGST split) via
 * core/pdf.ts; group + grand totals sum the per-line paise so the register ties
 * out to the invoices exactly.
 */
export async function gstReport(query: ReportQuery): Promise<GstReport> {
  const { gte, lt } = istRangeToUtc(query.from, query.to);
  const orders = await getPrisma().order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte, lt } },
    select: {
      items: { select: { hsnSnap: true, gstRatePct: true, pricePaise: true, qty: true } },
    },
  });

  const groups = new Map<string, GstReportRow>();
  const totals = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0 };
  for (const order of orders) {
    for (const item of order.items) {
      const tax = backComputeGst(item.pricePaise, item.qty, item.gstRatePct);
      const key = `${item.gstRatePct}|${item.hsnSnap ?? ""}`;
      const row =
        groups.get(key) ??
        ({
          hsnCode: item.hsnSnap,
          gstRatePct: item.gstRatePct as GstRate,
          taxablePaise: 0,
          cgstPaise: 0,
          sgstPaise: 0,
          totalPaise: 0,
        } satisfies GstReportRow);
      row.taxablePaise += tax.taxablePaise;
      row.cgstPaise += tax.cgstPaise;
      row.sgstPaise += tax.sgstPaise;
      row.totalPaise += tax.lineTotalPaise;
      groups.set(key, row);

      totals.taxablePaise += tax.taxablePaise;
      totals.cgstPaise += tax.cgstPaise;
      totals.sgstPaise += tax.sgstPaise;
      totals.totalPaise += tax.lineTotalPaise;
    }
  }

  const rows = [...groups.values()].sort(
    (a, b) => a.gstRatePct - b.gstRatePct || (a.hsnCode ?? "").localeCompare(b.hsnCode ?? ""),
  );
  return { rows, totals };
}

export async function gstReportCsv(query: ReportQuery): Promise<string> {
  const report = await gstReport(query);
  const header = ["hsnCode", "gstRatePct", "taxablePaise", "cgstPaise", "sgstPaise", "totalPaise"];
  const rows: Array<Array<string | number | null>> = report.rows.map((row) => [
    row.hsnCode,
    row.gstRatePct,
    row.taxablePaise,
    row.cgstPaise,
    row.sgstPaise,
    row.totalPaise,
  ]);
  const t = report.totals;
  rows.push(["TOTAL", "", t.taxablePaise, t.cgstPaise, t.sgstPaise, t.totalPaise]);
  return toCsv(header, rows);
}

/* ---------------------------------------------------- Schedule H1 register */

/**
 * Schedule H1 register (§9.7, 3-year statutory retention): every Rx line of a
 * DELIVERED order joined to its dispensed batch allocation, with the patient +
 * doctor captured on the order's APPROVED prescription. One row per (Rx item,
 * batch allocation).
 */
export async function h1Register(query: ReportQuery): Promise<H1Register> {
  const { gte, lt } = istRangeToUtc(query.from, query.to);
  const orders = await getPrisma().order.findMany({
    where: { status: OrderStatus.DELIVERED, deliveredAt: { gte, lt } },
    orderBy: { deliveredAt: "asc" },
    select: {
      orderNo: true,
      invoiceNo: true,
      deliveredAt: true,
      items: {
        where: { requiresRx: true },
        select: { nameSnap: true, allocations: { select: { batchNoSnap: true, qty: true } } },
      },
      prescriptions: {
        where: { status: RxStatus.APPROVED },
        orderBy: { reviewedAt: "desc" },
        select: { patientName: true, doctorName: true },
      },
    },
  });

  const rows: H1RegisterRow[] = [];
  for (const order of orders) {
    if (order.items.length === 0) continue;
    const approved = order.prescriptions[0];
    const patientName = approved?.patientName ?? null;
    const doctorName = approved?.doctorName ?? null;
    const date = istDateString(order.deliveredAt as Date);
    for (const item of order.items) {
      for (const alloc of item.allocations) {
        rows.push({
          date,
          orderNo: order.orderNo,
          invoiceNo: order.invoiceNo,
          productName: item.nameSnap,
          batchNo: alloc.batchNoSnap,
          qty: alloc.qty,
          patientName,
          doctorName,
        });
      }
    }
  }

  return { rows };
}

export async function h1RegisterCsv(query: ReportQuery): Promise<string> {
  const report = await h1Register(query);
  const header = [
    "date",
    "orderNo",
    "invoiceNo",
    "productName",
    "batchNo",
    "qty",
    "patientName",
    "doctorName",
  ];
  const rows: Array<Array<string | number | null>> = report.rows.map((row) => [
    row.date,
    row.orderNo,
    row.invoiceNo,
    row.productName,
    row.batchNo,
    row.qty,
    row.patientName,
    row.doctorName,
  ]);
  return toCsv(header, rows);
}
