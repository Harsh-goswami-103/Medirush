import PDFDocument from "pdfkit";

/**
 * GST invoice PDF renderer (BLUEPRINT §9.7, §9.2). Dependency-only on `pdfkit`
 * (standard Helvetica fonts, no external assets) so it renders identically in
 * the local stub and in production.
 *
 * Prices are GST-inclusive (Indian retail norm, §9.2). Each line back-computes
 * the taxable value `round(line / (1 + r/100))` and splits the balance equally
 * into CGST/SGST (intra-state — single city). Money is integer paise throughout;
 * only the final on-page string is formatted to rupees.
 *
 * The document is buffered: chunks are collected off the stream and the promise
 * resolves with the full `Buffer` on `end` (never touches disk).
 */

/** Store identity block printed in the invoice header (from StoreConfig, §6.2). */
export interface InvoicePdfStore {
  name: string;
  address: string;
  gstin: string | null;
  drugLicenseNo: string | null;
  pharmacistName: string | null;
  pharmacistRegNo: string | null;
  fssaiNo: string | null;
}

/** One invoice line — `unitPricePaise` is the GST-inclusive selling price. */
export interface InvoicePdfLine {
  name: string;
  hsn: string | null;
  qty: number;
  unitPricePaise: number;
  gstRatePct: number;
  /** Dispensed batch numbers (Rx items only); empty for non-Rx lines. */
  batchNos: string[];
}

export interface InvoicePdfData {
  store: InvoicePdfStore;
  invoiceNo: string;
  invoiceDate: Date;
  orderNo: string;
  customer: { name: string; address: string };
  lines: InvoicePdfLine[];
  itemsPaise: number;
  deliveryPaise: number;
  discountPaise: number;
  totalPaise: number;
}

/** GST back-compute for one line (§9.2) — all values in integer paise. */
export interface LineTax {
  lineTotalPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

/** `taxable = round(line / (1 + r/100))`; CGST = SGST = (line − taxable) / 2. */
export function backComputeGst(unitPricePaise: number, qty: number, gstRatePct: number): LineTax {
  const lineTotalPaise = unitPricePaise * qty;
  const taxablePaise = Math.round(lineTotalPaise / (1 + gstRatePct / 100));
  const gst = lineTotalPaise - taxablePaise;
  // Equal split; the odd paise (if any) lands on CGST so the two sum back to gst.
  const cgstPaise = Math.ceil(gst / 2);
  const sgstPaise = gst - cgstPaise;
  return { lineTotalPaise, taxablePaise, cgstPaise, sgstPaise };
}

/** Paise → "Rs. 1,234.50". Uses "Rs." (WinAnsi-safe for the standard font). */
function rupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}Rs. ${whole.toLocaleString("en-IN")}.${frac}`;
}

const dash = (v: string | null | undefined): string => (v && v.length > 0 ? v : "-");

/**
 * Render the invoice to a PDF buffer. Layout (top → bottom): store identity +
 * compliance fields, invoice meta, customer snapshot, a per-line table with
 * HSN / qty / unit / line total and the CGST/SGST back-compute, dispensed batch
 * numbers under Rx lines, and the totals block.
 */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { store } = data;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentWidth = right - left;

    // ---- Header: store identity + compliance fields ---------------------
    doc.font("Helvetica-Bold").fontSize(18).text(store.name, left, doc.y);
    doc.font("Helvetica").fontSize(9);
    doc.text(store.address, { width: contentWidth });
    doc.text(`GSTIN: ${dash(store.gstin)}`);
    doc.text(`Drug License No: ${dash(store.drugLicenseNo)}`);
    doc.text(`Pharmacist: ${dash(store.pharmacistName)} (Reg No: ${dash(store.pharmacistRegNo)})`);
    doc.text(`FSSAI No: ${dash(store.fssaiNo)}`);

    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(13).text("TAX INVOICE", { align: "center" });
    doc.moveDown(0.5);

    // ---- Invoice meta + customer ---------------------------------------
    doc.font("Helvetica").fontSize(9);
    doc.text(`Invoice No: ${data.invoiceNo}`);
    doc.text(`Invoice Date: ${data.invoiceDate.toISOString().slice(0, 10)}`);
    doc.text(`Order No: ${data.orderNo}`);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("Bill To:");
    doc.font("Helvetica").text(data.customer.name);
    doc.text(data.customer.address, { width: contentWidth });

    doc.moveDown(0.75);

    // ---- Line table -----------------------------------------------------
    // Column x-offsets from the left margin.
    const cols = {
      name: left,
      hsn: left + contentWidth * 0.42,
      qty: left + contentWidth * 0.56,
      unit: left + contentWidth * 0.66,
      taxable: left + contentWidth * 0.78,
      total: left + contentWidth * 0.9,
    };
    const rowText = (
      cells: { name: string; hsn: string; qty: string; unit: string; taxable: string; total: string },
      y: number,
    ) => {
      doc.text(cells.name, cols.name, y, { width: contentWidth * 0.4, lineBreak: false });
      doc.text(cells.hsn, cols.hsn, y, { width: contentWidth * 0.13, lineBreak: false });
      doc.text(cells.qty, cols.qty, y, { width: contentWidth * 0.09, lineBreak: false });
      doc.text(cells.unit, cols.unit, y, { width: contentWidth * 0.11, lineBreak: false });
      doc.text(cells.taxable, cols.taxable, y, { width: contentWidth * 0.11, lineBreak: false });
      doc.text(cells.total, cols.total, y, { width: contentWidth * 0.1, lineBreak: false });
    };

    doc.font("Helvetica-Bold").fontSize(8.5);
    const headerY = doc.y;
    rowText(
      { name: "Item", hsn: "HSN", qty: "Qty", unit: "Unit", taxable: "Taxable", total: "Amount" },
      headerY,
    );
    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.3);

    let totalTaxable = 0;
    let totalCgst = 0;
    let totalSgst = 0;

    doc.font("Helvetica").fontSize(8.5);
    for (const line of data.lines) {
      const tax = backComputeGst(line.unitPricePaise, line.qty, line.gstRatePct);
      totalTaxable += tax.taxablePaise;
      totalCgst += tax.cgstPaise;
      totalSgst += tax.sgstPaise;

      const y = doc.y;
      rowText(
        {
          name: line.name,
          hsn: dash(line.hsn),
          qty: String(line.qty),
          unit: rupees(line.unitPricePaise),
          taxable: rupees(tax.taxablePaise),
          total: rupees(tax.lineTotalPaise),
        },
        y,
      );
      doc.moveDown(1);

      // Per-line GST split (CGST/SGST) + Rx batch numbers, indented under the row.
      doc.fontSize(7.5).fillColor("#555555");
      doc.text(
        `GST ${line.gstRatePct}%  |  CGST ${rupees(tax.cgstPaise)}  SGST ${rupees(tax.sgstPaise)}`,
        cols.name + 8,
        doc.y,
        { width: contentWidth - 8, lineBreak: false },
      );
      doc.moveDown(0.9);
      if (line.batchNos.length > 0) {
        doc.text(`Batch(es): ${line.batchNos.join(", ")}`, cols.name + 8, doc.y, {
          width: contentWidth - 8,
          lineBreak: false,
        });
        doc.moveDown(0.9);
      }
      doc.fillColor("black").fontSize(8.5);
    }

    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.5);

    // ---- Totals ---------------------------------------------------------
    doc.font("Helvetica").fontSize(9);
    const totalsRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica");
      const y = doc.y;
      doc.text(label, cols.taxable - contentWidth * 0.1, y, {
        width: contentWidth * 0.2,
        align: "right",
        lineBreak: false,
      });
      doc.text(value, cols.total - contentWidth * 0.02, y, {
        width: contentWidth * 0.12,
        align: "right",
        lineBreak: false,
      });
      doc.moveDown(0.8);
    };
    totalsRow("Taxable value:", rupees(totalTaxable));
    totalsRow("CGST:", rupees(totalCgst));
    totalsRow("SGST:", rupees(totalSgst));
    totalsRow("Items total:", rupees(data.itemsPaise));
    totalsRow("Delivery:", rupees(data.deliveryPaise));
    if (data.discountPaise > 0) totalsRow("Discount:", `-${rupees(data.discountPaise)}`);
    totalsRow("Grand Total:", rupees(data.totalPaise), true);

    doc.moveDown(1);
    doc.font("Helvetica").fontSize(7.5).fillColor("#777777");
    doc.text(
      "This is a computer-generated GST invoice. Prices are inclusive of GST. E&OE.",
      left,
      doc.y,
      { width: contentWidth, align: "center" },
    );

    doc.end();
  });
}
