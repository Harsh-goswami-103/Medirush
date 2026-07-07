import type PgBoss from "pg-boss";
import { PAYMENT_TIMEOUT_MIN } from "@medrush/contracts";
import { getBoss, isJobsStarted } from "../core/jobs";
import { logger } from "../core/logger";
import { expireUnpaidOrder } from "../modules/payments/service";

/**
 * Payment-timeout job (BLUEPRINT §9.3, phase-2 brief §3): 15 min after a PREPAID
 * order is created it is enqueued; if the order is still PENDING_PAYMENT when the
 * job runs it is auto-cancelled and its reserved stock released (actor SYSTEM).
 *
 * The handler is a NO-OP once the order has moved on (captured → PLACED, or
 * already cancelled), so a late fire, a retry, or a duplicate enqueue is safe.
 * Enqueue is best-effort AFTER the create TX commits — the stuck-order watchdog
 * (§15) plus this job together cover any orphaned PENDING_PAYMENT rows.
 */

/** Queue name for the PREPAID payment-timeout auto-cancel. */
export const PAYMENT_TIMEOUT_QUEUE = "payment-timeout";

/** Timeout delay in seconds (§9.3: 15 minutes). */
const TIMEOUT_DELAY_SEC = PAYMENT_TIMEOUT_MIN * 60;

interface PaymentTimeoutJobData {
  orderId: string;
}

/**
 * Same-process map of orderId → pg-boss job id, so a `payment.captured` webhook
 * can cancel the pending timeout wakeup. Best-effort only: the idempotent handler
 * (no-op unless still PENDING_PAYMENT) is the real correctness guarantee, so a
 * missed cancel (different process / restart) merely wastes one no-op run.
 */
const pendingJobIds = new Map<string, string>();

/** Schedule the 15-min auto-cancel for a freshly-created PREPAID order. */
export async function enqueuePaymentTimeout(orderId: string): Promise<void> {
  // No boss before startJobs() (tests / pre-boot) — the stuck-order watchdog
  // (§15) still sweeps orphaned PENDING_PAYMENT rows, so skipping is safe.
  if (!isJobsStarted()) return;
  const jobId = await getBoss().send(
    PAYMENT_TIMEOUT_QUEUE,
    { orderId } satisfies PaymentTimeoutJobData,
    { startAfter: TIMEOUT_DELAY_SEC, singletonKey: orderId },
  );
  if (jobId) pendingJobIds.set(orderId, jobId);
}

/** Best-effort cancel of a pending timeout after the order's payment is captured. */
export async function cancelPaymentTimeout(orderId: string): Promise<void> {
  const jobId = pendingJobIds.get(orderId);
  pendingJobIds.delete(orderId);
  if (!jobId) return;
  try {
    await getBoss().cancel(PAYMENT_TIMEOUT_QUEUE, jobId);
  } catch (error) {
    // The handler is idempotent, so a failed cancel is harmless (one no-op run).
    logger.warn({ err: error, orderId, jobId }, "payment-timeout cancel skipped");
  }
}

/** Create the queue + register the worker. Called from `core/jobs` at startup. */
export async function registerPaymentTimeout(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(PAYMENT_TIMEOUT_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: PAYMENT_TIMEOUT_QUEUE }, "createQueue skipped");
  }

  await boss.work<PaymentTimeoutJobData>(PAYMENT_TIMEOUT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      pendingJobIds.delete(job.data.orderId);
      await expireUnpaidOrder(job.data.orderId);
    }
  });
}
