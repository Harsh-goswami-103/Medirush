import type { Product, RefillReminder as DbRefillReminder } from "@prisma/client";
import type { RefillReminder, UpsertRefillBody } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { toProductSummary } from "../catalog/search";

/**
 * Refill reminders (§17 v1.1): one opt-in nudge per (user, product), swept daily
 * by jobs/refillReminder.ts. Every read and write is owner-scoped in the query
 * `where` — a foreign id answers 404 so ids cannot be probed.
 */

const DAY_MS = 86_400_000;

export const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS);

type RefillWithProduct = DbRefillReminder & { product: Product };

function toRefillDto(row: RefillWithProduct): RefillReminder {
  return {
    id: row.id,
    product: toProductSummary(row.product),
    intervalDays: row.intervalDays,
    nextDueAt: row.nextDueAt.toISOString(),
    isActive: row.isActive,
    lastNotifiedAt: row.lastNotifiedAt ? row.lastNotifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The caller's own reminders, soonest-due first. */
export async function listRefills(userId: string): Promise<RefillReminder[]> {
  const rows = await getPrisma().refillReminder.findMany({
    where: { userId },
    include: { product: true },
    orderBy: [{ nextDueAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toRefillDto);
}

/**
 * Upsert by (user, product). Re-submitting an existing reminder re-arms it —
 * a paused reminder goes active again and the schedule restarts from
 * `startFrom ?? now`.
 */
export async function upsertRefill(
  userId: string,
  body: UpsertRefillBody,
  now: Date = new Date(),
): Promise<RefillReminder> {
  const prisma = getPrisma();

  const product = await prisma.product.findFirst({
    where: { id: body.productId, isActive: true },
    select: { id: true },
  });
  if (!product) {
    throw new AppError("NOT_FOUND", "Product not found", 404);
  }

  const startFrom = body.startFrom ? new Date(body.startFrom) : now;
  const nextDueAt = addDays(startFrom, body.intervalDays);

  const row = await prisma.refillReminder.upsert({
    where: { userId_productId: { userId, productId: body.productId } },
    create: {
      userId,
      productId: body.productId,
      intervalDays: body.intervalDays,
      nextDueAt,
    },
    update: {
      intervalDays: body.intervalDays,
      nextDueAt,
      isActive: true,
    },
    include: { product: true },
  });

  return toRefillDto(row);
}

/** Delete one own reminder. Ownership is in the `where` — a foreign id is a 404. */
export async function deleteRefill(userId: string, id: string): Promise<void> {
  const { count } = await getPrisma().refillReminder.deleteMany({ where: { id, userId } });
  if (count === 0) {
    throw new AppError("NOT_FOUND", "Refill reminder not found", 404);
  }
}
