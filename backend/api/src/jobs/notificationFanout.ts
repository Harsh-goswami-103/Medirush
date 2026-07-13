import type PgBoss from "pg-boss";
import { getBoss, isJobsStarted, wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";
import { sendPushToUser } from "../core/push";

/**
 * Notification-fanout job (Phase 6): after `notifyUser` persists a durable
 * Notification row it enqueues here so the actual push send happens off the
 * request/transition path. The worker calls `core/push.ts` (real FCM or the
 * config-selected stub). The row is durable regardless — the push is a
 * best-effort side-channel, so a stubbed or failed send never loses state.
 */

/** Queue name for the async push fanout. */
export const NOTIFICATION_FANOUT_QUEUE = "notification-fanout";

interface NotificationFanoutJobData {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Enqueue a push send for a user (best-effort at the call site). */
export async function enqueuePush(payload: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  // No boss before startJobs() (tests / pre-boot) — safe to skip; the row is
  // already persisted, push is a non-durable convenience.
  if (!isJobsStarted()) return;
  await getBoss().send(NOTIFICATION_FANOUT_QUEUE, payload satisfies NotificationFanoutJobData);
}

/** Create the queue + register the worker. Called from `core/jobs` at startup. */
export async function registerNotificationFanout(boss: PgBoss): Promise<void> {
  try {
    await boss.createQueue(NOTIFICATION_FANOUT_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: NOTIFICATION_FANOUT_QUEUE }, "createQueue skipped");
  }

  await boss.work<NotificationFanoutJobData>(
    NOTIFICATION_FANOUT_QUEUE,
    wrapWorker(NOTIFICATION_FANOUT_QUEUE, async (jobs) => {
      for (const job of jobs) {
        const { userId, title, body, data } = job.data;
        await sendPushToUser(userId, { title, body, data });
      }
    }),
  );
}
