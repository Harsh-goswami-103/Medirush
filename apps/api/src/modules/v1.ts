import type { FastifyPluginAsync } from "fastify";

/**
 * /v1 module root — registered with `{ prefix: "/v1" }` in app.ts.
 * Empty in Phase 0; bounded-context modules mount here in Phase 1+, e.g.:
 *
 *   await app.register(authRoutes);                     // POST /v1/auth/sync
 *   await app.register(catalogRoutes);                  // GET  /v1/products…
 *   await app.register(orderRoutes,  { prefix: "/orders" });
 *   await app.register(driverRoutes, { prefix: "/driver" });
 */
export const v1Routes: FastifyPluginAsync = async (app) => {
  app.log.debug("v1 module root registered (Phase 1+ modules mount here)");
};
