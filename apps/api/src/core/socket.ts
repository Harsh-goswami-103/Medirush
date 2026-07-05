import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@medrush/contracts";
import { getConfig } from "./config";
import { logger } from "./logger";

/**
 * Socket.io wiring (Phase 0 stub).
 * Typed against the §7.3 contract; room membership + real auth land Phase 1.
 */

export type MedrushIo = Server<ClientToServerEvents, ServerToClientEvents>;

let io: MedrushIo | null = null;

export function attachSocket(httpServer: HttpServer): MedrushIo {
  const config = getConfig();

  io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: [config.WEB_ORIGIN, config.OPS_ORIGIN],
      credentials: true,
    },
  });

  // Auth middleware STUB — reads the handshake token, allows everyone.
  io.use((socket, next) => {
    const raw: unknown = socket.handshake.auth["token"];
    const token = typeof raw === "string" && raw.length > 0 ? raw : null;
    socket.data = { ...socket.data, token };
    // TODO(Phase 1): firebase verifyIdToken(token) → attach { uid, role },
    // reject with UNAUTHENTICATED on failure, and gate room joins
    // (order:{id} owner/ops, driver:{id} self, ops role-checked).
    next();
  });

  io.on("connection", (socket) => {
    logger.debug({ socketId: socket.id }, "socket connected");
    socket.on("disconnect", (reason) => {
      logger.debug({ socketId: socket.id, reason }, "socket disconnected");
    });
  });

  logger.info("socket.io attached");
  return io;
}

export function getIo(): MedrushIo | null {
  return io;
}

/** §11 order: emit server:restarting, then close (clients reconnect to the new instance). */
export async function closeSocket(): Promise<void> {
  if (!io) return;
  // "server:restarting" is part of the §11 shutdown contract; cast keeps us
  // decoupled from whether contracts lists it in ServerToClientEvents yet.
  (io as unknown as { emit: (event: string) => void }).emit("server:restarting");
  await io.close();
  io = null;
  logger.info("socket.io closed");
}
