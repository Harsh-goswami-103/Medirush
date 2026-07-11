import type { Prisma } from "@prisma/client";
import {
  PayoutStatus,
  type AdminPayout,
  type AdminPayoutListQuery,
  type MarkPayoutPaidBody,
  type RejectPayoutBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { logger } from "../../core/logger";
import { notifyUser } from "../notifications/service";
import type { AdminActor } from "./driverService";
import { payoutDebit, payoutReverseCredit } from "./payoutLedger";

/**
 * Admin payout processing (BLUEPRINT §7.2 — role ADMIN; §9.6 money flow):
 *
 *  - approve   REQUESTED → APPROVED, debit the wallet immediately (funds locked;
 *              insufficient balance → 409).
 *  - mark-paid APPROVED → PAID, record the bank UTR. No ledger move.
 *  - reject    → REJECTED. A compensating CREDIT reverses the debit ONLY when the
 *              payout was already APPROVED (a REQUESTED reject never touched the
 *              ledger).
 *
 * Each mutation is one $transaction guarded by a conditional `updateMany` on the
 * status (idempotent — a wrong-status transition is 409) with an AuditLog row.
 */

/** Raw Payout row fields we shape onto the wire. */
type PayoutRow = {
  id: string;
  amountPaise: number;
  status: PayoutStatus;
  method: string;
  upiOrAcct: string;
  utr: string | null;
  requestedAt: Date;
  processedAt: Date | null;
  driverId: string;
};

function shapePayout(
  row: PayoutRow,
  driver: { name: string | null; phone: string },
): AdminPayout {
  return {
    id: row.id,
    amountPaise: row.amountPaise,
    status: row.status,
    method: row.method,
    upiOrAcct: row.upiOrAcct,
    utr: row.utr,
    requestedAt: row.requestedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    driverId: row.driverId,
    driverName: driver.name,
    driverPhone: driver.phone,
  };
}

/** Load one shaped payout joined to its driver (post-mutation response). */
async function loadAdminPayout(id: string): Promise<AdminPayout> {
  const prisma = getPrisma();
  const payout = await prisma.payout.findUnique({ where: { id } });
  if (!payout) throw new AppError("NOT_FOUND", "Payout not found", 404);
  // Payout.driverId is a DriverProfile id (bare column, no relation) — join by hand.
  const driver = await prisma.driverProfile.findUnique({
    where: { id: payout.driverId },
    select: { user: { select: { name: true, phone: true } } },
  });
  if (!driver) throw new AppError("INTERNAL", "Payout references a missing driver", 500);
  return shapePayout(payout, driver.user);
}

/**
 * Post-commit driver notification for a payout transition (§7.2). Best-effort:
 * resolves the DriverProfile → User id and persists a durable Notification;
 * wrapped so it never disrupts the committed money move.
 */
async function notifyDriverPayout(
  driverProfileId: string,
  amountPaise: number,
  type: string,
  title: string,
  body: string,
  payoutId: string,
): Promise<void> {
  try {
    const driver = await getPrisma().driverProfile.findUnique({
      where: { id: driverProfileId },
      select: { userId: true },
    });
    if (!driver) return;
    await notifyUser({ userId: driver.userId, type, title, body, data: { payoutId } });
  } catch (err) {
    logger.warn({ err, payoutId }, "notifyDriverPayout failed (best-effort)");
  }
}

/** ₹ display for a paise amount (payout notification copy). */
const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/**
 * GET /v1/admin/payouts — cursor-paginated, newest first, optional status
 * filter. Driver name/phone are joined in bulk (Payout has no driver relation).
 */
export async function listPayouts(
  query: AdminPayoutListQuery,
): Promise<{ payouts: AdminPayout[]; nextCursor: string | null }> {
  const prisma = getPrisma();
  const where: Prisma.PayoutWhereInput = query.status ? { status: query.status } : {};

  const rows = await prisma.payout.findMany({
    where,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  const driverIds = [...new Set(page.map((row) => row.driverId))];
  const drivers = await prisma.driverProfile.findMany({
    where: { id: { in: driverIds } },
    select: { id: true, user: { select: { name: true, phone: true } } },
  });
  const driverById = new Map(drivers.map((driver) => [driver.id, driver.user]));

  const payouts = page.map((row) => {
    const driver = driverById.get(row.driverId);
    if (!driver) throw new AppError("INTERNAL", "Payout references a missing driver", 500);
    return shapePayout(row, driver);
  });

  return { payouts, nextCursor: hasMore && last ? last.id : null };
}

/**
 * POST /v1/admin/payouts/:id/approve — REQUESTED → APPROVED with an immediate
 * wallet debit under the wallet FOR UPDATE lock (§9.6). The status flip runs
 * first (Payout row lock ⇒ a concurrent double-approve aborts before any money
 * moves); a debit that would go negative throws 409 and rolls the flip back.
 */
export async function approvePayout(id: string, actor: AdminActor): Promise<AdminPayout> {
  const prisma = getPrisma();

  let driverProfileId = "";
  let amountPaise = 0;
  await prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findUnique({
      where: { id },
      select: { status: true, driverId: true, amountPaise: true },
    });
    if (!payout) throw new AppError("NOT_FOUND", "Payout not found", 404);
    if (payout.status !== PayoutStatus.REQUESTED) {
      throw new AppError("CONFLICT", "Only a REQUESTED payout can be approved", 409, {
        status: payout.status,
      });
    }
    driverProfileId = payout.driverId;
    amountPaise = payout.amountPaise;

    const updated = await tx.payout.updateMany({
      where: { id, status: PayoutStatus.REQUESTED },
      data: { status: PayoutStatus.APPROVED },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Payout changed concurrently — reload and retry", 409);
    }

    // Lock the wallet + move funds; insufficient balance → 409 (rolls back).
    await payoutDebit(tx, payout.driverId, payout.amountPaise, id, `Payout ${id} approved`);

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "PAYOUT_APPROVED",
        entity: "Payout",
        entityId: id,
        meta: { driverId: payout.driverId, amountPaise: payout.amountPaise },
      },
    });
  });

  await notifyDriverPayout(
    driverProfileId,
    amountPaise,
    "PAYOUT_APPROVED",
    "Payout approved",
    `Your payout of ${rupees(amountPaise)} was approved and will be paid out shortly.`,
    id,
  );
  return loadAdminPayout(id);
}

/**
 * POST /v1/admin/payouts/:id/mark-paid — APPROVED → PAID, recording the bank UTR
 * and processor. No ledger move (funds were debited at approval).
 */
export async function markPayoutPaid(
  id: string,
  body: MarkPayoutPaidBody,
  actor: AdminActor,
): Promise<AdminPayout> {
  const prisma = getPrisma();

  let driverProfileId = "";
  let amountPaise = 0;
  await prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findUnique({
      where: { id },
      select: { status: true, driverId: true, amountPaise: true },
    });
    if (!payout) throw new AppError("NOT_FOUND", "Payout not found", 404);
    if (payout.status !== PayoutStatus.APPROVED) {
      throw new AppError("CONFLICT", "Only an APPROVED payout can be marked paid", 409, {
        status: payout.status,
      });
    }
    driverProfileId = payout.driverId;
    amountPaise = payout.amountPaise;

    const updated = await tx.payout.updateMany({
      where: { id, status: PayoutStatus.APPROVED },
      data: {
        status: PayoutStatus.PAID,
        utr: body.utr,
        processedAt: new Date(),
        processedBy: actor.userId,
      },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Payout changed concurrently — reload and retry", 409);
    }

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "PAYOUT_PAID",
        entity: "Payout",
        entityId: id,
        meta: { utr: body.utr },
      },
    });
  });

  await notifyDriverPayout(
    driverProfileId,
    amountPaise,
    "PAYOUT_PAID",
    "Payout paid",
    `Your payout of ${rupees(amountPaise)} has been paid (UTR ${body.utr}).`,
    id,
  );
  return loadAdminPayout(id);
}

/**
 * POST /v1/admin/payouts/:id/reject — REQUESTED or APPROVED → REJECTED. A payout
 * that was already APPROVED had its wallet debited, so it gets a compensating
 * CREDIT; a REQUESTED payout never touched the ledger and gets none (§9.6).
 */
export async function rejectPayout(
  id: string,
  body: RejectPayoutBody,
  actor: AdminActor,
): Promise<AdminPayout> {
  const prisma = getPrisma();

  await prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findUnique({
      where: { id },
      select: { status: true, driverId: true, amountPaise: true },
    });
    if (!payout) throw new AppError("NOT_FOUND", "Payout not found", 404);
    if (
      payout.status !== PayoutStatus.REQUESTED &&
      payout.status !== PayoutStatus.APPROVED
    ) {
      throw new AppError("CONFLICT", "Only a REQUESTED or APPROVED payout can be rejected", 409, {
        status: payout.status,
      });
    }

    const wasApproved = payout.status === PayoutStatus.APPROVED;
    const updated = await tx.payout.updateMany({
      where: { id, status: payout.status },
      data: { status: PayoutStatus.REJECTED, processedAt: new Date(), processedBy: actor.userId },
    });
    if (updated.count !== 1) {
      throw new AppError("CONFLICT", "Payout changed concurrently — reload and retry", 409);
    }

    // Reverse the earlier debit only when the payout had actually locked funds.
    if (wasApproved) {
      await payoutReverseCredit(
        tx,
        payout.driverId,
        payout.amountPaise,
        id,
        `Payout ${id} rejected`,
      );
    }

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "PAYOUT_REJECTED",
        entity: "Payout",
        entityId: id,
        meta: { reason: body.reason, reversed: wasApproved, amountPaise: payout.amountPaise },
      },
    });
  });

  return loadAdminPayout(id);
}
