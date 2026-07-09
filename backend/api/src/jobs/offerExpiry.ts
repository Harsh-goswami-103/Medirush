import type PgBoss from "pg-boss";
import { OFFER_EXPIRES_SEC } from "@medrush/contracts";
import { getBoss, isJobsStarted } from "../core/jobs";
import { logger } from "../core/logger";
import { expireAndEscalate } from "../modules/dispatch/service";

/**
 * Offer-expiry job (BLUEPRINT §9.5): OFFER_EXPIRES_SEC after an order is offered,
 * any still-OFFERED offers for it are expired and dispatch escalates (wave 2 →
 * ops alert). No-op once the order is assigned/cancelled, so a late fire or a
 * duplicate enqueue is safe. `singletonKey` = orderId dedupes overlapping waves.
 */

export const OFFER_EXPIRY_QUEUE = "offer-expiry";

interface OfferExpiryJobData {
  orderId: string;
}

/** Schedule the expiry sweep for an order (best-effort; the watchdog backs it up). */
export async function enqueueOfferExpiry(orderId: string): Promise<void> {
  if (!isJobsStarted()) return; // no boss in tests / pre-boot — watchdog covers it
  await getBoss().send(
    OFFER_EXPIRY_QUEUE,
    { orderId } satisfies OfferExpiryJobData,
    { startAfter: OFFER_EXPIRES_SEC, singletonKey: orderId },
  );
}

/** Create the queue + register the worker. Called from `core/jobs` at startup. */
export async function registerOfferExpiry(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(OFFER_EXPIRY_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: OFFER_EXPIRY_QUEUE }, "createQueue skipped");
  }

  await boss.work<OfferExpiryJobData>(OFFER_EXPIRY_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await expireAndEscalate(job.data.orderId);
    }
  });
}
