import { buildApp } from "./app";
import { getConfig } from "./core/config";
import { disconnectPrisma } from "./core/db";
import { startJobs, stopJobs } from "./core/jobs";
import { setShuttingDown } from "./core/lifecycle";
import { logger } from "./core/logger";
import { captureException, flushSentry, initSentry } from "./core/sentry";
import { attachSocket, closeSocket } from "./core/socket";

/** Hard-exit budget for graceful shutdown (§11: 25s). */
const SHUTDOWN_BUDGET_MS = 25_000;

// Initialise error reporting before anything else so the whole process is covered
// (no-op unless SENTRY_DSN is set).
initSentry();

async function start(): Promise<void> {
  const config = getConfig();
  const app = await buildApp();

  await app.listen({ host: "0.0.0.0", port: config.PORT });
  await startJobs();
  attachSocket(app.server);

  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      docs: config.isProduction ? undefined : `http://localhost:${config.PORT}/docs`,
    },
    "medrush api ready",
  );

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info({ signal }, "graceful shutdown started");

    // Hard-exit timer: never hang a deploy longer than the budget.
    const hardExit = setTimeout(() => {
      logger.fatal("graceful shutdown exceeded budget — forcing exit");
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);
    hardExit.unref();

    try {
      setShuttingDown(); // 1. /readyz flips 503 → routing stops
      await app.close(); // 2. drain in-flight HTTP
      await closeSocket(); // 3. emit server:restarting, io.close()
      await stopJobs(); // 4. boss.stop({ graceful: true })
      await disconnectPrisma(); // 5. prisma.$disconnect()
      await flushSentry(); // 6. flush buffered error events
      logger.info("graceful shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/** Report a fatal crash to Sentry (bounded), then exit non-zero. */
function crashExit(kind: string, err: unknown): void {
  logger.fatal({ err }, `${kind} — exiting`);
  captureException(err, { fatal: kind });
  void flushSentry(1500).finally(() => process.exit(1));
}

process.on("unhandledRejection", (reason) => crashExit("unhandledRejection", reason));
process.on("uncaughtException", (error) => crashExit("uncaughtException", error));

start().catch((error: unknown) => {
  logger.fatal({ err: error }, "failed to start api");
  process.exit(1);
});
