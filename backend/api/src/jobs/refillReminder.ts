import type PgBoss from "pg-boss";
import { getPrisma } from "../core/db";
import { wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";
import { notifyUser } from "../modules/notifications/service";

/**
 * Daily refill-reminder sweep (§17 v1.1): every due reminder nudges its owner
 * to reorder, then rolls forward by its own interval.
 *
 * Idempotent by construction — a row is only ever advanced to a `nextDueAt`
 * STRICTLY in the future, so a second run on the same day (retry, duplicate
 * schedule fire) finds nothing due and cannot double-notify. Paged with a
 * keyset predicate rather than a full table load, and a row that throws is
 * logged and stepped over: one bad reminder must never abort the sweep (and,
 * because the keyset has already moved past it, cannot loop it either).
 *
 * The keyset is an explicit `id > lastSeen` predicate, NOT Prisma's
 * `cursor`/`skip`: the sweep mutates each row out of the `nextDueAt <= now`
 * filter as it goes, so the cursor row would no longer exist in the next
 * page's result set and Prisma's skip:1 would drop a due reminder per page.
 */

export const REFILL_REMINDER_QUEUE = "refill-reminder";
/** 09:00 IST — a reorder nudge should land in the morning, not overnight. */
const REFILL_REMINDER_CRON = "0 9 * * *";
const REFILL_REMINDER_TZ = "Asia/Kolkata";

/** Notification type for the reorder nudge (consent: NotificationPreference.refillReminders). */
export const REFILL_NOTIFICATION_TYPE = "REFILL_DUE";

const PAGE_SIZE = 200;
/** Hard stop so a pathological data state can never spin the worker forever. */
const MAX_PAGES = 500;
const DAY_MS = 86_400_000;

export interface RefillSweepResult {
  /** Reminders that came back due in this pass. */
  due: number;
  notified: number;
  /** Due but not notified: product no longer sellable, or consent withdrawn. */
  skipped: number;
  failed: number;
}

/**
 * Next occurrence strictly after `now`. Missed periods (the job was down for
 * days) collapse into a single nudge rather than a burst of back-dated ones.
 */
export function advanceDueDate(nextDueAt: Date, intervalDays: number, now: Date): Date {
  const step = intervalDays * DAY_MS;
  const periods = Math.floor((now.getTime() - nextDueAt.getTime()) / step) + 1;
  return new Date(nextDueAt.getTime() + periods * step);
}

/**
 * Run one sweep pass. `now` is injectable so the due cutoff is deterministic
 * under test; `pageSize` so paging can be exercised without seeding a full page.
 */
export async function runRefillReminderSweep(
  now: Date = new Date(),
  pageSize: number = PAGE_SIZE,
): Promise<RefillSweepResult> {
  const prisma = getPrisma();
  const result: RefillSweepResult = { due: 0, notified: 0, skipped: 0, failed: 0 };

  let lastId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await prisma.refillReminder.findMany({
      where: {
        isActive: true,
        nextDueAt: { lte: now },
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      orderBy: { id: "asc" },
      take: pageSize,
      select: {
        id: true,
        userId: true,
        productId: true,
        intervalDays: true,
        nextDueAt: true,
        product: { select: { name: true, slug: true, isActive: true } },
      },
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]?.id;

    const optedOut = new Set(
      (
        await prisma.notificationPreference.findMany({
          where: { userId: { in: rows.map((row) => row.userId) }, refillReminders: false },
          select: { userId: true },
        })
      ).map((pref) => pref.userId),
    );

    for (const row of rows) {
      result.due += 1;
      const shouldNotify = row.product.isActive && !optedOut.has(row.userId);
      try {
        if (shouldNotify) {
          await notifyUser({
            userId: row.userId,
            type: REFILL_NOTIFICATION_TYPE,
            title: "Time to reorder",
            body: `Time to reorder ${row.product.name} — tap to add it to your cart.`,
            data: { productId: row.productId, slug: row.product.slug },
            category: "refill",
          });
        }
        // Conditional on the state this pass read: if the customer changed the
        // schedule (or paused it) since, their edit wins and we leave it alone
        // rather than writing back a nextDueAt derived from a stale interval.
        const advanced = await prisma.refillReminder.updateMany({
          where: {
            id: row.id,
            nextDueAt: row.nextDueAt,
            intervalDays: row.intervalDays,
            isActive: true,
          },
          data: {
            nextDueAt: advanceDueDate(row.nextDueAt, row.intervalDays, now),
            ...(shouldNotify ? { lastNotifiedAt: now } : {}),
          },
        });
        if (advanced.count === 0) {
          logger.info(
            { refillReminderId: row.id, userId: row.userId },
            "refill-reminder: row changed concurrently, advance skipped",
          );
        }
        if (shouldNotify) result.notified += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        logger.warn(
          { err: error, refillReminderId: row.id, userId: row.userId },
          "refill-reminder: row failed",
        );
      }
    }

    if (rows.length < pageSize) break;
  }

  logger.info(result, "refill-reminder sweep completed");
  return result;
}

/** Create the queue, register the worker, and schedule the daily cron. */
export async function registerRefillReminder(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(REFILL_REMINDER_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: REFILL_REMINDER_QUEUE }, "createQueue skipped");
  }

  await boss.work(
    REFILL_REMINDER_QUEUE,
    wrapWorker(REFILL_REMINDER_QUEUE, async () => {
      await runRefillReminderSweep();
    }),
  );

  await boss.schedule(REFILL_REMINDER_QUEUE, REFILL_REMINDER_CRON, {}, { tz: REFILL_REMINDER_TZ });
  logger.info({ cron: REFILL_REMINDER_CRON, tz: REFILL_REMINDER_TZ }, "refill-reminder scheduled");
}
