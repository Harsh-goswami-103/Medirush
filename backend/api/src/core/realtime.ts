import * as Sentry from "@sentry/node";
import type { Prisma } from "@prisma/client";
import type {
  DriverLocationEvent,
  OfferCancelledEvent,
  OfferNewEvent,
  OrderStatus,
  PaymentMethod,
  RxStatus,
} from "@medrush/contracts";
import {
  AlertKind,
  OPS_ROOM,
  RxStatus as RxStatusValues,
  driverRoom,
  orderRoom,
} from "@medrush/contracts";
import { getPrisma } from "./db";
import { logger } from "./logger";
import { getIo } from "./socket";

/**
 * Socket emit helpers (§7.3) over `getIo()`. All helpers are null-safe: when
 * socket.io is not attached (tests, `app.inject()`) they are no-ops — domain
 * code never needs to know whether realtime is up.
 *
 * Call these AFTER the DB transaction commits (§9.1) — never inside a TX.
 */

/**
 * Minimal shape pinned in the phase-1 brief is `{ id, status }`; pass the full
 * order row when you have it so the ops `order:update` payload carries the
 * real `orderNo`/`rxStatus` (they fall back to ""/"NA" otherwise — see the
 * contract-mismatch note in the phase-1 integration report).
 */
export interface OrderStatusEmitInput {
  id: string;
  status: OrderStatus;
  orderNo?: string;
  rxStatus?: RxStatus;
}

/** `order:status` to the order room + `order:update` to the ops room. */
export function emitOrderStatus(order: OrderStatusEmitInput): void {
  const io = getIo();
  if (!io) return;
  const at = new Date().toISOString();
  io.to(orderRoom(order.id)).emit("order:status", {
    orderId: order.id,
    status: order.status,
    at,
  });
  io.to(OPS_ROOM).emit("order:update", {
    orderId: order.id,
    orderNo: order.orderNo ?? "",
    status: order.status,
    rxStatus: order.rxStatus ?? RxStatusValues.NA,
    at,
  });
}

export interface OrderNewEmitInput {
  id: string;
  orderNo: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  requiresRx: boolean;
  rxStatus: RxStatus;
  totalPaise: number;
  placedAt: Date | string | null;
}

/** `order:new` to the ops room (the board plays the new-order sound). */
export function emitOrderNew(order: OrderNewEmitInput): void {
  const io = getIo();
  if (!io) return;
  const placedAt =
    order.placedAt instanceof Date
      ? order.placedAt.toISOString()
      : (order.placedAt ?? new Date().toISOString());
  io.to(OPS_ROOM).emit("order:new", {
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status,
    paymentMethod: order.paymentMethod,
    requiresRx: order.requiresRx,
    rxStatus: order.rxStatus,
    totalPaise: order.totalPaise,
    placedAt,
  });
}

/**
 * Money/data-critical alert kinds: on top of the durable row these page through
 * Sentry (`captureMessage`, level error) so a 02:30-IST drift or a failed backup
 * is seen even when no ops tab is open and nobody reads the morning list.
 */
export const CRITICAL_ALERT_KINDS: ReadonlySet<string> = new Set([
  AlertKind.WALLET_DRIFT,
  AlertKind.DB_BACKUP_FAILED,
  AlertKind.STUCK_ORDER,
  AlertKind.MANUAL_REFUND_REQUIRED,
  AlertKind.UNASSIGNED_ORDER,
  AlertKind.FRAUD_VELOCITY,
]);

/**
 * In-flight OpsAlert persist promises. Tracked so shutdown/tests can drain
 * them (`flushOpsAlertWrites`) — a dangling write racing a pool disconnect or
 * a test-suite TRUNCATE is worse than the few bytes this set costs.
 */
const pendingAlertWrites = new Set<Promise<unknown>>();

/** Await every in-flight OpsAlert row write (they never reject). */
export async function flushOpsAlertWrites(): Promise<void> {
  while (pendingAlertWrites.size > 0) {
    await Promise.allSettled([...pendingAlertWrites]);
  }
}

/**
 * `alert` banner/toast to the ops room (watchdogs, fraud rules, …) — PLUS a
 * durable OpsAlert row (§24: a socket emit to an empty room vanishes; the row
 * feeds GET /v1/ops/alerts) and, for CRITICAL_ALERT_KINDS, a Sentry message.
 *
 * Fire-and-forget like every emit helper: the DB write is best-effort async
 * (callers may be sync/post-commit) and NEVER throws into the caller.
 */
export function emitOpsAlert(
  kind: string,
  msg: string,
  refId?: string,
  meta?: Record<string, unknown>,
): void {
  // Durable row — best-effort, never awaited by the caller, never thrown.
  const write = getPrisma()
    .opsAlert.create({
      data: {
        kind,
        message: msg,
        refId: refId ?? null,
        ...(meta !== undefined ? { meta: meta as Prisma.InputJsonValue } : {}),
      },
    })
    .catch((error: unknown) => {
      logger.error({ err: error, kind, refId }, "emitOpsAlert: failed to persist OpsAlert row");
    });
  pendingAlertWrites.add(write);
  void write.finally(() => pendingAlertWrites.delete(write));

  // Paging channel for money/data-critical kinds. The raw SDK call is used
  // because core/sentry's wrapper has no tag support; without `initSentry()`
  // there is no bound client, so this is a guaranteed no-op in dev/test.
  if (CRITICAL_ALERT_KINDS.has(kind)) {
    try {
      Sentry.captureMessage(msg, {
        level: "error",
        tags: { alertKind: kind },
        extra: refId !== undefined ? { refId, ...meta } : { ...meta },
      });
    } catch (error) {
      logger.warn({ err: error, kind }, "emitOpsAlert: sentry captureMessage failed");
    }
  }

  const io = getIo();
  if (!io) return;
  io.to(OPS_ROOM).emit("alert", { kind, msg, ...(refId !== undefined ? { refId } : {}) });
}

/* -------------------------------------------------------- dispatch (§9.5) */

/** `offer:new` to one driver's room (paired with an FCM push in prod). */
export function emitOfferNew(driverProfileId: string, payload: OfferNewEvent): void {
  const io = getIo();
  if (!io) return;
  io.to(driverRoom(driverProfileId)).emit("offer:new", payload);
}

/** `offer:cancelled` to one driver's room — the offer expired or was taken. */
export function emitOfferCancelled(driverProfileId: string, payload: OfferCancelledEvent): void {
  const io = getIo();
  if (!io) return;
  io.to(driverRoom(driverProfileId)).emit("offer:cancelled", payload);
}

/**
 * `driver:status` to the ops room — presence changed. Fire-and-forget like
 * every emit helper here: dispatch eligibility comes from the DriverProfile row
 * (rankCandidates re-reads it per wave), so a dropped emit costs a stale fleet
 * view until its next poll, never a mis-dispatch.
 */
export function emitDriverStatus(driverProfileId: string, isOnline: boolean): void {
  const io = getIo();
  if (!io) return;
  io.to(OPS_ROOM).emit("driver:status", {
    driverProfileId,
    isOnline,
    at: new Date().toISOString(),
  });
}

/** `driver:location` to an order's room — live position while ASSIGNED/PICKED_UP. */
export function emitDriverLocation(payload: DriverLocationEvent): void {
  const io = getIo();
  if (!io) return;
  io.to(orderRoom(payload.orderId)).emit("driver:location", payload);
}
