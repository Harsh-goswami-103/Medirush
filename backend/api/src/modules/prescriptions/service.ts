import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  AlertKind,
  OrderStatus,
  RxStatus,
  type LockerPrescription,
  type UpdateRxBody,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { emitOpsAlert } from "../../core/realtime";
import { validateAndNormalizeUpload } from "../../core/rxProcessing";
import { presignPrivateGet, putPrivateObject } from "../../core/storage";

/**
 * Prescription locker (Batch 3). A Prescription belongs to the CUSTOMER and may
 * be re-used across orders, so `orderId` is nullable — null means it sits in the
 * locker. Every query below is scoped by `userId` in the WHERE clause, so a
 * foreign id is indistinguishable from a missing one (§8.3).
 *
 * Once a prescription is attached to an order ops has reviewed (or is reviewing)
 * it — the row becomes immutable to the customer.
 */

/** Presigned locker GETs are short-lived: the URL is PHI and gets shared/logged. */
export const RX_FILE_URL_TTL_SEC = 300;

const lockerSelect = {
  id: true,
  label: true,
  status: true,
  mimeType: true,
  orderId: true,
  patientId: true,
  patientName: true,
  doctorName: true,
  reviewNote: true,
  createdAt: true,
  reviewedAt: true,
  order: { select: { orderNo: true } },
  patient: { select: { name: true } },
} satisfies Prisma.PrescriptionSelect;

type LockerRow = Prisma.PrescriptionGetPayload<{ select: typeof lockerSelect }>;

function toLocker(row: LockerRow): LockerPrescription {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    mimeType: row.mimeType,
    orderId: row.orderId,
    orderNo: row.order?.orderNo ?? null,
    patientId: row.patientId,
    // The linked dependent wins; the scalar is what ops captured at review time.
    patientName: row.patient?.name ?? row.patientName,
    doctorName: row.doctorName,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  };
}

function notFound(): never {
  throw new AppError("NOT_FOUND", "Prescription not found", 404);
}

function attachedConflict(): never {
  throw new AppError(
    "CONFLICT",
    "This prescription is attached to an order and can no longer be changed",
    409,
  );
}

/** A patientId from the client must resolve to a dependent the caller owns. */
async function assertOwnedPatient(userId: string, patientId: string): Promise<void> {
  const patient = await getPrisma().patient.findFirst({
    where: { id: patientId, userId },
    select: { id: true },
  });
  if (!patient) {
    throw new AppError("NOT_FOUND", "Patient not found", 404);
  }
}

/* ------------------------------------------------------------------ list */

export interface ListLockerQuery {
  cursor?: string;
  limit: number;
  unattached: boolean;
}

/** Cursor-paginated, newest-first list of the caller's own prescriptions. */
export async function listLockerPrescriptions(
  userId: string,
  q: ListLockerQuery,
): Promise<{ items: LockerPrescription[]; nextCursor: string | null }> {
  const rows = await getPrisma().prescription.findMany({
    where: { userId, ...(q.unattached ? { orderId: null } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: lockerSelect,
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];

  return { items: page.map(toLocker), nextCursor: hasMore && last ? last.id : null };
}

/* ---------------------------------------------------------------- upload */

export interface LockerUploadInput {
  buffer: Buffer;
  mimetype: string;
  label?: string;
  patientId?: string | null;
  doctorName?: string;
}

/**
 * Standalone upload — no order. Same magic-byte validation, size ceiling, MIME
 * allowlist and EXIF-stripping re-encode as the order-scoped upload, stored
 * under a SERVER-generated key (no path-traversal surface, §13).
 */
export async function createLockerPrescription(
  userId: string,
  input: LockerUploadInput,
): Promise<LockerPrescription> {
  if (input.patientId) {
    await assertOwnedPatient(userId, input.patientId);
  }

  const normalized = await validateAndNormalizeUpload(input.buffer, input.mimetype);

  const key = `rx/locker/${userId}/${randomUUID().replace(/-/g, "")}.${normalized.ext}`;
  // External I/O — no DB tx is open here (§14).
  await putPrivateObject(key, normalized.body, normalized.contentType);

  const row = await getPrisma().prescription.create({
    data: {
      userId,
      fileKey: key,
      mimeType: normalized.contentType,
      status: RxStatus.PENDING,
      label: input.label ?? null,
      patientId: input.patientId ?? null,
      doctorName: input.doctorName ?? null,
    },
    select: lockerSelect,
  });

  // Nothing else surfaces a locker upload to ops — there is no order to page on.
  emitOpsAlert(
    AlertKind.GENERIC,
    "Customer uploaded a prescription to their locker (not attached to an order)",
    row.id,
    { userId },
  );

  return toLocker(row);
}

/* ------------------------------------------------------------------ file */

/** Short-TTL presigned GET so the customer can view their own submission. */
export async function presignLockerFile(
  userId: string,
  id: string,
): Promise<{ url: string; expiresInSec: number }> {
  const row = await getPrisma().prescription.findFirst({
    where: { id, userId },
    select: { fileKey: true },
  });
  if (!row) notFound();

  return {
    url: await presignPrivateGet(row.fileKey, RX_FILE_URL_TTL_SEC),
    expiresInSec: RX_FILE_URL_TTL_SEC,
  };
}

/* ---------------------------------------------------------------- mutate */

/** Rename / re-assign a locker prescription. Blocked once attached to an order. */
export async function updateLockerPrescription(
  userId: string,
  id: string,
  body: UpdateRxBody,
): Promise<LockerPrescription> {
  const prisma = getPrisma();

  const existing = await prisma.prescription.findFirst({
    where: { id, userId },
    select: { orderId: true },
  });
  if (!existing) notFound();
  if (existing.orderId !== null) attachedConflict();

  const data: Prisma.PrescriptionUncheckedUpdateInput = {};
  if (body.label !== undefined) data.label = body.label;
  if (body.doctorName !== undefined) data.doctorName = body.doctorName;
  if (body.patientId !== undefined) {
    if (body.patientId === null) {
      data.patientId = null;
    } else {
      await assertOwnedPatient(userId, body.patientId);
      data.patientId = body.patientId;
    }
  }

  // `orderId: null` in the WHERE closes the attach-between-read-and-write race.
  const updated = await prisma.prescription.updateMany({
    where: { id, userId, orderId: null },
    data,
  });
  if (updated.count === 0) attachedConflict();

  const row = await prisma.prescription.findUniqueOrThrow({ where: { id }, select: lockerSelect });
  return toLocker(row);
}

/**
 * Drop a locker prescription. Blocked once attached (ops has it). The private
 * object is left in place — core/storage exposes no delete for the runtime
 * bucket, and retention is handled by the DPDP erasure job.
 */
export async function deleteLockerPrescription(userId: string, id: string): Promise<void> {
  const prisma = getPrisma();

  const existing = await prisma.prescription.findFirst({
    where: { id, userId },
    select: { orderId: true },
  });
  if (!existing) notFound();
  if (existing.orderId !== null) attachedConflict();

  const removed = await prisma.prescription.deleteMany({ where: { id, userId, orderId: null } });
  if (removed.count === 0) attachedConflict();
}

/* ---------------------------------------------------------------- attach */

/**
 * Re-use an unattached locker prescription for an order that needs one. Same
 * order-side preconditions as the order-scoped upload; like that route this
 * only records the Prescription — `order.rxStatus` stays where it is and only
 * the pharmacist review flips it (orders/opsService).
 */
export async function attachPrescriptionToOrder(
  userId: string,
  orderId: string,
  prescriptionId: string,
): Promise<LockerPrescription> {
  const prisma = getPrisma();

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { status: true, requiresRx: true, rxStatus: true },
  });
  if (!order) {
    throw new AppError("NOT_FOUND", "Order not found", 404);
  }
  if (!order.requiresRx) {
    throw new AppError("VALIDATION_ERROR", "This order does not require a prescription", 422);
  }
  if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED) {
    throw new AppError("CONFLICT", "This order can no longer accept a prescription", 409);
  }
  if (order.rxStatus !== RxStatus.PENDING && order.rxStatus !== RxStatus.REJECTED) {
    throw new AppError("CONFLICT", "This order is not awaiting a prescription", 409);
  }

  const rx = await prisma.prescription.findFirst({
    where: { id: prescriptionId, userId },
    select: { orderId: true },
  });
  if (!rx) notFound();
  if (rx.orderId !== null) {
    throw new AppError("CONFLICT", "This prescription is already attached to an order", 409);
  }

  const attached = await prisma.prescription.updateMany({
    where: { id: prescriptionId, userId, orderId: null },
    data: { orderId },
  });
  if (attached.count === 0) {
    throw new AppError("CONFLICT", "This prescription is already attached to an order", 409);
  }

  const row = await prisma.prescription.findUniqueOrThrow({
    where: { id: prescriptionId },
    select: lockerSelect,
  });
  return toLocker(row);
}
