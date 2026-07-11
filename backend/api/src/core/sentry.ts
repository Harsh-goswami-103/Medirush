import * as Sentry from "@sentry/node";
import { getConfig } from "./config";
import { logger } from "./logger";

/**
 * Sentry error reporting with a config-selected no-op (mirrors the Razorpay/R2
 * stub posture, §7 Phase 7):
 *
 * - `SENTRY_DSN` set → initialise the SDK; unhandled 5xx + crash handlers report.
 * - unset (dev/test) → every hook here is a cheap no-op; nothing is sent.
 *
 * Call `initSentry()` ONCE at process start, before `buildApp()`, so the error
 * handler and crash hooks can report through it. Errors are always captured when
 * enabled; only tracing is sampled.
 */

let enabled = false;

export function initSentry(): void {
  const config = getConfig();
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    // Errors are always captured; traces are sampled (tune per traffic).
    tracesSampleRate: config.isProduction ? 0.1 : 1.0,
  });
  enabled = true;
  logger.info("sentry initialised");
}

/** Report an exception with optional request context. No-op when disabled. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Flush buffered events before the process exits (best-effort, bounded). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.close(timeoutMs);
  } catch {
    // Never block shutdown on telemetry.
  }
}
