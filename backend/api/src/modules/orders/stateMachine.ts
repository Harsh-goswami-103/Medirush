import {
  ActorType,
  OrderStatus,
  isValidOrderTransition,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";

/**
 * Order state machine (BLUEPRINT §9.1) — the single enforcement point for
 * status mutations. The *shape* of the graph (from → to[]) is owned by
 * `@medrush/contracts` (ORDER_STATUS_TRANSITIONS); this module layers the
 * actor rules on top: who may cancel / pack / assign / pick up / deliver.
 *
 * Every mutation calls `assertTransition(from, to, actorType)` inside its TX;
 * the OrderEvent is written in the same code path and the socket emit happens
 * AFTER the TX commits (§9.1).
 */

/**
 * Which actors may drive each edge of the §9.1 graph (+ §18.3 cancel matrix):
 * - SYSTEM: payment webhook / timeout jobs / dispatch automation.
 * - CUSTOMER may cancel only PENDING_PAYMENT / PLACED / RX_REVIEW (one-tap);
 *   PACKING/READY becomes a request (handled OUTSIDE the state machine —
 *   status does not change), ASSIGNED+ is rejected.
 * - OPS/ADMIN: pack, ready, manual assign, and cancel in any non-terminal
 *   status (driver returns items for ASSIGNED/PICKED_UP).
 * - DRIVER: accept (READY→ASSIGNED), un-assign (ASSIGNED→READY re-dispatch),
 *   picked-up and deliver — never cancel an order outright.
 */
export const TRANSITION_ACTORS: Readonly<
  Record<OrderStatus, Readonly<Partial<Record<OrderStatus, readonly ActorType[]>>>>
> = {
  [OrderStatus.PENDING_PAYMENT]: {
    [OrderStatus.PLACED]: [ActorType.SYSTEM],
    [OrderStatus.RX_REVIEW]: [ActorType.SYSTEM],
    [OrderStatus.CANCELLED]: [ActorType.SYSTEM, ActorType.CUSTOMER, ActorType.OPS, ActorType.ADMIN],
  },
  [OrderStatus.PLACED]: {
    [OrderStatus.RX_REVIEW]: [ActorType.SYSTEM, ActorType.OPS, ActorType.ADMIN],
    [OrderStatus.PACKING]: [ActorType.OPS, ActorType.ADMIN],
    [OrderStatus.CANCELLED]: [ActorType.CUSTOMER, ActorType.OPS, ActorType.ADMIN, ActorType.SYSTEM],
  },
  [OrderStatus.RX_REVIEW]: {
    // Start-packing on RX_REVIEW additionally requires rxStatus=APPROVED
    // (enforced by the ops service, Phase 1 scope decision #2).
    [OrderStatus.PACKING]: [ActorType.OPS, ActorType.ADMIN],
    [OrderStatus.CANCELLED]: [ActorType.CUSTOMER, ActorType.OPS, ActorType.ADMIN, ActorType.SYSTEM],
  },
  [OrderStatus.PACKING]: {
    [OrderStatus.READY]: [ActorType.OPS, ActorType.ADMIN],
    [OrderStatus.CANCELLED]: [ActorType.OPS, ActorType.ADMIN],
  },
  [OrderStatus.READY]: {
    [OrderStatus.ASSIGNED]: [ActorType.DRIVER, ActorType.SYSTEM, ActorType.OPS, ActorType.ADMIN],
    [OrderStatus.CANCELLED]: [ActorType.OPS, ActorType.ADMIN],
  },
  [OrderStatus.ASSIGNED]: {
    [OrderStatus.PICKED_UP]: [ActorType.DRIVER],
    // Driver-initiated cancel before pickup → back to READY, re-dispatch (§9.5).
    [OrderStatus.READY]: [ActorType.DRIVER, ActorType.SYSTEM, ActorType.OPS, ActorType.ADMIN],
    [OrderStatus.CANCELLED]: [ActorType.OPS, ActorType.ADMIN],
  },
  [OrderStatus.PICKED_UP]: {
    [OrderStatus.DELIVERED]: [ActorType.DRIVER],
    [OrderStatus.CANCELLED]: [ActorType.OPS, ActorType.ADMIN],
  },
  [OrderStatus.DELIVERED]: {},
  [OrderStatus.CANCELLED]: {},
};

/**
 * Throws `AppError("INVALID_TRANSITION", …, 409, { from, to, actor })` when the
 * edge does not exist in the §9.1 graph or the actor may not drive it.
 * Pinned cross-agent signature — do not change (phase-1 brief).
 */
export function assertTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): void {
  if (!isValidOrderTransition(from, to)) {
    throw new AppError(
      "INVALID_TRANSITION",
      `Order cannot move from ${from} to ${to}`,
      409,
      { from, to, actor },
    );
  }
  const allowedActors = TRANSITION_ACTORS[from][to] ?? [];
  if (!allowedActors.includes(actor)) {
    throw new AppError(
      "INVALID_TRANSITION",
      `${actor} may not move an order from ${from} to ${to}`,
      409,
      { from, to, actor },
    );
  }
}
