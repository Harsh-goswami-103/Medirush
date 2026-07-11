import { describe, expect, it } from "vitest";
import { normalizeRow, parseCsv, rupeesToPaise, slugify } from "../scripts/seed-catalog";

/**
 * Pure-function coverage for the real-catalog loader (scripts/seed-catalog.ts):
 * CSV parsing, ₹→paise, slugs, and per-row validation (the DB write path is a
 * thin idempotent upsert). No DB — these are the parts most worth pinning.
 */

const goodRow = {
  __row: "2",
  category: "Medicines",
  name: "Paracetamol 650 Tablet",
  packSize: "Strip of 15",
  mrp: "30.00",
  price: "28.50",
  gstPct: "12",
  requiresRx: "no",
};

describe("parseCsv", () => {
  it("parses headers, trims cells, tags __row, and skips blank lines", () => {
    const recs = parseCsv("a,b\n1, 2 \n\n3,4\n");
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ a: "1", b: "2", __row: "2" });
    expect(recs[1]).toMatchObject({ a: "3", b: "4", __row: "4" });
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const recs = parseCsv('name,note\n"Tab, 10","he said ""hi"""\n');
    expect(recs[0]!.name).toBe("Tab, 10");
    expect(recs[0]!.note).toBe('he said "hi"');
  });

  it("strips a BOM and tolerates CRLF", () => {
    const recs = parseCsv("﻿a,b\r\n1,2\r\n");
    expect(recs[0]).toMatchObject({ a: "1", b: "2" });
  });
});

describe("rupeesToPaise", () => {
  it("converts rupee strings to integer paise", () => {
    expect(rupeesToPaise("45")).toBe(4500);
    expect(rupeesToPaise("45.5")).toBe(4550);
    expect(rupeesToPaise("28.50")).toBe(2850);
    expect(rupeesToPaise("₹1,299.00")).toBe(129900);
  });
  it("rejects malformed amounts (non-numeric or >2 decimals)", () => {
    expect(() => rupeesToPaise("abc")).toThrow();
    expect(() => rupeesToPaise("1.234")).toThrow();
  });
});

describe("slugify", () => {
  it("produces contract-valid slugs", () => {
    expect(slugify("Paracetamol 650 Tablet")).toBe("paracetamol-650-tablet");
    expect(slugify("Vitamin C 500!!")).toBe("vitamin-c-500");
    expect(slugify("  --Odd__Name--  ")).toBe("odd-name");
  });
});

describe("normalizeRow", () => {
  it("accepts a valid row and converts money to paise", () => {
    const { product, errors } = normalizeRow(goodRow);
    expect(errors).toEqual([]);
    expect(product).toBeDefined();
    expect(product!.slug).toBe("paracetamol-650-tablet");
    expect(product!.categorySlug).toBe("medicines");
    expect(product!.mrpPaise).toBe(3000);
    expect(product!.pricePaise).toBe(2850);
    expect(product!.gstRatePct).toBe(12);
    expect(product!.requiresRx).toBe(false);
  });

  it("rejects price above MRP (legal invariant)", () => {
    const { errors } = normalizeRow({ ...goodRow, price: "35.00" });
    expect(errors.some((e) => /exceeds MRP/.test(e))).toBe(true);
  });

  it("rejects an invalid GST slab", () => {
    const { errors } = normalizeRow({ ...goodRow, gstPct: "9" });
    expect(errors.some((e) => /gstPct/.test(e))).toBe(true);
  });

  it("requires Rx for Schedule H1 drugs", () => {
    const { errors } = normalizeRow({ ...goodRow, scheduleClass: "H1", requiresRx: "no" });
    expect(errors.some((e) => /H1/.test(e))).toBe(true);
  });

  it("requires the full GRN group when opening stock is set", () => {
    const { errors } = normalizeRow({ ...goodRow, openingStock: "100" }); // no batchNo/expiry/invoice
    expect(errors.some((e) => /batchNo/.test(e))).toBe(true);
    expect(errors.some((e) => /invoiceNo/.test(e))).toBe(true);
  });

  it("parses a complete opening-stock row into a GRN batch", () => {
    const { product, errors } = normalizeRow({
      ...goodRow,
      openingStock: "200",
      batchNo: "DOLO-B01",
      expiry: "2027-06-30",
      cost: "17.00",
      wholesaler: "MedSupply",
      invoiceNo: "INV-1001",
    });
    expect(errors).toEqual([]);
    expect(product!.opening).toMatchObject({
      batchNo: "DOLO-B01",
      qtyReceived: 200,
      costPaise: 1700,
      wholesaler: "MedSupply",
      invoiceNo: "INV-1001",
    });
  });
});
