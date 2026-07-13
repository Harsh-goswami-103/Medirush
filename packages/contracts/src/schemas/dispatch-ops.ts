/**
 * Ops dispatch-recovery endpoints (Phase 7 hardening — role INVENTORY or ADMIN).
 *
 * | Endpoint                              | Body                 | Response data          |
 * |---------------------------------------|----------------------|------------------------|
 * | POST /v1/ops/orders/:id/assign        | OpsAssignBodySchema  | DispatchAssignmentSchema |
 * | POST /v1/ops/orders/:id/redispatch    | —                    | RedispatchResultSchema |
 * | POST /v1/ops/orders/:id/unassign      | OpsUnassignBodySchema (optional) | UnassignResultSchema |
 *
 * These are the manual escape hatches for a dispatch dead-end (§9.5): once both
 * offer waves expire nothing re-offers automatically, so ops can directly assign
 * a driver, restart the offer waves (re-dispatch), or undo a pre-pickup
 * assignment (un-assign, optionally re-dispatching in the same call).
 */
import { z } from "zod";
import { OrderStatusSchema } from "../enums";
import { CountSchema, IdSchema, IsoDateTimeSchema, envelope } from "./common";

/* ------------------------------------------------------------ manual assign */

/** POST /v1/ops/orders/:id/assign — pick the driver to assign. */
export const OpsAssignBodySchema = z.object({
  driverId: IdSchema,
});
export type OpsAssignBody = z.infer<typeof OpsAssignBodySchema>;

/** The assignment that was just created (READY → ASSIGNED). */
export const DispatchAssignmentSchema = z.object({
  orderId: IdSchema,
  /** Always ASSIGNED on success. */
  status: OrderStatusSchema,
  deliveryId: IdSchema,
  driverId: IdSchema,
  acceptedAt: IsoDateTimeSchema,
});
export type DispatchAssignment = z.infer<typeof DispatchAssignmentSchema>;
export const OpsAssignResponseSchema = envelope(DispatchAssignmentSchema);

/* -------------------------------------------------------------- re-dispatch */

/** POST /v1/ops/orders/:id/redispatch — no body; the order must be READY. */
export const RedispatchResultSchema = z.object({
  orderId: IdSchema,
  /** Always READY on success — the order is back in the offer loop. */
  status: OrderStatusSchema,
  /** Stale EXPIRED/REJECTED offer rows deleted so the fleet can be re-offered. */
  clearedOffers: CountSchema,
  /** Fresh wave-1 offers created (0 when no driver is currently available). */
  offersCreated: CountSchema,
});
export type RedispatchResult = z.infer<typeof RedispatchResultSchema>;
export const OpsRedispatchResponseSchema = envelope(RedispatchResultSchema);

/* ---------------------------------------------------------------- un-assign */

/** POST /v1/ops/orders/:id/unassign — body is optional; flags default to false. */
export const OpsUnassignBodySchema = z.object({
  /** When true, immediately re-run dispatch after the un-assign commits. */
  redispatch: z.boolean().optional(),
});
export type OpsUnassignBody = z.infer<typeof OpsUnassignBodySchema>;

export const UnassignResultSchema = z.object({
  orderId: IdSchema,
  /** Always READY on success — the ASSIGNED → READY un-assign edge (§9.1). */
  status: OrderStatusSchema,
  /** The driver the order was taken away from. */
  driverId: IdSchema,
  /** Whether a re-dispatch wave was run as part of this call. */
  redispatched: z.boolean(),
  /** Stale offer rows cleared before re-dispatching (0 when not re-dispatching). */
  clearedOffers: CountSchema,
  /** Fresh offers created by the re-dispatch (0 when not re-dispatching). */
  offersCreated: CountSchema,
});
export type UnassignResult = z.infer<typeof UnassignResultSchema>;
export const OpsUnassignResponseSchema = envelope(UnassignResultSchema);
