import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  LocationUpdateEventSchema,
  OPS_ROOM,
  OrderStatus,
  PhoneSchema,
  Role,
  driverRoom,
  orderRoom,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from "@medrush/contracts";
import { getConfig } from "./config";
import { getPrisma } from "./db";
import { verifyFirebaseToken } from "./firebase";
import { setDriverLocation } from "./locationStore";
import { logger } from "./logger";

/**
 * Socket.io wiring (§7.3): handshake token verification + authorization-checked
 * room joins.
 *
 * NOTE (integrator): `verifySocketToken` duplicates the token-verification chain
 * in `plugins/auth.ts` (agent A) because that module's private `verifyToken`
 * helper is not exported and agent A's files are out of scope for agent C. If
 * the chain changes, keep both in lock-step (or factor a shared util in a later
 * phase).
 */

export type MedrushIo = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
type MedrushSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

let io: MedrushIo | null = null;

const DEV_TOKEN_PREFIX = "dev:";

/** Verify a handshake token the same way the HTTP auth hook does (§8). */
async function verifySocketToken(token: string): Promise<{ uid: string; phone: string }> {
  const config = getConfig();

  if (config.FIREBASE_PROJECT_ID !== undefined) {
    return verifyFirebaseToken(token);
  }
  if (!config.isProduction && token.startsWith(DEV_TOKEN_PREFIX)) {
    const [, uid, phone] = token.split(":");
    if (uid && phone && PhoneSchema.safeParse(phone).success) {
      return { uid, phone };
    }
  }
  throw new Error("UNAUTHENTICATED");
}

/** Resolve a verified uid to a socket identity, or null when not synced/blocked. */
async function resolveSocketIdentity(uid: string): Promise<SocketData | null> {
  const user = await getPrisma().user.findUnique({
    where: { firebaseUid: uid },
    select: {
      id: true,
      role: true,
      isBlocked: true,
      driver: { select: { id: true, isVerified: true } },
    },
  });
  if (!user || user.isBlocked) return null;
  // Only a VERIFIED driver is granted driverProfileId (its driver room + the
  // location:update path), matching the HTTP driver gate — an unverified driver
  // must not act as one over the socket either (defense-in-depth, §8.2).
  return {
    userId: user.id,
    role: user.role,
    ...(user.driver?.isVerified ? { driverProfileId: user.driver.id } : {}),
  };
}

/**
 * May this identity join the requested room? (§7.3 authorization matrix.)
 * Exported for the room-authz test — a customer must never join another order's
 * room (no cross-order `driver:location` leak).
 */
export async function canJoinRoom(data: SocketData, room: string): Promise<boolean> {
  const isStaff = data.role === Role.INVENTORY || data.role === Role.ADMIN;

  if (room === OPS_ROOM) return isStaff;

  if (room.startsWith("driver:")) {
    return data.driverProfileId !== undefined && room === driverRoom(data.driverProfileId);
  }

  if (room.startsWith("order:")) {
    if (isStaff) return true;
    const orderId = room.slice("order:".length);
    const order = await getPrisma().order.findUnique({
      where: { id: orderId },
      select: { userId: true },
    });
    return order?.userId === data.userId;
  }

  return false;
}

export function attachSocket(httpServer: HttpServer): MedrushIo {
  const config = getConfig();

  io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      cors: {
        origin: [config.WEB_ORIGIN, config.OPS_ORIGIN],
        credentials: true,
      },
    },
  );

  // Handshake verification — reject bad tokens with a connect error (§7.3).
  io.use((socket: MedrushSocket, next) => {
    const raw: unknown = socket.handshake.auth["token"];
    const token = typeof raw === "string" ? raw.trim() : "";
    if (token.length === 0) {
      next(new Error("UNAUTHENTICATED"));
      return;
    }
    void (async () => {
      try {
        const { uid } = await verifySocketToken(token);
        const identity = await resolveSocketIdentity(uid);
        if (!identity) {
          next(new Error("UNAUTHENTICATED"));
          return;
        }
        socket.data = identity;
        next();
      } catch {
        next(new Error("UNAUTHENTICATED"));
      }
    })();
  });

  io.on("connection", (socket: MedrushSocket) => {
    const { userId, role, driverProfileId } = socket.data;
    logger.debug({ socketId: socket.id, userId, role }, "socket connected");

    // Auto-join the rooms this identity is unconditionally entitled to.
    if (role === Role.INVENTORY || role === Role.ADMIN) {
      void socket.join(OPS_ROOM);
    }
    if (role === Role.DRIVER && driverProfileId) {
      void socket.join(driverRoom(driverProfileId));
    }

    // Order rooms are per-order and ownership-checked, so they are joined on
    // demand. `join` is not part of the typed client contract — attach it as a
    // raw listener and authorize before joining.
    const raw = socket as unknown as {
      on(event: string, listener: (room: unknown, ack?: (ok: boolean) => void) => void): void;
    };
    raw.on("join", (room: unknown, ack?: (ok: boolean) => void) => {
      if (typeof room !== "string") {
        ack?.(false);
        return;
      }
      void (async () => {
        const allowed = await canJoinRoom(socket.data, room).catch(() => false);
        if (allowed) await socket.join(room);
        ack?.(allowed);
      })();
    });

    // Driver location pings (§7.3/§11): held in memory, broadcast to the order
    // room. Accepted only from a driver who has an active delivery.
    socket.on("location:update", (payload) => {
      const driverProfileId = socket.data.driverProfileId;
      if (!driverProfileId) return;
      // Validate the untrusted client payload before any use — ignore malformed
      // pings (out-of-range lat/lng, wrong types) rather than trust them (§7.3).
      const parsed = LocationUpdateEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const ping = parsed.data;
      void (async () => {
        const active = await getPrisma().delivery.findFirst({
          where: {
            driverId: driverProfileId,
            order: { status: { in: [OrderStatus.ASSIGNED, OrderStatus.PICKED_UP] } },
          },
          orderBy: { acceptedAt: "desc" },
          select: { orderId: true },
        });
        if (!active) return;
        const ts = ping.ts ?? new Date().toISOString();
        setDriverLocation(active.orderId, { lat: ping.lat, lng: ping.lng, ts });
        // socket.to() broadcasts to the room EXCLUDING the sender.
        socket
          .to(orderRoom(active.orderId))
          .emit("driver:location", { orderId: active.orderId, lat: ping.lat, lng: ping.lng, ts });
      })().catch((err) => logger.warn({ err }, "location:update handling failed"));
    });

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
  io.emit("server:restarting");
  await io.close();
  io = null;
  logger.info("socket.io closed");
}
