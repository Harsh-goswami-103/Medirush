import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Role } from "@medrush/contracts";
import { AppError } from "../core/errors";
import { asGlobalPlugin } from "../core/plugin-utils";

/**
 * Auth plugin — Phase 0 STUB.
 * Decorates `request.auth` (always null for now) and honours per-route
 * `config: { public?: boolean; roles?: Role[] }`. Phase 1 swaps in Firebase
 * `verifyIdToken` behind this exact interface — routes never change.
 */

export interface AuthContext {
  uid: string; // firebase uid
  userId: string; // PG User.id
  role: Role;
}

export interface RouteAuthConfig {
  public?: boolean;
  roles?: Role[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
    roles?: Role[];
  }
}

function assertAuthorized(request: FastifyRequest, roles?: Role[]): void {
  if (!request.auth) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  if (roles && roles.length > 0 && !roles.includes(request.auth.role)) {
    throw new AppError("FORBIDDEN", "Insufficient role for this resource", 403);
  }
}

export const authPlugin: FastifyPluginAsync = asGlobalPlugin(async (app) => {
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request) => {
    // No route matched → let the not-found handler answer 404 (not 401).
    if (request.routeOptions.url === undefined) return;

    const routeConfig = request.routeOptions.config as RouteAuthConfig | undefined;
    if (routeConfig?.public) return;

    // Swagger UI routes are registered by @fastify/swagger-ui without our route
    // config. They only exist in non-production (see plugins/swagger.ts), so in
    // production this prefix 404s before reaching here.
    if (request.routeOptions.url.startsWith("/docs")) return;

    // TODO(Phase 1): extract `Authorization: Bearer <idToken>`, call Firebase
    // Admin verifyIdToken, load/mirror the PG user, then:
    //   request.auth = { uid, userId, role };
    // Phase 0 leaves request.auth = null, so every non-public route rejects.
    assertAuthorized(request, routeConfig?.roles);
  });
});

/**
 * Per-route guard helper (stub) — attach as `preHandler` when a route needs
 * a stricter role check than its module default.
 */
export function requireRoles(...roles: Role[]) {
  return async function requireRolesGuard(request: FastifyRequest): Promise<void> {
    // TODO(Phase 1): same Firebase-backed context as the onRequest hook.
    assertAuthorized(request, roles);
  };
}
