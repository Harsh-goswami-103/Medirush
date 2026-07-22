import { Prisma } from "@prisma/client";
import {
  Role,
  type DeleteAccountBody,
  type NotificationPreferences,
  type UpdateNotificationPrefsBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { emitOpsAlert } from "../../core/realtime";
import { anonymizeUserAccount, isAlreadyAnonymized } from "../admin/userService";

/**
 * Notification consent + self-service erasure (Batch 3).
 *
 * Every read/write is keyed on the caller's own `userId` (a 1:1 row), so cross-
 * user access is structurally impossible. The preference row is created lazily
 * on first read with all-true defaults; until it exists, `notifyUser` treats the
 * user as fully opted in (modules/notifications/service.ts).
 */

interface PreferenceRow {
  orderUpdates: boolean;
  promotions: boolean;
  refillReminders: boolean;
  updatedAt: Date;
}

const PREFERENCE_SELECT = {
  orderUpdates: true,
  promotions: true,
  refillReminders: true,
  updatedAt: true,
} as const;

function shape(row: PreferenceRow): NotificationPreferences {
  return {
    orderUpdates: row.orderUpdates,
    promotions: row.promotions,
    refillReminders: row.refillReminders,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** GET /v1/me/notification-prefs — reads the row, creating all-true defaults once. */
export async function getNotificationPrefs(userId: string): Promise<NotificationPreferences> {
  const prisma = getPrisma();
  const existing = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: PREFERENCE_SELECT,
  });
  if (existing) return shape(existing);

  try {
    const created = await prisma.notificationPreference.create({
      data: { userId },
      select: PREFERENCE_SELECT,
    });
    return shape(created);
  } catch (error) {
    // Two concurrent first reads race on the unique userId — the loser re-reads.
    if (!isUniqueViolation(error)) throw error;
    const row = await prisma.notificationPreference.findUniqueOrThrow({
      where: { userId },
      select: PREFERENCE_SELECT,
    });
    return shape(row);
  }
}

/** PATCH /v1/me/notification-prefs — partial update; creates the row if absent. */
export async function updateNotificationPrefs(
  userId: string,
  body: UpdateNotificationPrefsBody,
): Promise<NotificationPreferences> {
  const prisma = getPrisma();
  try {
    const row = await prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...body },
      update: body,
      select: PREFERENCE_SELECT,
    });
    return shape(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const row = await prisma.notificationPreference.update({
      where: { userId },
      data: body,
      select: PREFERENCE_SELECT,
    });
    return shape(row);
  }
}

/**
 * DELETE /v1/me — DPDP-2023 right to erasure, self-service.
 *
 * Delegates to the single shared anonymisation core (admin/userService): PII is
 * scrubbed and the personal satellites purged while orders, invoices, the
 * Schedule-H1 register and the GST record survive their statutory retention.
 * 409s while any order is still in flight. Idempotent: a repeat call on an
 * already-erased account is a silent no-op (in practice unreachable — the
 * tombstoned firebaseUid stops the token at the auth plugin).
 */
export async function deleteOwnAccount(userId: string, body: DeleteAccountBody): Promise<void> {
  try {
    const { deleted } = await anonymizeUserAccount(
      userId,
      { userId, role: Role.CUSTOMER },
      {
        selfService: true,
        auditAction: "USER_SELF_DELETED",
        auditMeta: { source: "SELF_SERVICE", reason: body.reason ?? null },
      },
    );
    emitOpsAlert("GENERIC", "Customer erased their own account (DPDP)", userId, { deleted });
  } catch (error) {
    if (isAlreadyAnonymized(error)) return;
    throw error;
  }
}
