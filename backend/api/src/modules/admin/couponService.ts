import { Prisma } from "@prisma/client";
import type {
  Coupon,
  CouponKind,
  CouponListQuery,
  CreateCouponBody,
  UpdateCouponBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";

/**
 * Admin coupon management (BLUEPRINT §7.2 admin rows, §10.3 promo rules; RBAC
 * §8: ADMIN only — enforced by marketingRoutes' route config). Codes are stored
 * uppercase and unique; DELETE is a soft-deactivate so CouponRedemption history
 * survives. Every mutation is one $transaction that also writes an AuditLog row
 * (sensitive admin action). Route legality/role gating lives in the plugin.
 */

/** Minimal admin identity threaded from the route for AuditLog attribution. */
export interface AdminActor {
  userId: string;
}

// The redemption tally the CouponSchema wants is a live count, never denormalized.
const COUPON_INCLUDE = {
  _count: { select: { redemptions: true } },
} satisfies Prisma.CouponInclude;

type CouponRow = Prisma.CouponGetPayload<{ include: typeof COUPON_INCLUDE }>;

/** Map a Coupon row (+ redemption count) onto the frozen CouponSchema shape. */
function toCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    // Coupon.kind is a String column (§6.2) constrained to the FLAT|PERCENT set.
    kind: row.kind as CouponKind,
    valuePaiseOrPct: row.valuePaiseOrPct,
    minOrderPaise: row.minOrderPaise,
    maxDiscountPaise: row.maxDiscountPaise,
    usageLimit: row.usageLimit,
    perUserLimit: row.perUserLimit,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    isActive: row.isActive,
    description: row.description,
    isPublic: row.isPublic,
    redemptionCount: row._count.redemptions,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/* --------------------------------------------------------------- queries */

/**
 * Cursor-paginated coupon list (newest-first). Coupon has no createdAt column
 * (§6.2), so we order by the cuid id — its time-ordered prefix is a good proxy
 * for insertion order and gives a stable cursor. Optional `active` filter.
 */
export async function listCoupons(
  query: CouponListQuery,
): Promise<{ coupons: Coupon[]; nextCursor: string | null }> {
  const prisma = getPrisma();
  const rows = await prisma.coupon.findMany({
    where: query.active === undefined ? undefined : { isActive: query.active },
    orderBy: { id: "desc" },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: COUPON_INCLUDE,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    coupons: page.map(toCoupon),
    nextCursor: hasMore && last ? last.id : null,
  };
}

/* --------------------------------------------------------------- actions */

/**
 * Create a coupon. The contract (CreateCouponBodySchema.superRefine) already
 * validates PERCENT ≤ 100 and endsAt > startsAt at the request boundary; the
 * code regex forces uppercase, so `.toUpperCase()` is defensive. A duplicate
 * code trips the unique index → 409 CONFLICT.
 */
export async function createCoupon(body: CreateCouponBody, actor: AdminActor): Promise<Coupon> {
  const prisma = getPrisma();
  const code = body.code.toUpperCase();

  try {
    const coupon = await prisma.$transaction(async (tx) => {
      const created = await tx.coupon.create({
        data: {
          code,
          kind: body.kind,
          valuePaiseOrPct: body.valuePaiseOrPct,
          minOrderPaise: body.minOrderPaise ?? 0,
          maxDiscountPaise: body.maxDiscountPaise ?? null,
          usageLimit: body.usageLimit ?? null,
          perUserLimit: body.perUserLimit ?? 1,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          isActive: body.isActive ?? true,
          description: body.description ?? null,
          isPublic: body.isPublic ?? false,
        },
        include: COUPON_INCLUDE,
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "COUPON_CREATE",
          entity: "Coupon",
          entityId: created.id,
          meta: { code, kind: body.kind, valuePaiseOrPct: body.valuePaiseOrPct },
        },
      });
      return created;
    });
    return toCoupon(coupon);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("CONFLICT", `Coupon code ${code} already exists`, 409, { code });
    }
    throw error;
  }
}

/**
 * Partial update. The PATCH body (couponBodyBase.partial()) drops the create
 * superRefine, so we re-check the two invariants against the merged row before
 * writing — a >100% PERCENT coupon or an inverted window must never persist.
 * A code collision → 409; a vanished row → 404.
 */
export async function updateCoupon(
  id: string,
  body: UpdateCouponBody,
  actor: AdminActor,
): Promise<Coupon> {
  const prisma = getPrisma();

  const data: Prisma.CouponUpdateManyMutationInput = {};
  if (body.code !== undefined) data.code = body.code.toUpperCase();
  if (body.kind !== undefined) data.kind = body.kind;
  if (body.valuePaiseOrPct !== undefined) data.valuePaiseOrPct = body.valuePaiseOrPct;
  if (body.minOrderPaise !== undefined) data.minOrderPaise = body.minOrderPaise;
  if (body.maxDiscountPaise !== undefined) data.maxDiscountPaise = body.maxDiscountPaise;
  if (body.usageLimit !== undefined) data.usageLimit = body.usageLimit;
  if (body.perUserLimit !== undefined) data.perUserLimit = body.perUserLimit;
  if (body.startsAt !== undefined) data.startsAt = new Date(body.startsAt);
  if (body.endsAt !== undefined) data.endsAt = new Date(body.endsAt);
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.description !== undefined) data.description = body.description;
  if (body.isPublic !== undefined) data.isPublic = body.isPublic;

  try {
    const coupon = await prisma.$transaction(async (tx) => {
      // Row lock so concurrent PATCHes serialize; re-read the pre-image UNDER the
      // lock so the merged-invariant check-and-write is atomic (no stale-preimage
      // race where two partial updates each validate then persist an invalid row).
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${id} FOR UPDATE`;
      const existing = await tx.coupon.findUnique({ where: { id } });
      if (!existing) throw new AppError("NOT_FOUND", "Coupon not found", 404);

      const kind = (body.kind ?? existing.kind) as CouponKind;
      const value = body.valuePaiseOrPct ?? existing.valuePaiseOrPct;
      const startsAt = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
      const endsAt = body.endsAt ? new Date(body.endsAt) : existing.endsAt;
      if (kind === "PERCENT" && value > 100) {
        throw new AppError("VALIDATION_ERROR", "PERCENT coupons must be 1–100", 422, {
          valuePaiseOrPct: value,
        });
      }
      if (endsAt <= startsAt) {
        throw new AppError("VALIDATION_ERROR", "endsAt must be after startsAt", 422);
      }

      const updated = await tx.coupon.updateMany({ where: { id }, data });
      if (updated.count !== 1) {
        throw new AppError("NOT_FOUND", "Coupon not found", 404);
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "COUPON_UPDATE",
          entity: "Coupon",
          entityId: id,
          meta: { changed: Object.keys(data) },
        },
      });
      return tx.coupon.findUniqueOrThrow({ where: { id }, include: COUPON_INCLUDE });
    });
    return toCoupon(coupon);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("CONFLICT", "Coupon code already exists", 409);
    }
    throw error;
  }
}

/**
 * DELETE = soft-deactivate (isActive=false). The row and its CouponRedemption
 * history survive (§10.3 audit trail). Missing coupon → 404; already-inactive
 * is a harmless no-op that still succeeds.
 */
export async function deactivateCoupon(id: string, actor: AdminActor): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.coupon.updateMany({
      where: { id },
      data: { isActive: false },
    });
    if (updated.count !== 1) {
      throw new AppError("NOT_FOUND", "Coupon not found", 404);
    }
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "COUPON_DEACTIVATE",
        entity: "Coupon",
        entityId: id,
      },
    });
  });
}
