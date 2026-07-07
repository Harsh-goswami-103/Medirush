import type { Prisma } from "@prisma/client";
import {
  Role,
  type AdminUser,
  type AdminUserListQuery,
  type BlockBody,
  type RiskFlag,
  type SetUserRoleBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { isFirebaseConfigured } from "../../core/firebase";
import { invalidateUserCache } from "../../plugins/auth";
import type { AdminActor } from "./driverService";

/**
 * Admin user management (BLUEPRINT §7.2 — role ADMIN; §8.2 set-role, §8.4 block).
 * List/search/filter users, block, and change PG role. Every mutation is one
 * $transaction with a conditional updateMany guard + AuditLog; the auth cache is
 * busted AFTER commit so the change takes effect on the next request.
 */

const USER_SELECT = {
  id: true,
  phone: true,
  name: true,
  email: true,
  role: true,
  isBlocked: true,
  codRefusalCount: true,
  riskFlag: true,
  createdAt: true,
} as const;

type UserRow = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  role: Role;
  isBlocked: boolean;
  codRefusalCount: number;
  riskFlag: string;
  createdAt: Date;
};

function shapeUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    role: row.role,
    isBlocked: row.isBlocked,
    codRefusalCount: row.codRefusalCount,
    // riskFlag is a free-form String column constrained to the §6.2 value set.
    riskFlag: row.riskFlag as RiskFlag,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Load one shaped user by id (post-mutation response). */
async function loadAdminUser(id: string): Promise<AdminUser> {
  const row = await getPrisma().user.findUnique({ where: { id }, select: USER_SELECT });
  if (!row) throw new AppError("NOT_FOUND", "User not found", 404);
  return shapeUser(row);
}

/**
 * Push the new role into Firebase custom claims + revoke refresh tokens so the
 * change propagates to the client on its next token refresh (§8.2). Real only
 * when Firebase is configured; a no-op in dev/test (mirrors core/firebase.ts).
 * MUST be called OUTSIDE the DB transaction — it is an external call.
 */
async function syncFirebaseRole(firebaseUid: string, role: Role): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth();
  await auth.setCustomUserClaims(firebaseUid, { role });
  await auth.revokeRefreshTokens(firebaseUid);
}

/**
 * GET /v1/admin/users — cursor-paginated, newest first. `search` matches phone
 * or (case-insensitive) name; `role`/`blocked` narrow the set.
 */
export async function listUsers(
  query: AdminUserListQuery,
): Promise<{ users: AdminUser[]; nextCursor: string | null }> {
  const prisma = getPrisma();
  const where: Prisma.UserWhereInput = {
    ...(query.role ? { role: query.role } : {}),
    ...(query.blocked !== undefined ? { isBlocked: query.blocked } : {}),
    ...(query.search
      ? {
          OR: [
            { phone: { contains: query.search } },
            { name: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: USER_SELECT,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    users: page.map(shapeUser),
    nextCursor: hasMore && last ? last.id : null,
  };
}

/** POST /v1/admin/users/:id/block — set User.isBlocked (§8.4). */
export async function blockUser(id: string, body: BlockBody, actor: AdminActor): Promise<AdminUser> {
  const prisma = getPrisma();
  let firebaseUid = "";

  // Lockout guard (§23 DoD — the panel must stay operable): an admin can't block
  // their own account, and the last active admin can't be blocked. Otherwise the
  // auth hook 403s every subsequent request and only a DB edit restores access.
  if (body.blocked && id === actor.userId) {
    throw new AppError("CONFLICT", "You cannot block your own account", 409);
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id },
      select: { firebaseUid: true, role: true },
    });
    if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
    firebaseUid = user.firebaseUid;

    if (body.blocked && user.role === Role.ADMIN) {
      const otherAdmins = await tx.user.count({
        where: { role: Role.ADMIN, isBlocked: false, id: { not: id } },
      });
      if (otherAdmins === 0) {
        throw new AppError("CONFLICT", "Cannot block the last active admin", 409);
      }
    }

    const updated = await tx.user.updateMany({
      where: { id },
      data: { isBlocked: body.blocked },
    });
    if (updated.count !== 1) throw new AppError("NOT_FOUND", "User not found", 404);

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: body.blocked ? "USER_BLOCKED" : "USER_UNBLOCKED",
        entity: "User",
        entityId: id,
        meta: { blocked: body.blocked, reason: body.reason ?? null },
      },
    });
  });

  invalidateUserCache(firebaseUid);
  return loadAdminUser(id);
}

/**
 * POST /v1/admin/users/:id/role — set the PG role (source of truth, §8.2), then
 * mirror it to Firebase + revoke tokens OUTSIDE the tx.
 */
export async function setUserRole(
  id: string,
  body: SetUserRoleBody,
  actor: AdminActor,
): Promise<AdminUser> {
  const prisma = getPrisma();
  let firebaseUid = "";

  // Lockout guard: an admin can't demote themselves, and the last active admin
  // can't be demoted — either would 403 the panel with no in-app recovery.
  if (id === actor.userId && body.role !== Role.ADMIN) {
    throw new AppError("CONFLICT", "You cannot change your own admin role", 409);
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id },
      select: { firebaseUid: true, role: true },
    });
    if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
    firebaseUid = user.firebaseUid;

    if (user.role === Role.ADMIN && body.role !== Role.ADMIN) {
      const otherAdmins = await tx.user.count({
        where: { role: Role.ADMIN, isBlocked: false, id: { not: id } },
      });
      if (otherAdmins === 0) {
        throw new AppError("CONFLICT", "Cannot remove the last active admin", 409);
      }
    }

    const updated = await tx.user.updateMany({
      where: { id },
      data: { role: body.role },
    });
    if (updated.count !== 1) throw new AppError("NOT_FOUND", "User not found", 404);

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "USER_ROLE_CHANGED",
        entity: "User",
        entityId: id,
        // `user.role` was read before the update ⇒ the previous role.
        meta: { from: user.role, to: body.role },
      },
    });
  });

  // PG cache first (immediate effect on this API), then the external identity
  // provider (no-op locally). Order matters: PG is the source of truth.
  invalidateUserCache(firebaseUid);
  await syncFirebaseRole(firebaseUid, body.role);
  return loadAdminUser(id);
}
