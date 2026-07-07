import { Prisma } from "@prisma/client";
import type { Batch as DbBatch, Category as DbCategory, Product as DbProduct } from "@prisma/client";
import {
  AdjustReason,
  type Batch,
  type CreateBatchBody,
  type CreateBatchResult,
  type CreateCategoryBody,
  type CreateProductBody,
  type GstRate,
  type LowStockItem,
  type NearExpiryItem,
  type NearExpiryQuery,
  type OpsCategory,
  type OpsProduct,
  type OpsProductListQuery,
  type Role,
  type ScheduleClass,
  type StockAdjustBody,
  type StockAdjustResult,
  type UpdateCategoryBody,
  type UpdateProductBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { toImageUrl } from "../catalog/search";

/**
 * Ops inventory management (BLUEPRINT §7.2 ops rows; RBAC §8.3: INVENTORY or
 * ADMIN). Products/categories CRUD, GRN batches, stock adjustments and the
 * low-stock / near-expiry alert reads. The existing `service.ts`/`fefo.ts`
 * (packing-side allocation + FEFO) are untouched — this file only adds the
 * ops-catalog surface.
 *
 * Rules carried from the brief: money is integer paise; every mutation is one
 * `$transaction`; stock can never go negative (conditional UPDATE guard → 409);
 * an `AuditLog` row is written for every mutation (price/stock changes are
 * inspection-sensitive, §9.2); price ≤ MRP is re-checked server-side.
 */

export interface OpsActor {
  userId: string;
  role: Role;
}

/* ----------------------------------------------------------------- slugs */

/**
 * Catalog slug from arbitrary text: lowercase, collapse every run of
 * non-`[a-z0-9]` to a single hyphen, trim leading/trailing hyphens. The result
 * always satisfies `SlugSchema` (no empty segments, no edge hyphens).
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Free product slug — appends `-2`, `-3`, … on collision (self excluded on update). */
async function uniqueProductSlug(base: string, excludeId?: string): Promise<string> {
  const prisma = getPrisma();
  let candidate = base;
  let n = 1;
  for (;;) {
    const hit = await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!hit || hit.id === excludeId) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

/** Free category slug — same collision policy as products. */
async function uniqueCategorySlug(base: string, excludeId?: string): Promise<string> {
  const prisma = getPrisma();
  let candidate = base;
  let n = 1;
  for (;;) {
    const hit = await prisma.category.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!hit || hit.id === excludeId) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

/* ------------------------------------------------------------ IST dates */

const DAY_MS = 86_400_000;

/** Today's calendar date in IST as `YYYY-MM-DD` (en-CA yields the ISO order). */
function istTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Epoch ms at UTC midnight for a `YYYY-MM-DD` — the anchor for whole-day math. */
function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`);
}

/** A `@db.Date` value (UTC midnight) → its `YYYY-MM-DD`. */
function dateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- mappers */

/** Prisma Product row → the full ops/admin product view (images as CDN URLs). */
function toOpsProduct(p: DbProduct): OpsProduct {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    brand: p.brand,
    description: p.description,
    categoryId: p.categoryId,
    images: p.images.map(toImageUrl),
    mrpPaise: p.mrpPaise,
    pricePaise: p.pricePaise,
    gstRatePct: p.gstRatePct as GstRate,
    hsnCode: p.hsnCode,
    packSize: p.packSize,
    composition: p.composition,
    binLocation: p.binLocation,
    barcode: p.barcode,
    requiresRx: p.requiresRx,
    scheduleClass: p.scheduleClass as ScheduleClass,
    isColdChain: p.isColdChain,
    stockQty: p.stockQty,
    lowStockThreshold: p.lowStockThreshold,
    maxPerOrder: p.maxPerOrder,
    searchKeywords: p.searchKeywords,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toOpsCategory(c: DbCategory): OpsCategory {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    imageUrl: c.imageUrl === null ? null : toImageUrl(c.imageUrl),
    sortOrder: c.sortOrder,
    isActive: c.isActive,
  };
}

function toBatch(b: DbBatch): Batch {
  return {
    id: b.id,
    productId: b.productId,
    batchNo: b.batchNo,
    expiryDate: dateToYmd(b.expiryDate),
    qtyReceived: b.qtyReceived,
    qtyAvailable: b.qtyAvailable,
    costPaise: b.costPaise,
    wholesaler: b.wholesaler,
    invoiceNo: b.invoiceNo,
    receivedAt: b.receivedAt.toISOString(),
  };
}

/**
 * Re-raise a Prisma unique-constraint clash (duplicate slug/barcode/GRN) as a
 * 409, leaving `AppError`s untouched and anything else to the global handler.
 */
function rethrowKnown(e: unknown): never {
  if (e instanceof AppError) throw e;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new AppError("CONFLICT", "A record with these unique fields already exists", 409, {
      fields: e.meta?.target,
    });
  }
  throw e;
}

/* ---------------------------------------------------------- products CRUD */

export async function listProducts(
  query: OpsProductListQuery,
): Promise<{ products: OpsProduct[]; nextCursor: string | null }> {
  const prisma = getPrisma();

  // Category is filtered by slug (§7.2) — an unknown slug is empty-page filter
  // semantics, never a 404 (mirrors the customer catalog listing).
  let categoryId: string | undefined;
  if (query.category !== undefined) {
    const category = await prisma.category.findUnique({
      where: { slug: query.category },
      select: { id: true },
    });
    if (!category) return { products: [], nextCursor: null };
    categoryId = category.id;
  }

  const where: Prisma.ProductWhereInput = {
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
    ...(query.search !== undefined
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { brand: { contains: query.search, mode: "insensitive" } },
            { composition: { contains: query.search, mode: "insensitive" } },
            { searchKeywords: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await prisma.product.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    products: page.map(toOpsProduct),
    nextCursor: hasMore && last ? last.id : null,
  };
}

export async function getProduct(id: string): Promise<OpsProduct> {
  // Ops sees inactive products too (edit/reactivate) — 404 only when truly absent.
  const product = await getPrisma().product.findUnique({ where: { id } });
  if (!product) throw new AppError("NOT_FOUND", "Product not found", 404);
  return toOpsProduct(product);
}

export async function createProduct(body: CreateProductBody, actor: OpsActor): Promise<OpsProduct> {
  const prisma = getPrisma();

  // Belt-and-suspenders: the contract already refines price ≤ MRP, but the rule
  // is legal (§9.2) so the service refuses it independently of the wire schema.
  if (body.pricePaise > body.mrpPaise) {
    throw new AppError("VALIDATION_ERROR", "pricePaise must be ≤ mrpPaise (legal requirement)", 422, {
      pricePaise: body.pricePaise,
      mrpPaise: body.mrpPaise,
    });
  }

  const category = await prisma.category.findUnique({
    where: { id: body.categoryId },
    select: { id: true },
  });
  if (!category) {
    throw new AppError("VALIDATION_ERROR", "Unknown category", 422, { categoryId: body.categoryId });
  }

  const slug = await uniqueProductSlug(body.slug ?? (slugify(body.name) || "item"));

  const data: Prisma.ProductUncheckedCreateInput = {
    name: body.name,
    slug,
    categoryId: body.categoryId,
    images: body.images ?? [],
    mrpPaise: body.mrpPaise,
    pricePaise: body.pricePaise,
    gstRatePct: body.gstRatePct,
    packSize: body.packSize,
    ...(body.brand !== undefined ? { brand: body.brand } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.hsnCode !== undefined ? { hsnCode: body.hsnCode } : {}),
    ...(body.composition !== undefined ? { composition: body.composition } : {}),
    ...(body.binLocation !== undefined ? { binLocation: body.binLocation } : {}),
    ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
    ...(body.requiresRx !== undefined ? { requiresRx: body.requiresRx } : {}),
    ...(body.scheduleClass !== undefined ? { scheduleClass: body.scheduleClass } : {}),
    ...(body.isColdChain !== undefined ? { isColdChain: body.isColdChain } : {}),
    ...(body.lowStockThreshold !== undefined ? { lowStockThreshold: body.lowStockThreshold } : {}),
    ...(body.maxPerOrder !== undefined ? { maxPerOrder: body.maxPerOrder } : {}),
    ...(body.searchKeywords !== undefined ? { searchKeywords: body.searchKeywords } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
  };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.product.create({ data });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "PRODUCT_CREATED",
          entity: "Product",
          entityId: row.id,
          meta: { name: row.name, slug: row.slug, pricePaise: row.pricePaise, mrpPaise: row.mrpPaise },
        },
      });
      return row;
    });
    return toOpsProduct(created);
  } catch (e) {
    rethrowKnown(e);
  }
}

export async function updateProduct(
  id: string,
  body: UpdateProductBody,
  actor: OpsActor,
): Promise<OpsProduct> {
  const prisma = getPrisma();

  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw new AppError("NOT_FOUND", "Product not found", 404);

  // Re-check price ≤ MRP against the MERGED values (the PATCH schema carries no
  // refine — either field may move, §9.2).
  const mergedPrice = body.pricePaise ?? existing.pricePaise;
  const mergedMrp = body.mrpPaise ?? existing.mrpPaise;
  if (mergedPrice > mergedMrp) {
    throw new AppError("VALIDATION_ERROR", "pricePaise must be ≤ mrpPaise (legal requirement)", 422, {
      pricePaise: mergedPrice,
      mrpPaise: mergedMrp,
    });
  }

  if (body.categoryId !== undefined) {
    const category = await prisma.category.findUnique({
      where: { id: body.categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new AppError("VALIDATION_ERROR", "Unknown category", 422, { categoryId: body.categoryId });
    }
  }

  // Slug is only touched when the caller sends one (renames must not silently
  // break existing product links).
  const slug = body.slug !== undefined ? await uniqueProductSlug(body.slug, id) : undefined;

  const data: Prisma.ProductUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (slug !== undefined) data.slug = slug;
  if (body.brand !== undefined) data.brand = body.brand;
  if (body.description !== undefined) data.description = body.description;
  if (body.categoryId !== undefined) data.categoryId = body.categoryId;
  if (body.images !== undefined) data.images = body.images;
  if (body.mrpPaise !== undefined) data.mrpPaise = body.mrpPaise;
  if (body.pricePaise !== undefined) data.pricePaise = body.pricePaise;
  if (body.gstRatePct !== undefined) data.gstRatePct = body.gstRatePct;
  if (body.hsnCode !== undefined) data.hsnCode = body.hsnCode;
  if (body.packSize !== undefined) data.packSize = body.packSize;
  if (body.composition !== undefined) data.composition = body.composition;
  if (body.binLocation !== undefined) data.binLocation = body.binLocation;
  if (body.barcode !== undefined) data.barcode = body.barcode;
  if (body.requiresRx !== undefined) data.requiresRx = body.requiresRx;
  if (body.scheduleClass !== undefined) data.scheduleClass = body.scheduleClass;
  if (body.isColdChain !== undefined) data.isColdChain = body.isColdChain;
  if (body.lowStockThreshold !== undefined) data.lowStockThreshold = body.lowStockThreshold;
  if (body.maxPerOrder !== undefined) data.maxPerOrder = body.maxPerOrder;
  if (body.searchKeywords !== undefined) data.searchKeywords = body.searchKeywords;
  if (body.isActive !== undefined) data.isActive = body.isActive;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.product.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "PRODUCT_UPDATED",
          entity: "Product",
          entityId: id,
          meta: { changed: Object.keys(body), pricePaise: row.pricePaise, mrpPaise: row.mrpPaise },
        },
      });
      return row;
    });
    return toOpsProduct(updated);
  } catch (e) {
    rethrowKnown(e);
  }
}

/** DELETE = soft-deactivate (`isActive=false`) so order/history references survive. */
export async function deactivateProduct(id: string, actor: OpsActor): Promise<{ ok: true }> {
  const prisma = getPrisma();
  const existing = await prisma.product.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError("NOT_FOUND", "Product not found", 404);

  await prisma.$transaction(async (tx) => {
    await tx.product.update({ where: { id }, data: { isActive: false } });
    await tx.auditLog.create({
      data: { actorId: actor.userId, action: "PRODUCT_DEACTIVATED", entity: "Product", entityId: id },
    });
  });
  return { ok: true };
}

/* -------------------------------------------------------- categories CRUD */

export async function listCategories(): Promise<OpsCategory[]> {
  // Ops manages the full taxonomy (inactive included), stable display order.
  const rows = await getPrisma().category.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toOpsCategory);
}

export async function createCategory(body: CreateCategoryBody, actor: OpsActor): Promise<OpsCategory> {
  const prisma = getPrisma();
  const slug = await uniqueCategorySlug(body.slug ?? (slugify(body.name) || "category"));

  const data: Prisma.CategoryUncheckedCreateInput = {
    name: body.name,
    slug,
    ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
    ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
  };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.category.create({ data });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "CATEGORY_CREATED",
          entity: "Category",
          entityId: row.id,
          meta: { name: row.name, slug: row.slug },
        },
      });
      return row;
    });
    return toOpsCategory(created);
  } catch (e) {
    rethrowKnown(e);
  }
}

export async function updateCategory(
  id: string,
  body: UpdateCategoryBody,
  actor: OpsActor,
): Promise<OpsCategory> {
  const prisma = getPrisma();
  const existing = await prisma.category.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError("NOT_FOUND", "Category not found", 404);

  const slug = body.slug !== undefined ? await uniqueCategorySlug(body.slug, id) : undefined;

  const data: Prisma.CategoryUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (slug !== undefined) data.slug = slug;
  if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl;
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
  if (body.isActive !== undefined) data.isActive = body.isActive;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.category.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "CATEGORY_UPDATED",
          entity: "Category",
          entityId: id,
          meta: { changed: Object.keys(body) },
        },
      });
      return row;
    });
    return toOpsCategory(updated);
  } catch (e) {
    rethrowKnown(e);
  }
}

export async function deactivateCategory(id: string, actor: OpsActor): Promise<{ ok: true }> {
  const prisma = getPrisma();
  const existing = await prisma.category.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError("NOT_FOUND", "Category not found", 404);

  await prisma.$transaction(async (tx) => {
    await tx.category.update({ where: { id }, data: { isActive: false } });
    await tx.auditLog.create({
      data: { actorId: actor.userId, action: "CATEGORY_DEACTIVATED", entity: "Category", entityId: id },
    });
  });
  return { ok: true };
}

/* ------------------------------------------------------------ GRN batches */

/**
 * Goods-received note (§7.2): create the Batch, bump the product stock cache and
 * write a `RECEIVED` StockAdjustment — one transaction. Expiry must be a future
 * date (422). The `[productId, batchNo, invoiceNo]` unique index makes a
 * duplicate GRN a 409.
 */
export async function receiveBatch(
  productId: string,
  body: CreateBatchBody,
  actor: OpsActor,
): Promise<CreateBatchResult> {
  const prisma = getPrisma();

  // Pure date check up front (no I/O) — a batch may not be received already expired.
  if (ymdToUtcMs(body.expiryDate) <= ymdToUtcMs(istTodayYmd())) {
    throw new AppError("VALIDATION_ERROR", "Batch expiry date must be in the future", 422, {
      expiryDate: body.expiryDate,
    });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
      if (!product) throw new AppError("NOT_FOUND", "Product not found", 404);

      const batch = await tx.batch.create({
        data: {
          productId,
          batchNo: body.batchNo,
          expiryDate: new Date(`${body.expiryDate}T00:00:00.000Z`),
          qtyReceived: body.qtyReceived,
          qtyAvailable: body.qtyReceived,
          costPaise: body.costPaise,
          wholesaler: body.wholesaler,
          invoiceNo: body.invoiceNo,
        },
      });

      // Existence was verified above in-tx; a plain atomic increment is enough
      // (there is no negativity risk on a receipt).
      const updated = await tx.product.update({
        where: { id: productId },
        data: { stockQty: { increment: body.qtyReceived } },
        select: { id: true, stockQty: true },
      });

      await tx.stockAdjustment.create({
        data: {
          productId,
          batchId: batch.id,
          delta: body.qtyReceived,
          reason: AdjustReason.RECEIVED,
          actorId: actor.userId,
          note: `GRN ${body.invoiceNo}`,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "BATCH_RECEIVED",
          entity: "Batch",
          entityId: batch.id,
          meta: {
            productId,
            batchNo: body.batchNo,
            qtyReceived: body.qtyReceived,
            invoiceNo: body.invoiceNo,
          },
        },
      });

      return { batch: toBatch(batch), product: { id: updated.id, stockQty: updated.stockQty } };
    });
  } catch (e) {
    rethrowKnown(e);
  }
}

/* --------------------------------------------------------- stock adjust */

/**
 * Manual stock adjustment (§7.2): a signed delta that can never drive stock
 * negative — the conditional `UPDATE … WHERE stockQty + delta >= 0` guard aborts
 * with 409 when it would. Writes a StockAdjustment row and, optionally, applies
 * the same signed delta to a specific batch's `qtyAvailable`.
 */
export async function adjustStock(body: StockAdjustBody, actor: OpsActor): Promise<StockAdjustResult> {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: body.productId },
      select: { id: true },
    });
    if (!product) throw new AppError("NOT_FOUND", "Product not found", 404);

    if (body.batchId !== undefined) {
      const batch = await tx.batch.findUnique({
        where: { id: body.batchId },
        select: { id: true, productId: true },
      });
      if (!batch) throw new AppError("NOT_FOUND", "Batch not found", 404);
      if (batch.productId !== body.productId) {
        throw new AppError("VALIDATION_ERROR", "Batch does not belong to this product", 422, {
          batchId: body.batchId,
        });
      }
    }

    // Conditional guard: only applies when the resulting stock stays ≥ 0.
    const affected = await tx.$executeRaw`
      UPDATE "Product"
      SET "stockQty" = "stockQty" + ${body.delta}
      WHERE "id" = ${body.productId} AND "stockQty" + ${body.delta} >= 0
    `;
    if (affected !== 1) {
      throw new AppError("CONFLICT", "Adjustment would drive stock negative", 409, {
        productId: body.productId,
        delta: body.delta,
      });
    }

    if (body.batchId !== undefined) {
      const affectedBatch = await tx.$executeRaw`
        UPDATE "Batch"
        SET "qtyAvailable" = "qtyAvailable" + ${body.delta}
        WHERE "id" = ${body.batchId} AND "qtyAvailable" + ${body.delta} >= 0
      `;
      if (affectedBatch !== 1) {
        throw new AppError("CONFLICT", "Adjustment would drive batch quantity negative", 409, {
          batchId: body.batchId,
          delta: body.delta,
        });
      }
    }

    const adjustment = await tx.stockAdjustment.create({
      data: {
        productId: body.productId,
        batchId: body.batchId ?? null,
        delta: body.delta,
        reason: body.reason,
        actorId: actor.userId,
        note: body.note ?? null,
      },
    });

    const after = await tx.product.findUniqueOrThrow({
      where: { id: body.productId },
      select: { stockQty: true },
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "STOCK_ADJUSTED",
        entity: "Product",
        entityId: body.productId,
        meta: { delta: body.delta, reason: body.reason, batchId: body.batchId ?? null },
      },
    });

    return { adjustmentId: adjustment.id, productId: body.productId, stockQty: after.stockQty };
  });
}

/* ---------------------------------------------------------------- alerts */

interface LowStockRow {
  id: string;
  name: string;
  stockQty: number;
  lowStockThreshold: number;
  binLocation: string;
}

/**
 * Active products at/below their reorder threshold. Prisma cannot compare two
 * columns in a `where`, so this is a small raw read (no user input → injection-safe).
 */
export async function listLowStock(): Promise<LowStockItem[]> {
  const rows = await getPrisma().$queryRaw<LowStockRow[]>`
    SELECT "id", "name", "stockQty", "lowStockThreshold", "binLocation"
    FROM "Product"
    WHERE "isActive" = true AND "stockQty" <= "lowStockThreshold"
    ORDER BY "stockQty" ASC, "name" ASC
  `;
  return rows.map((r) => ({
    productId: r.id,
    name: r.name,
    stockQty: r.stockQty,
    lowStockThreshold: r.lowStockThreshold,
    binLocation: r.binLocation,
  }));
}

/**
 * Batches with stock on shelf expiring within `days` (IST). Already-expired
 * batches are included (negative `daysToExpiry`) — they are the most urgent.
 */
export async function listNearExpiry(query: NearExpiryQuery): Promise<NearExpiryItem[]> {
  const todayYmd = istTodayYmd();
  const cutoff = new Date(ymdToUtcMs(todayYmd) + query.days * DAY_MS);

  const rows = await getPrisma().batch.findMany({
    where: { qtyAvailable: { gt: 0 }, expiryDate: { lte: cutoff } },
    orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
    include: { product: { select: { name: true } } },
  });

  const todayMs = ymdToUtcMs(todayYmd);
  return rows.map((b) => {
    const expiryYmd = dateToYmd(b.expiryDate);
    return {
      batchId: b.id,
      productId: b.productId,
      productName: b.product.name,
      batchNo: b.batchNo,
      expiryDate: expiryYmd,
      qtyAvailable: b.qtyAvailable,
      daysToExpiry: Math.round((ymdToUtcMs(expiryYmd) - todayMs) / DAY_MS),
    };
  });
}
