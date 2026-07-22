import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, type App } from "./app";
import { assertNoDevTokenBypass, getConfig } from "./core/config";
import { disconnectPrisma } from "./core/db";
import { startJobs, stopJobs } from "./core/jobs";
import { setShuttingDown } from "./core/lifecycle";
import { logger } from "./core/logger";
import { flushOpsAlertWrites } from "./core/realtime";
import { captureException, flushSentry, initSentry } from "./core/sentry";
import { attachSocket, closeSocket } from "./core/socket";

/** Hard-exit budget for graceful shutdown (§11: 25s). */
const SHUTDOWN_BUDGET_MS = 25_000;

/**
 * Ordered graceful-shutdown steps (§11). Socket.io closes BEFORE the HTTP
 * server: Fastify 5's default `forceCloseConnections: 'idle'` never reaps
 * ACTIVE WebSocket upgrades, so closing the app first left every deploy with a
 * connected driver/tracking client hanging until the hard-exit budget — and the
 * `server:restarting` notice never reached them. `closeSocket()` emits the
 * notice while clients are still connected, then `io.close()` force-closes the
 * upgraded sockets (and the shared HTTP server, draining in-flight requests);
 * the later `app.close()` still runs every plugin onClose hook and tolerates
 * the already-closed listener (ERR_SERVER_NOT_RUNNING is swallowed by fastify).
 *
 * Exported so the shutdown-order integration test can drive it directly —
 * SIGTERM is not reliably deliverable in-process on Windows.
 */
export async function runShutdown(app: App): Promise<void> {
  setShuttingDown(); // 1. /readyz flips 503 → routing stops
  await closeSocket(); // 2. emit server:restarting, io.close() (WS force-close + HTTP drain)
  await app.close(); // 3. remaining in-flight HTTP + plugin onClose hooks
  await stopJobs(); // 4. boss.stop({ graceful: true })
  await flushOpsAlertWrites(); // 5. drain fire-and-forget OpsAlert persists
  await disconnectPrisma(); // 6. prisma.$disconnect()
  await flushSentry(); // 7. flush buffered error events
}

async function start(): Promise<void> {
  const config = getConfig();
  assertNoDevTokenBypass(config);
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
      await runShutdown(app);
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

/**
 * Boot only when executed as the entrypoint (`node dist/server.js`, `tsx watch
 * src/server.ts`) — importing this module (shutdown test) must be side-effect
 * free. Windows paths compare case-insensitively.
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(entry) === normalize(fileURLToPath(import.meta.url));
})();

if (isMain) {
  // Initialise error reporting before anything else so the whole process is
  // covered (no-op unless SENTRY_DSN is set).
  initSentry();

  process.on("unhandledRejection", (reason) => crashExit("unhandledRejection", reason));
  process.on("uncaughtException", (error) => crashExit("uncaughtException", error));

  start().catch((error: unknown) => {
    logger.fatal({ err: error }, "failed to start api");
    process.exit(1);
  });
}
