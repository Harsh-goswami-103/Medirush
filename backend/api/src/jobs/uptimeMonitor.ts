import type PgBoss from "pg-boss";
import { getConfig, type Config } from "../core/config";
import { wrapWorker } from "../core/jobs";
import { logger } from "../core/logger";
import { captureException } from "../core/sentry";

/**
 * Uptime self-check (§24 observability): every 5 minutes GET a health URL and
 * page an alert channel when it stops answering. This is the in-process half of
 * the monitor — the external Better Stack probe still owns "the whole box is
 * gone" (a dead process cannot alert about itself); this half covers the far
 * more common case of a process that is up but not READY (DB unreachable,
 * migrations pending, pg-boss dead).
 *
 * Config-selected no-op like the backup/Razorpay/R2 stubs: with no
 * `UPTIME_ALERT_WEBHOOK_URL` the job is never scheduled, so dev/CI are silent.
 * `UPTIME_CHECK_URL` defaults to the LOCAL `/readyz` on the configured port.
 *
 * The worker NEVER throws: a monitoring job that fails the queue would take out
 * the thing that is supposed to notice failures.
 */

export const UPTIME_MONITOR_QUEUE = "uptime-monitor";
/** Every 5 minutes, same cadence as the business watchdog. */
const UPTIME_CRON = "*/5 * * * *";
const UPTIME_TZ = "Asia/Kolkata";

/** Outbound deadline (§10 convention) — a hung endpoint must not wedge the worker. */
const CHECK_TIMEOUT_MS = 10_000;
/** The alert POST is best-effort and quick. */
const ALERT_TIMEOUT_MS = 10_000;

/**
 * Alert fatigue: a sustained outage must not fire 12 identical alerts an hour.
 * We page on the TRANSITION into failure (1st consecutive failure) and then
 * only every 6th consecutive failure — i.e. a reminder every ~30 min while the
 * outage lasts — plus a single "recovered" line when it clears.
 */
const REALERT_EVERY = 6;

/** Consecutive failed checks; module state is fine — one monitor per process. */
let consecutiveFailures = 0;
/** Whether the current failure streak has already paged (drives the recovery line). */
let alertedThisOutage = false;

/**
 * Is the alert channel configured? The webhook is the whole point of the job —
 * without somewhere to page, a self-check is just a log line. Exported so the
 * gating is unit-testable.
 */
export function isUptimeMonitorConfigured(config: Config): boolean {
  return Boolean(config.UPTIME_ALERT_WEBHOOK_URL);
}

/** Configured check URL, defaulting to the local readiness probe. */
export function uptimeCheckUrl(config: Config): string {
  return config.UPTIME_CHECK_URL ?? `http://127.0.0.1:${config.PORT}/readyz`;
}

export interface UptimeCheckResult {
  skipped: boolean;
  ok?: boolean;
  status?: number;
  /** Round-trip time of the check request. */
  ms?: number;
  /** Consecutive failures INCLUDING this pass (0 when healthy). */
  consecutiveFailures?: number;
  /** Whether this pass sent something to the webhook. */
  alerted?: boolean;
}

/**
 * Run one check. Resolves ALWAYS — failures are reported through the alert
 * channel + Sentry, never by rejecting.
 */
export async function runUptimeCheck(): Promise<UptimeCheckResult> {
  const config = getConfig();
  if (!isUptimeMonitorConfigured(config)) return { skipped: true };

  const url = uptimeCheckUrl(config);
  const started = Date.now();
  let ok = false;
  let status: number | undefined;
  let reason = "";

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    status = response.status;
    ok = response.ok;
    if (!ok) reason = `HTTP ${response.status}`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const ms = Date.now() - started;

  if (ok) {
    const recovered = alertedThisOutage;
    consecutiveFailures = 0;
    alertedThisOutage = false;
    logger.info({ url, status, ms }, "uptime check ok");
    if (recovered) {
      await postUptimeAlert(`✅ MedRush uptime check recovered — ${url} answered ${status} in ${ms}ms`);
      return { skipped: false, ok: true, status, ms, consecutiveFailures: 0, alerted: true };
    }
    return { skipped: false, ok: true, status, ms, consecutiveFailures: 0, alerted: false };
  }

  consecutiveFailures += 1;
  logger.error({ url, status, ms, reason, consecutiveFailures }, "uptime check FAILED");

  const shouldAlert = consecutiveFailures === 1 || consecutiveFailures % REALERT_EVERY === 0;
  if (!shouldAlert) {
    return { skipped: false, ok: false, status, ms, consecutiveFailures, alerted: false };
  }

  const message =
    `🚨 MedRush uptime check failed — ${url}: ${reason} (${ms}ms), ` +
    `${consecutiveFailures} consecutive failure(s)`;
  await postUptimeAlert(message);
  captureException(new Error(message), { url, status, ms, consecutiveFailures });
  alertedThisOutage = true;

  return { skipped: false, ok: false, status, ms, consecutiveFailures, alerted: true };
}

/**
 * POST a compact Slack-compatible `{ text }` payload. Best-effort: a dead alert
 * channel is a warn, never a throw — the failure is already in the logs and
 * Sentry.
 */
async function postUptimeAlert(text: string): Promise<void> {
  const url = getConfig().UPTIME_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error }, "uptime alert webhook POST failed");
  }
}

/** Test-only: drop the failure-streak state between cases. */
export function resetUptimeStateForTests(): void {
  consecutiveFailures = 0;
  alertedThisOutage = false;
}

/**
 * Create the queue, register the worker, and schedule the 5-minute cron.
 * Unconfigured → a single boot log and nothing scheduled.
 */
export async function registerUptimeMonitor(boss: PgBoss): Promise<void> {
  if (!isUptimeMonitorConfigured(getConfig())) {
    logger.info("uptime-monitor disabled — UPTIME_ALERT_WEBHOOK_URL unset");
    return;
  }

  try {
    await boss.createQueue(UPTIME_MONITOR_QUEUE);
  } catch (error) {
    logger.warn({ err: error, queue: UPTIME_MONITOR_QUEUE }, "createQueue skipped");
  }

  await boss.work(
    UPTIME_MONITOR_QUEUE,
    wrapWorker(UPTIME_MONITOR_QUEUE, async () => {
      // runUptimeCheck never rejects; the belt-and-braces catch keeps a future
      // change from parking the monitor queue in the failed state.
      try {
        await runUptimeCheck();
      } catch (error) {
        logger.error({ err: error }, "uptime check threw (swallowed — monitor must stay up)");
      }
    }),
  );

  await boss.schedule(UPTIME_MONITOR_QUEUE, UPTIME_CRON, {}, { tz: UPTIME_TZ });
  logger.info({ cron: UPTIME_CRON, tz: UPTIME_TZ }, "uptime-monitor scheduled");
}
