import { pino, type Logger } from "pino";
import { getConfig } from "./config";

/** Redaction list per phase-0 conventions — enforced on every log line. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "*.token",
  "*.phone",
  "*.addressSnapshot",
  "*.otp",
];

function createLogger(): Logger {
  const config = getConfig();
  const level = config.isProduction ? "info" : config.isTest ? "warn" : "debug";
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    // pino-pretty transport only in dev; prod/test emit raw NDJSON.
    ...(config.isDevelopment
      ? {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}

export const logger: Logger = createLogger();
