import type {
  DriverLocationEvent,
  OfferCancelledEvent,
  OfferNewEvent,
  OrderStatus,
  PaymentMethod,
  RxStatus,
} from "@medrush/contracts";
import { OPS_ROOM, RxStatus as RxStatusValues, driverRoom, orderRoom } from "@medrush/contracts";
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

/** `alert` banner/toast to the ops room (watchdogs, fraud rules, …). */
export function emitOpsAlert(kind: string, msg: string, refId?: string): void {
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

/** `driver:location` to an order's room — live position while ASSIGNED/PICKED_UP. */
export function emitDriverLocation(payload: DriverLocationEvent): void {
  const io = getIo();
  if (!io) return;
  io.to(orderRoom(payload.orderId)).emit("driver:location", payload);
}
