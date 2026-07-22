import type { Prisma } from "@prisma/client";
import {
  OrderStatus,
  Role,
  type AdminUser,
  type AdminUserListQuery,
  type AnonymizeUserResult,
  type BlockBody,
  type RiskFlag,
  type SetUserRoleBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { isFirebaseConfigured } from "../../core/firebase";
import { logger } from "../../core/logger";
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

/* ---------------------------------------------------- DPDP erasure (§ DPDP) */

/**
 * Tombstone prefix for scrubbed unique columns. `anon:<userId>` is
 * non-allocatable — not E.164 (colons never appear in phones) and never a real
 * Firebase uid on this platform — so unique constraints hold, the value can be
 * recognized forever, and the person's real phone/uid are freed to re-register
 * as a fresh account.
 */
const ANON_PREFIX = "anon:";

/** `details.reason` on the repeat-call 409 — callers may treat it as a no-op. */
export const ALREADY_ANONYMIZED = "ALREADY_ANONYMIZED";

/** True for the 409 raised when the subject was already erased by an earlier call. */
export function isAlreadyAnonymized(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.statusCode === 409 &&
    (error.details as { reason?: string } | undefined)?.reason === ALREADY_ANONYMIZED
  );
}

export interface AnonymizeOptions {
  /**
   * Self-service erasure (DELETE /v1/me): the actor IS the subject, so the
   * admin "not your own account" lockout guard is inverted.
   */
  selfService?: boolean;
  /** AuditLog action; defaults to the admin-initiated `USER_ANONYMIZED`. */
  auditAction?: string;
  /** Extra audit meta merged into the row. MUST NOT carry pre-scrub PII. */
  auditMeta?: Record<string, unknown>;
}

/**
 * Revoke the identity provider's refresh tokens so already-issued tokens die
 * immediately. External call — MUST run outside the transaction; a no-op when
 * Firebase is unconfigured (dev/test).
 */
async function revokeFirebaseSessions(firebaseUid: string): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const { getAuth } = await import("firebase-admin/auth");
  await getAuth().revokeRefreshTokens(firebaseUid);
}

/**
 * DPDP erasure honoring statutory retention (docs/runbooks/data-erasure.md).
 * Shared by POST /v1/admin/users/:id/anonymize and the self-service
 * DELETE /v1/me — one implementation so the two can never diverge.
 *
 * One transaction: scrub User PII (name → "Deleted user", email → null,
 * phone/firebaseUid → `anon:<userId>`, referralCode → null), delete the
 * non-statutory personal satellites (addresses, device push tokens,
 * cart(+items), notifications, stock alerts, wishlist, refill reminders,
 * notification preferences, dependent patient profiles), null out free-text
 * rating comments, set isBlocked=true
 * (block semantics — live sessions die at the auth plugin), write the AuditLog
 * row with counts. Sessions are then revoked at the identity provider.
 *
 * KEPT (statutory pharmacy/tax retention — never touched here): orders, order
 * items, payments, invoices, prescriptions + stored images, return requests,
 * wallet/payout records, audit logs.
 *
 * Guards: 404 unknown id · 409 self (admin path only) · 409 last active admin ·
 * 409 DRIVER role (wallet/payout obligations — offboarding is a separate flow) ·
 * 409 any order in a non-terminal state (in-flight fulfillment needs contact
 * info) · repeat call → 409 CONFLICT with `details.reason = "ALREADY_ANONYMIZED"`
 * (the first call did all the work; the tombstoned firebaseUid marks it).
 */
export async function anonymizeUserAccount(
  id: string,
  actor: AdminActor,
  options: AnonymizeOptions = {},
): Promise<AnonymizeUserResult> {
  const prisma = getPrisma();

  // Lockout guard (mirrors blockUser): an admin cannot erase their own account.
  if (!options.selfService && id === actor.userId) {
    throw new AppError("CONFLICT", "You cannot anonymize your own account", 409);
  }

  let firebaseUid = "";
  let deleted = { addresses: 0, deviceTokens: 0, cartItems: 0, notifications: 0 };
  let purged = { stockAlerts: 0, wishlist: 0, refillReminders: 0, patients: 0, ratingComments: 0 };

  await prisma.$transaction(async (tx) => {
    // Lock ordering (AB-BA deadlock guard): the order-create tx locks the User
    // row FIRST (orders/service.ts assertFraudGatesInTx) and then deletes the
    // user's CartItems in-tx. Taking the SAME lock first here keeps both
    // transactions in the same User→CartItem order — without it, the satellite
    // deletes below vs a concurrent checkout were a classic AB-BA deadlock.
    // Row lock held until commit/rollback; blocks competing txns.
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${id} FOR UPDATE`;

    const user = await tx.user.findUnique({
      where: { id },
      select: { firebaseUid: true, role: true },
    });
    if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
    firebaseUid = user.firebaseUid;

    // Repeat-call semantics: the tombstoned firebaseUid is the durable marker.
    if (user.firebaseUid.startsWith(ANON_PREFIX)) {
      throw new AppError("CONFLICT", "User is already anonymized", 409, {
        reason: ALREADY_ANONYMIZED,
      });
    }

    // Scope: customer erasure. Drivers carry wallet/payout/ledger obligations
    // that must be settled first — driver offboarding is a separate flow.
    if (user.role === Role.DRIVER) {
      throw new AppError(
        "CONFLICT",
        "Driver accounts cannot be anonymized — settle wallet/payout obligations and offboard first",
        409,
      );
    }

    // Lockout guard (mirrors blockUser): the panel must stay operable.
    if (user.role === Role.ADMIN) {
      const otherAdmins = await tx.user.count({
        where: { role: Role.ADMIN, isBlocked: false, id: { not: id } },
      });
      if (otherAdmins === 0) {
        throw new AppError("CONFLICT", "Cannot anonymize the last active admin", 409);
      }
    }

    // In-flight fulfillment (anything not DELIVERED/CANCELLED) still needs the
    // contact info — refuse until every order reaches a terminal state.
    const inFlight = await tx.order.count({
      where: { userId: id, status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } },
    });
    if (inFlight > 0) {
      throw new AppError(
        "CONFLICT",
        `User has ${inFlight} order(s) in a non-terminal state — cancel or complete them first`,
        409,
      );
    }

    // Hard-delete the non-statutory PII satellites. CartItem before Cart so the
    // count is observable (Cart→CartItem is onDelete: Cascade anyway).
    const addresses = await tx.address.deleteMany({ where: { userId: id } });
    const deviceTokens = await tx.deviceToken.deleteMany({ where: { userId: id } });
    const cartItems = await tx.cartItem.deleteMany({ where: { cart: { userId: id } } });
    await tx.cart.deleteMany({ where: { userId: id } });
    const notifications = await tx.notification.deleteMany({ where: { userId: id } });
    deleted = {
      addresses: addresses.count,
      deviceTokens: deviceTokens.count,
      cartItems: cartItems.count,
      notifications: notifications.count,
    };

    // Batch-3 personal satellites — behavioural data and dependent-profile PII,
    // none of it statutory. Patient rows carry names/DOB: the Schedule-H1 record
    // lives on Prescription.patientName (kept), and Order/Prescription.patientId
    // are ON DELETE SET NULL, so removing the profile leaves the register intact.
    const stockAlerts = await tx.stockAlert.deleteMany({ where: { userId: id } });
    const wishlist = await tx.wishlist.deleteMany({ where: { userId: id } });
    const refillReminders = await tx.refillReminder.deleteMany({ where: { userId: id } });
    await tx.notificationPreference.deleteMany({ where: { userId: id } });
    const patients = await tx.patient.deleteMany({ where: { userId: id } });
    // Stars stay (driver/service aggregates); the free-text comment may name people.
    const ratingComments = await tx.rating.updateMany({
      where: { userId: id, comment: { not: null } },
      data: { comment: null },
    });
    purged = {
      stockAlerts: stockAlerts.count,
      wishlist: wishlist.count,
      refillReminders: refillReminders.count,
      patients: patients.count,
      ratingComments: ratingComments.count,
    };

    await tx.user.update({
      where: { id },
      data: {
        name: "Deleted user",
        email: null,
        phone: `${ANON_PREFIX}${id}`,
        firebaseUid: `${ANON_PREFIX}${id}`,
        // Retire the shareable code: an erased account must stop attracting new
        // Referral/Coupon/Notification rows (referrals also reject blocked users).
        referralCode: null,
        isBlocked: true,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: options.auditAction ?? "USER_ANONYMIZED",
        entity: "User",
        entityId: id,
        // Counts + prior role only — no pre-scrub PII may survive in the trail.
        meta: { role: user.role, deleted, purged, ...(options.auditMeta ?? {}) },
      },
    });
  });

  // Bust the PRE-scrub uid so live sessions die now, not after the 60s TTL.
  invalidateUserCache(firebaseUid);
  // External, post-commit: a provider outage must not undo a committed erasure.
  try {
    await revokeFirebaseSessions(firebaseUid);
  } catch (error) {
    logger.error({ err: error, userId: id }, "anonymize: revoking sessions failed");
  }
  return { user: await loadAdminUser(id), deleted };
}

/** POST /v1/admin/users/:id/anonymize — admin-initiated DPDP erasure. */
export async function anonymizeUser(id: string, actor: AdminActor): Promise<AnonymizeUserResult> {
  return anonymizeUserAccount(id, actor);
}
