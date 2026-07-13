import type PgBoss from "pg-boss";
import { getBoss, isJobsStarted, wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";
import { generateInvoiceForOrder } from "../modules/invoices/service";

/**
 * Invoice-PDF job (BLUEPRINT §9.6/§9.7): enqueued after an order reaches
 * DELIVERED; the worker renders the GST invoice and uploads it to private R2.
 * Generation is idempotent, so a retry (or a duplicate enqueue) is safe.
 */

/** Queue name for the post-delivery invoice render. */
export const INVOICE_PDF_QUEUE = "invoice-pdf";

interface InvoicePdfJobData {
  orderId: string;
}

/** Enqueue an invoice render for a just-DELIVERED order (best-effort at the call site). */
export async function enqueueInvoicePdf(orderId: string): Promise<void> {
  // No boss before startJobs() (tests / pre-boot) — safe to skip; generation is
  // idempotent and can be re-triggered later.
  if (!isJobsStarted()) return;
  await getBoss().send(INVOICE_PDF_QUEUE, { orderId } satisfies InvoicePdfJobData);
}

/** Create the queue + register the worker. Called from `core/jobs` at startup. */
export async function registerInvoicePdf(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(INVOICE_PDF_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: INVOICE_PDF_QUEUE }, "createQueue skipped");
  }

  await boss.work<InvoicePdfJobData>(
    INVOICE_PDF_QUEUE,
    wrapWorker(INVOICE_PDF_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await generateInvoiceForOrder(job.data.orderId);
      }
    }),
  );
}
