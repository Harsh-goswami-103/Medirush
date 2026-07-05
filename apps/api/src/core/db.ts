import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

/**
 * PrismaClient singleton, log events wired to pino.
 * Lazy so importing this module never opens a connection (Prisma connects on
 * first query anyway; laziness also keeps tests hermetic).
 */

interface PrismaLogEvent {
  timestamp: Date;
  message: string;
  target: string;
}

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (client) return client;

  client = new PrismaClient({
    log: [
      { level: "warn", emit: "event" },
      { level: "error", emit: "event" },
    ],
  });

  // $on's event names are generic over the constructor's `log` literal type;
  // narrow cast keeps the runtime wiring without depending on generated generics.
  const emitter = client as unknown as {
    $on: (event: "warn" | "error", cb: (e: PrismaLogEvent) => void) => void;
  };
  emitter.$on("warn", (e) => logger.warn({ prisma: e.target }, e.message));
  emitter.$on("error", (e) => logger.error({ prisma: e.target }, e.message));

  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
