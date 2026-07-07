import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { PhoneSchema, Role } from "@medrush/contracts";
import { getConfig } from "../core/config";
import { getPrisma } from "../core/db";
import { AppError } from "../core/errors";
import { verifyFirebaseToken } from "../core/firebase";
import { asGlobalPlugin } from "../core/plugin-utils";

/**
 * Auth plugin — Phase 1 verification chain (§8, phase-1 brief):
 *
 *   Authorization: Bearer <token>
 *     ├─ FIREBASE_PROJECT_ID configured → firebase-admin verifyIdToken
 *     └─ else, NODE_ENV !== "production" → dev token `dev:<firebaseUid>:<phone>`
 *   Then: PG User lookup by firebaseUid (60s cache):
 *     - no row + route { allowUnsynced } → request.auth = { uid, phone, userId: null, role: null }
 *     - no row otherwise → 401 · isBlocked → 403 · else request.auth = { uid, phone, userId, role }
 *   Role guard: route { roles } → 403 when role not in list.
 *   DRIVER routes additionally require DriverProfile.isVerified (60s cache).
 */

export interface AuthContext {
  /** Firebase uid (or dev-token uid in non-production). */
  uid: string;
  /** E.164 phone verified by the identity provider. */
  phone: string;
  /** PG User.id — null only on `{ allowUnsynced }` routes before the first sync. */
  userId: string | null;
  /** PG role (source of truth, §8.2) — null only when `userId` is null. */
  role: Role | null;
}

export interface RouteAuthConfig {
  public?: boolean;
  roles?: Role[];
  /** Let a verified-but-unsynced identity through (only POST /v1/auth/sync). */
  allowUnsynced?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
    roles?: Role[];
    allowUnsynced?: boolean;
  }
}

/* ------------------------------------------------------------- caches */

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1_000;

interface CachedUser {
  id: string;
  role: Role;
  isBlocked: boolean;
}

const userCache = new Map<string, { user: CachedUser; expiresAt: number }>();
const driverVerifiedCache = new Map<string, { isVerified: boolean; expiresAt: number }>();

function cacheSet<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= CACHE_MAX_ENTRIES) {
    // Maps iterate in insertion order — dropping the first entry is a cheap
    // oldest-first eviction; 60s TTL keeps entries fresh regardless.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Bust the per-uid user cache — call after any mutation of the User row (sync, role/block changes). */
export function invalidateUserCache(firebaseUid: string): void {
  userCache.delete(firebaseUid);
}

/** Bust the driver-verification cache — call after admin verify/block (Phase 3). */
export function invalidateDriverVerifiedCache(userId: string): void {
  driverVerifiedCache.delete(userId);
}

/** Test helper: drop every auth cache (integration suites truncate the DB between cases). */
export function clearAuthCaches(): void {
  userCache.clear();
  driverVerifiedCache.clear();
}

async function getUserByFirebaseUid(firebaseUid: string): Promise<CachedUser | null> {
  const now = Date.now();
  const hit = userCache.get(firebaseUid);
  if (hit && hit.expiresAt > now) return hit.user;
  if (hit) userCache.delete(firebaseUid);

  const row = await getPrisma().user.findUnique({
    where: { firebaseUid },
    select: { id: true, role: true, isBlocked: true },
  });
  // Negative lookups are NOT cached: /auth/sync must observe the new row
  // immediately after the upsert without extra invalidation choreography.
  if (!row) return null;

  const user: CachedUser = { id: row.id, role: row.role, isBlocked: row.isBlocked };
  cacheSet(userCache, firebaseUid, { user, expiresAt: now + CACHE_TTL_MS });
  return user;
}

async function isDriverVerified(userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = driverVerifiedCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.isVerified;

  const profile = await getPrisma().driverProfile.findUnique({
    where: { userId },
    select: { isVerified: true },
  });
  const isVerified = profile?.isVerified ?? false;
  cacheSet(driverVerifiedCache, userId, { isVerified, expiresAt: now + CACHE_TTL_MS });
  return isVerified;
}

/* ------------------------------------------------------- token verify */

const DEV_TOKEN_PREFIX = "dev:";

async function verifyToken(token: string): Promise<{ uid: string; phone: string }> {
  const config = getConfig();

  if (config.FIREBASE_PROJECT_ID !== undefined) {
    return verifyFirebaseToken(token);
  }

  if (!config.isProduction) {
    // DEV TOKEN: `dev:<firebaseUid>:<phone>` — E.164 phones contain no colons.
    if (token.startsWith(DEV_TOKEN_PREFIX)) {
      const [, uid, phone] = token.split(":");
      if (uid && phone && PhoneSchema.safeParse(phone).success) {
        return { uid, phone };
      }
    }
    throw new AppError(
      "UNAUTHENTICATED",
      "Invalid token (expected `dev:<firebaseUid>:<phone>` — Firebase is not configured)",
      401,
    );
  }

  // Unreachable in practice: production boot requires FIREBASE_* (core/config.ts).
  throw new AppError("UNAUTHENTICATED", "Authentication is not configured", 401);
}

/* --------------------------------------------------------------- hook */

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

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) {
      throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const { uid, phone } = await verifyToken(token);

    const user = await getUserByFirebaseUid(uid);
    if (!user) {
      if (routeConfig?.allowUnsynced) {
        request.auth = { uid, phone, userId: null, role: null };
        return;
      }
      throw new AppError("UNAUTHENTICATED", "Account not synced — call POST /v1/auth/sync", 401);
    }

    // Blocked users are rejected regardless of a valid token (§8.4).
    if (user.isBlocked) {
      throw new AppError("FORBIDDEN", "Account is blocked", 403);
    }

    request.auth = { uid, phone, userId: user.id, role: user.role };

    const roles = routeConfig?.roles;
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw new AppError("FORBIDDEN", "Insufficient role for this resource", 403);
    }

    // Driver routes additionally require a verified driver profile (§8.2).
    if (user.role === Role.DRIVER && roles?.includes(Role.DRIVER)) {
      if (!(await isDriverVerified(user.id))) {
        throw new AppError("FORBIDDEN", "Driver account is not verified", 403);
      }
    }
  });
});

/* ------------------------------------------------------------ helpers */

/**
 * Narrow `request.auth` to a synced user — for handlers on routes without
 * `allowUnsynced`, where userId/role are guaranteed by the onRequest hook.
 */
export function requireSyncedAuth(request: FastifyRequest): {
  uid: string;
  phone: string;
  userId: string;
  role: Role;
} {
  const auth = request.auth;
  if (!auth || auth.userId === null || auth.role === null) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return { uid: auth.uid, phone: auth.phone, userId: auth.userId, role: auth.role };
}

/**
 * Per-route guard helper — attach as `preHandler` when a route needs a
 * stricter role check than its module default.
 */
export function requireRoles(...roles: Role[]) {
  return async function requireRolesGuard(request: FastifyRequest): Promise<void> {
    const auth = requireSyncedAuth(request);
    if (roles.length > 0 && !roles.includes(auth.role)) {
      throw new AppError("FORBIDDEN", "Insufficient role for this resource", 403);
    }
  };
}
