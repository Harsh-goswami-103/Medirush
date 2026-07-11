/**
 * Real-catalog loader (BLUEPRINT §24 "seed removed / real catalog loaded").
 *
 * Loads the pharmacy's REAL product master from a pharmacist-maintained CSV
 * (Excel-friendly) — categories + products with prices, GST, HSN, Rx flags, and
 * optional opening stock. Unlike `prisma/seed.ts` (demo data, destructive reset),
 * this is:
 *   - IDEMPOTENT   — upserts Category + Product by slug; opening-stock batches are
 *                    keyed by (product, batchNo, invoiceNo) and skipped if present.
 *   - NON-DESTRUCTIVE — never deletes; never touches users / orders / store config.
 *   - MONEY-SAFE   — rupees in the CSV → integer paise; enforces price ≤ MRP,
 *                    GST ∈ {0,5,12,18}, H1 ⇒ requiresRx.
 *
 * Usage (server NOT required; talks straight to the DB):
 *   pnpm --filter @medrush/api exec tsx scripts/seed-catalog.ts --file catalog.csv
 *   …--dry-run              validate + report, write nothing
 *   …--deactivate-missing   also deactivate active products whose slug is absent
 *                           from the CSV (treat the CSV as the source of truth)
 *
 * Ongoing edits should go through the Ops panel (which writes audit logs); this
 * bulk loader is for the initial launch catalog. See scripts/catalog.example.csv.
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

/* ----------------------------------------------------------- pure helpers */

/** RFC-4180-ish CSV parse → records keyed by header (+ `__row` = 1-based line). */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM (Excel)
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const header = rows[0]!.map((h) => h.trim());
  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    if (cells.every((c) => c.trim() === "")) continue; // skip blank lines
    const rec: Record<string, string> = { __row: String(r + 1) };
    header.forEach((h, idx) => {
      rec[h] = (cells[idx] ?? "").trim();
    });
    records.push(rec);
  }
  return records;
}

/** URL-safe slug (matches contracts SlugSchema): lowercase alnum, single hyphens. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Rupees string ("45", "45.5", "₹1,299.00") → integer paise. Throws if invalid. */
export function rupeesToPaise(raw: string): number {
  const s = raw.trim().replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid amount "${raw}"`);
  return Math.round(Number(s) * 100);
}

const GST_SLABS = new Set([0, 5, 12, 18]);
const SCHEDULE_CLASSES = new Set(["NONE", "OTC", "H", "H1"]);
const TRUEY = new Set(["yes", "y", "true", "1", "rx"]);
const FALSEY = new Set(["no", "n", "false", "0", ""]);

function parseBool(raw: string, field: string): boolean {
  const v = raw.trim().toLowerCase();
  if (TRUEY.has(v)) return true;
  if (FALSEY.has(v)) return false;
  throw new Error(`${field}: expected yes/no, got "${raw}"`);
}

export interface OpeningStock {
  batchNo: string;
  expiryDate: Date;
  qtyReceived: number;
  costPaise: number;
  wholesaler: string;
  invoiceNo: string;
}

export interface CatalogProduct {
  row: number;
  categoryName: string;
  categorySlug: string;
  slug: string;
  name: string;
  brand: string | null;
  description: string;
  composition: string;
  packSize: string;
  mrpPaise: number;
  pricePaise: number;
  gstRatePct: number;
  hsnCode: string | null;
  requiresRx: boolean;
  scheduleClass: string;
  isColdChain: boolean;
  maxPerOrder: number;
  binLocation: string;
  barcode: string | null;
  searchKeywords: string;
  opening: OpeningStock | null;
}

/** Validate + normalize one raw CSV record. Returns the product or a list of errors. */
export function normalizeRow(
  rec: Record<string, string>,
): { product?: CatalogProduct; errors: string[] } {
  const row = Number(rec.__row ?? 0);
  const errors: string[] = [];
  const req = (k: string): string => {
    const v = (rec[k] ?? "").trim();
    if (!v) errors.push(`${k} is required`);
    return v;
  };

  const categoryName = req("category");
  const name = req("name");
  const packSize = req("packSize");

  let mrpPaise = 0;
  let pricePaise = 0;
  try {
    mrpPaise = rupeesToPaise(req("mrp") || "0");
  } catch (e) {
    errors.push(`mrp: ${(e as Error).message}`);
  }
  try {
    pricePaise = rupeesToPaise(req("price") || "0");
  } catch (e) {
    errors.push(`price: ${(e as Error).message}`);
  }
  if (mrpPaise > 0 && pricePaise > mrpPaise) {
    errors.push(`price ₹${pricePaise / 100} exceeds MRP ₹${mrpPaise / 100} (illegal)`);
  }

  const gstRatePct = Number((rec.gstPct ?? "").trim());
  if (!GST_SLABS.has(gstRatePct)) errors.push(`gstPct must be one of 0/5/12/18, got "${rec.gstPct}"`);

  let requiresRx = false;
  try {
    requiresRx = parseBool(rec.requiresRx ?? "", "requiresRx");
  } catch (e) {
    errors.push((e as Error).message);
  }
  let isColdChain = false;
  try {
    isColdChain = parseBool(rec.coldChain ?? "", "coldChain");
  } catch (e) {
    errors.push((e as Error).message);
  }

  const scheduleClass = (rec.scheduleClass ?? "").trim().toUpperCase() || "NONE";
  if (!SCHEDULE_CLASSES.has(scheduleClass)) {
    errors.push(`scheduleClass must be NONE/OTC/H/H1, got "${rec.scheduleClass}"`);
  }
  if (scheduleClass === "H1" && !requiresRx) {
    errors.push("Schedule H1 drugs must have requiresRx = yes");
  }

  const slug = (rec.slug ?? "").trim() ? slugify(rec.slug!) : slugify(name);
  if (name && !slug) errors.push(`could not derive a slug from name "${name}" — set a slug column`);

  const maxPerOrderRaw = (rec.maxPerOrder ?? "").trim();
  let maxPerOrder = 10;
  if (maxPerOrderRaw) {
    maxPerOrder = Number(maxPerOrderRaw);
    if (!Number.isInteger(maxPerOrder) || maxPerOrder < 1) {
      errors.push(`maxPerOrder must be a positive integer, got "${maxPerOrderRaw}"`);
    }
  }

  // Optional opening stock — if any stock field is set, the full GRN group is required.
  const openingStockRaw = (rec.openingStock ?? "").trim();
  let opening: OpeningStock | null = null;
  if (openingStockRaw && openingStockRaw !== "0") {
    const qty = Number(openingStockRaw);
    if (!Number.isInteger(qty) || qty < 1) {
      errors.push(`openingStock must be a positive integer, got "${openingStockRaw}"`);
    }
    const batchNo = (rec.batchNo ?? "").trim();
    const invoiceNo = (rec.invoiceNo ?? "").trim();
    const wholesaler = (rec.wholesaler ?? "").trim();
    const expiryRaw = (rec.expiry ?? "").trim();
    if (!batchNo) errors.push("openingStock set but batchNo is missing");
    if (!invoiceNo) errors.push("openingStock set but invoiceNo is missing");
    if (!wholesaler) errors.push("openingStock set but wholesaler is missing");
    let expiryDate = new Date(0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryRaw)) {
      errors.push(`expiry must be YYYY-MM-DD, got "${rec.expiry}"`);
    } else {
      expiryDate = new Date(`${expiryRaw}T00:00:00.000Z`);
      if (Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() <= Date.now()) {
        errors.push(`expiry "${expiryRaw}" must be a valid future date`);
      }
    }
    let costPaise = 0;
    try {
      costPaise = rupeesToPaise((rec.cost ?? "").trim() || "0");
    } catch (e) {
      errors.push(`cost: ${(e as Error).message}`);
    }
    if (errors.length === 0) {
      opening = { batchNo, expiryDate, qtyReceived: qty, costPaise, wholesaler, invoiceNo };
    }
  }

  if (errors.length > 0) return { errors };

  return {
    errors: [],
    product: {
      row,
      categoryName,
      categorySlug: slugify(categoryName),
      slug,
      name,
      brand: (rec.brand ?? "").trim() || null,
      description: (rec.description ?? "").trim(),
      composition: (rec.composition ?? "").trim(),
      packSize,
      mrpPaise,
      pricePaise,
      gstRatePct,
      hsnCode: (rec.hsn ?? "").trim() || null,
      requiresRx,
      scheduleClass,
      isColdChain,
      maxPerOrder,
      binLocation: (rec.binLocation ?? "").trim(),
      barcode: (rec.barcode ?? "").trim() || null,
      searchKeywords: (rec.searchKeywords ?? "").trim(),
      opening,
    },
  };
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "deactivate-missing": { type: "boolean", default: false },
    },
  });
  if (!values.file) {
    console.error("Usage: tsx scripts/seed-catalog.ts --file <catalog.csv> [--dry-run] [--deactivate-missing]");
    process.exit(2);
  }
  const dryRun = values["dry-run"] === true;

  const csv = await readFile(values.file, "utf8");
  const records = parseCsv(csv);
  if (records.length === 0) {
    console.error("No data rows found in the CSV.");
    process.exit(2);
  }

  // 1 ── validate every row FIRST (all-or-nothing — never half-load a catalog).
  const products: CatalogProduct[] = [];
  const errors: string[] = [];
  for (const rec of records) {
    const { product, errors: rowErrors } = normalizeRow(rec);
    for (const e of rowErrors) errors.push(`row ${rec.__row}: ${e}`);
    if (product) products.push(product);
  }
  // In-file uniqueness (slug / barcode) — the DB enforces cross-existing.
  const seenSlug = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  for (const p of products) {
    const prev = seenSlug.get(p.slug);
    if (prev) errors.push(`row ${p.row}: duplicate slug "${p.slug}" (also row ${prev})`);
    seenSlug.set(p.slug, p.row);
    if (p.barcode) {
      const b = seenBarcode.get(p.barcode);
      if (b) errors.push(`row ${p.row}: duplicate barcode "${p.barcode}" (also row ${b})`);
      seenBarcode.set(p.barcode, p.row);
    }
  }

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} validation error(s) — nothing written:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✓ validated ${products.length} product(s) across ${new Set(products.map((p) => p.categorySlug)).size} category(ies).`);

  if (dryRun) {
    const withStock = products.filter((p) => p.opening).length;
    console.log(`(dry-run) would upsert ${products.length} products; ${withStock} with opening stock. No writes.`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    // 2 ── categories (upsert by slug, sortOrder by first-seen).
    const categoryIdBySlug = new Map<string, string>();
    let sortOrder = 0;
    for (const p of products) {
      if (categoryIdBySlug.has(p.categorySlug)) continue;
      sortOrder += 1;
      const cat = await prisma.category.upsert({
        where: { slug: p.categorySlug },
        create: { slug: p.categorySlug, name: p.categoryName, sortOrder },
        update: { name: p.categoryName, isActive: true },
      });
      categoryIdBySlug.set(p.categorySlug, cat.id);
    }

    // 3 ── products (upsert by slug).
    let created = 0;
    let updated = 0;
    for (const p of products) {
      const categoryId = categoryIdBySlug.get(p.categorySlug)!;
      const data = {
        name: p.name,
        brand: p.brand,
        description: p.description,
        categoryId,
        mrpPaise: p.mrpPaise,
        pricePaise: p.pricePaise,
        gstRatePct: p.gstRatePct,
        hsnCode: p.hsnCode,
        packSize: p.packSize,
        composition: p.composition,
        binLocation: p.binLocation,
        barcode: p.barcode,
        requiresRx: p.requiresRx,
        scheduleClass: p.scheduleClass as never,
        isColdChain: p.isColdChain,
        maxPerOrder: p.maxPerOrder,
        searchKeywords: p.searchKeywords,
        isActive: true,
      };
      try {
        const existing = await prisma.product.findUnique({ where: { slug: p.slug }, select: { id: true } });
        await prisma.product.upsert({
          where: { slug: p.slug },
          create: { slug: p.slug, images: [], stockQty: 0, ...data },
          update: data,
        });
        if (existing) updated += 1;
        else created += 1;
      } catch (e) {
        console.error(`✗ row ${p.row} (${p.slug}): ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // 4 ── opening stock (idempotent GRN batch + RECEIVED adjustment).
    let batchesCreated = 0;
    let batchesSkipped = 0;
    for (const p of products) {
      if (!p.opening) continue;
      const product = await prisma.product.findUniqueOrThrow({ where: { slug: p.slug }, select: { id: true } });
      const o = p.opening;
      const exists = await prisma.batch.findUnique({
        where: { productId_batchNo_invoiceNo: { productId: product.id, batchNo: o.batchNo, invoiceNo: o.invoiceNo } },
        select: { id: true },
      });
      if (exists) {
        batchesSkipped += 1;
        continue;
      }
      await prisma.$transaction(async (tx) => {
        const batch = await tx.batch.create({
          data: {
            productId: product.id,
            batchNo: o.batchNo,
            expiryDate: o.expiryDate,
            qtyReceived: o.qtyReceived,
            qtyAvailable: o.qtyReceived,
            costPaise: o.costPaise,
            wholesaler: o.wholesaler,
            invoiceNo: o.invoiceNo,
          },
        });
        await tx.stockAdjustment.create({
          data: {
            productId: product.id,
            batchId: batch.id,
            delta: o.qtyReceived,
            reason: "RECEIVED",
            note: `Catalog load — GRN ${o.invoiceNo} (${o.wholesaler})`,
          },
        });
        await tx.product.update({
          where: { id: product.id },
          data: { stockQty: { increment: o.qtyReceived } },
        });
      });
      batchesCreated += 1;
    }

    // 5 ── optional: deactivate active products absent from the CSV.
    let deactivated = 0;
    if (values["deactivate-missing"] === true) {
      const keep = new Set(products.map((p) => p.slug));
      const active = await prisma.product.findMany({ where: { isActive: true }, select: { id: true, slug: true } });
      for (const prod of active) {
        if (!keep.has(prod.slug)) {
          await prisma.product.update({ where: { id: prod.id }, data: { isActive: false } });
          deactivated += 1;
        }
      }
    }

    console.log(
      `\n✅ catalog loaded — categories ${categoryIdBySlug.size}, products created ${created} / updated ${updated}, ` +
        `opening-stock batches created ${batchesCreated} / skipped ${batchesSkipped}` +
        (deactivated > 0 ? `, deactivated ${deactivated}` : "") +
        `.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when invoked directly (so tests can import the pure helpers).
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed-catalog.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
