import {
  ActorType,
  OrderStatus,
  type AdminDriver,
  type BlockBody,
  type Role,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { invalidateDriverVerifiedCache, invalidateUserCache } from "../../plugins/auth";

/**
 * Admin fleet management (BLUEPRINT §7.2 — role ADMIN). Driver verify/block plus
 * the fleet roster. Every mutation is one $transaction with a conditional
 * updateMany guard and an AuditLog row; the auth caches are busted AFTER commit
 * so the next request sees the new verification/block state.
 */

/** The admin performing a sensitive action — `userId` is the AuditLog actor. */
export interface AdminActor {
  userId: string;
  role: Role;
}

/** Per-driver aggregates the roster reports alongside the profile/user row. */
interface DriverCounts {
  totalDeliveries: number;
  cancelCount: number;
}

/** Profile row shape shared by the list + single-driver loaders. */
type DriverRow = {
  id: string;
  userId: string;
  vehicleType: string;
  vehicleNo: string | null;
  licenseNo: string | null;
  isVerified: boolean;
  isOnline: boolean;
  lastLat: number | null;
  lastLng: number | null;
  lastSeenAt: Date | null;
  user: { name: string | null; phone: string; isBlocked: boolean };
  wallet: { balancePaise: number } | null;
};

const DRIVER_SELECT = {
  id: true,
  userId: true,
  vehicleType: true,
  vehicleNo: true,
  licenseNo: true,
  isVerified: true,
  isOnline: true,
  lastLat: true,
  lastLng: true,
  lastSeenAt: true,
  user: { select: { name: true, phone: true, isBlocked: true } },
  wallet: { select: { balancePaise: true } },
} as const;

function shapeDriver(row: DriverRow, counts: DriverCounts): AdminDriver {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    phone: row.user.phone,
    vehicleType: row.vehicleType,
    vehicleNo: row.vehicleNo,
    licenseNo: row.licenseNo,
    isVerified: row.isVerified,
    isOnline: row.isOnline,
    isBlocked: row.user.isBlocked,
    // Fleet map shows last-known only (§ scope: live map is Phase 5); both
    // coordinates must be present for a point.
    lastLocation:
      row.lastLat !== null && row.lastLng !== null
        ? { lat: row.lastLat, lng: row.lastLng }
        : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    walletBalancePaise: row.wallet?.balancePaise ?? 0,
    totalDeliveries: counts.totalDeliveries,
    cancelCount: counts.cancelCount,
  };
}

/** Load one shaped driver by DriverProfile id (post-mutation response). */
async function loadAdminDriver(id: string): Promise<AdminDriver> {
  const prisma = getPrisma();
  const row = await prisma.driverProfile.findUnique({ where: { id }, select: DRIVER_SELECT });
  if (!row) throw new AppError("NOT_FOUND", "Driver not found", 404);

  const totalDeliveries = await prisma.delivery.count({
    where: { driverId: id, deliveredAt: { not: null } },
  });
  // Driver-initiated cancels are OrderEvents this driver (its User id) authored
  // into CANCELLED — repeated cancels are a §9.5 fraud signal.
  const cancelCount = await prisma.orderEvent.count({
    where: { actorType: ActorType.DRIVER, to: OrderStatus.CANCELLED, actorId: row.userId },
  });
  return shapeDriver(row, { totalDeliveries, cancelCount });
}

/**
 * GET /v1/admin/drivers — the whole fleet (single-store fleets are small, so no
 * pagination). Delivered-count + driver-cancel-count are aggregated in bulk.
 */
export async function listDrivers(): Promise<AdminDriver[]> {
  const prisma = getPrisma();
  const rows = await prisma.driverProfile.findMany({
    orderBy: { user: { createdAt: "desc" } },
    select: DRIVER_SELECT,
  });
  if (rows.length === 0) return [];

  const driverIds = rows.map((row) => row.id);
  const userIds = rows.map((row) => row.userId);

  const deliveredGroups = await prisma.delivery.groupBy({
    by: ["driverId"],
    where: { driverId: { in: driverIds }, deliveredAt: { not: null } },
    _count: { _all: true },
  });
  const deliveredByDriver = new Map(
    deliveredGroups.map((group) => [group.driverId, group._count._all]),
  );

  const cancelGroups = await prisma.orderEvent.groupBy({
    by: ["actorId"],
    where: { actorType: ActorType.DRIVER, to: OrderStatus.CANCELLED, actorId: { in: userIds } },
    _count: { _all: true },
  });
  const cancelByUser = new Map<string, number>();
  for (const group of cancelGroups) {
    if (group.actorId !== null) cancelByUser.set(group.actorId, group._count._all);
  }

  return rows.map((row) =>
    shapeDriver(row, {
      totalDeliveries: deliveredByDriver.get(row.id) ?? 0,
      cancelCount: cancelByUser.get(row.userId) ?? 0,
    }),
  );
}

/** POST /v1/admin/drivers/:id/verify — flip DriverProfile.isVerified true (§8.2). */
export async function verifyDriver(id: string, actor: AdminActor): Promise<AdminDriver> {
  const prisma = getPrisma();
  let userId = "";

  await prisma.$transaction(async (tx) => {
    const driver = await tx.driverProfile.findUnique({ where: { id }, select: { userId: true } });
    if (!driver) throw new AppError("NOT_FOUND", "Driver not found", 404);
    userId = driver.userId;

    const updated = await tx.driverProfile.updateMany({
      where: { id },
      data: { isVerified: true },
    });
    if (updated.count !== 1) throw new AppError("NOT_FOUND", "Driver not found", 404);

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "DRIVER_VERIFIED",
        entity: "DriverProfile",
        entityId: id,
        meta: { userId },
      },
    });
  });

  // The auth plugin caches driver verification by userId (60s TTL).
  invalidateDriverVerifiedCache(userId);
  return loadAdminDriver(id);
}

/**
 * POST /v1/admin/drivers/:id/block — set the driver's User.isBlocked. Blocking
 * also invalidates the verification cache so an in-flight driver session is
 * rejected at the next auth hook (§8.4).
 */
export async function blockDriver(
  id: string,
  body: BlockBody,
  actor: AdminActor,
): Promise<AdminDriver> {
  const prisma = getPrisma();
  let userId = "";
  let firebaseUid = "";

  await prisma.$transaction(async (tx) => {
    const driver = await tx.driverProfile.findUnique({
      where: { id },
      select: { userId: true, user: { select: { firebaseUid: true } } },
    });
    if (!driver) throw new AppError("NOT_FOUND", "Driver not found", 404);
    userId = driver.userId;
    firebaseUid = driver.user.firebaseUid;

    const updated = await tx.user.updateMany({
      where: { id: userId },
      data: { isBlocked: body.blocked },
    });
    if (updated.count !== 1) throw new AppError("NOT_FOUND", "Driver not found", 404);

    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        action: body.blocked ? "DRIVER_BLOCKED" : "DRIVER_UNBLOCKED",
        entity: "User",
        entityId: userId,
        meta: { driverId: id, blocked: body.blocked, reason: body.reason ?? null },
      },
    });
  });

  invalidateUserCache(firebaseUid);
  invalidateDriverVerifiedCache(userId);
  return loadAdminDriver(id);
}
