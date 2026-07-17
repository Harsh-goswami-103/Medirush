/**
 * @medrush/contracts — single source of truth for the MedRush platform.
 *
 * Consumed by `backend/api` (Fastify + fastify-type-provider-zod) and all three
 * clients (customer PWA, driver app, ops/admin panel). Apps import ONLY from
 * this root barrel.
 *
 * Layout:
 * - enums:          Prisma enum mirrors (+ string-column enums)
 * - errors:         ErrorCode list, error envelope, default HTTP status map
 * - domain:         §9/§10.3/§18.3 constants, state-machine + cancellation tables
 * - schemas/common: scalars, pagination, envelope helpers
 * - schemas/*:      request/response schemas per §7.2 endpoint group
 * - socket-events:  §7.3 socket contract (rooms, payloads, socket.io generics)
 */
export * from "./enums";
export * from "./errors";
export * from "./domain";
export * from "./schemas/common";
export * from "./schemas/auth";
export * from "./schemas/catalog";
export * from "./schemas/coupons";
export * from "./schemas/cart";
export * from "./schemas/order";
export * from "./schemas/notification";
export * from "./schemas/driver";
export * from "./schemas/wallet";
export * from "./schemas/inventory";
export * from "./schemas/admin";
export * from "./schemas/alerts";
export * from "./schemas/dispatch-ops";
export * from "./socket-events";
