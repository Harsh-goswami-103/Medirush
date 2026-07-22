import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckResponseSchema,
  AttachRxBodySchema,
  IdParamsSchema,
  ListRxQuerySchema,
  ListRxResponseSchema,
  LockerPrescriptionResponseSchema,
  OrderStatus,
  Role,
  RxFileUrlResponseSchema,
  RxStatus,
  UpdateRxBodySchema,
  UploadPrescriptionResponseSchema,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { validateAndNormalizeUpload } from "../../core/rxProcessing";
import { putPrivateObject } from "../../core/storage";
import { requireSyncedAuth } from "../../plugins/auth";
import {
  attachPrescriptionToOrder,
  createLockerPrescription,
  deleteLockerPrescription,
  listLockerPrescriptions,
  presignLockerFile,
  updateLockerPrescription,
} from "./service";

/**
 * Prescription upload + locker (BLUEPRINT §7.2, §10.1, §13; phase-2 brief §5;
 * Batch 3 locker):
 * - POST   /v1/orders/:id/prescriptions        — multipart, CUSTOMER, own order.
 * - GET    /v1/prescriptions                   — own locker, cursor-paginated.
 * - POST   /v1/prescriptions                   — standalone multipart upload.
 * - GET    /v1/prescriptions/:id/file          — short-TTL presigned GET.
 * - PATCH  /v1/prescriptions/:id               — label/patient/doctor, unattached only.
 * - DELETE /v1/prescriptions/:id               — unattached only.
 * - POST   /v1/orders/:id/prescriptions/attach — re-use a locker prescription.
 *
 * A single `file` part (≤5MB jpeg/png/pdf) is magic-byte validated and (for
 * images) re-encoded to strip EXIF/GPS, stored to the private bucket under a
 * SERVER-generated key (no client-controlled path), and recorded as a PENDING
 * Prescription owned by the uploader.
 */

/** @fastify/multipart raises this when a part exceeds the configured fileSize. */
const FILE_TOO_LARGE = "FST_REQ_FILE_TOO_LARGE";

function isTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; statusCode?: number };
  return e.code === FILE_TOO_LARGE || e.statusCode === 413;
}

const customerOnly = { roles: [Role.CUSTOMER] };

interface ParsedUpload {
  buffer: Buffer;
  mimetype: string;
  fields: Record<string, string>;
}

/**
 * Read the single `file` part plus any text fields. `request.parts()` is used
 * instead of `request.file()` so form fields are picked up whichever side of
 * the file part the client puts them on.
 */
async function readUpload(request: FastifyRequest): Promise<ParsedUpload> {
  let buffer: Buffer | null = null;
  let mimetype = "";
  const fields: Record<string, string> = {};

  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        mimetype = part.mimetype;
        buffer = await part.toBuffer();
      } else if (typeof part.value === "string" && part.value.length > 0) {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isTooLarge(error)) {
      throw new AppError("VALIDATION_ERROR", "File exceeds the 5MB limit", 422);
    }
    throw error;
  }

  if (!buffer) {
    throw new AppError("VALIDATION_ERROR", "A file part is required", 422);
  }
  return { buffer, mimetype, fields };
}

export const prescriptionRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: prescription responses carry PII references — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.post(
    "/orders/:id/prescriptions",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Upload a prescription image/PDF (multipart, ≤5MB, own order)",
        consumes: ["multipart/form-data"],
        params: IdParamsSchema,
        response: { 201: UploadPrescriptionResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const orderId = request.params.id;
      const prisma = getPrisma();

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { userId: true, status: true, requiresRx: true, rxStatus: true },
      });
      // Own order only — a foreign order is indistinguishable from a missing one (§8.3).
      if (!order || order.userId !== userId) {
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

      // Stream the single file part; @fastify/multipart enforces the 5MB ceiling.
      let buffer: Buffer;
      let mimetype: string;
      try {
        const part = await request.file();
        if (!part) {
          throw new AppError("VALIDATION_ERROR", "A file part is required", 422);
        }
        mimetype = part.mimetype;
        buffer = await part.toBuffer();
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (isTooLarge(error)) {
          throw new AppError("VALIDATION_ERROR", "File exceeds the 5MB limit", 422);
        }
        throw error;
      }

      // Magic-byte check + EXIF-stripping re-encode (throws VALIDATION_ERROR 422).
      const normalized = await validateAndNormalizeUpload(buffer, mimetype);

      // Server-generated key — no path-traversal surface (§13).
      const key = `rx/${orderId}/${randomUUID().replace(/-/g, "")}.${normalized.ext}`;
      // External I/O — no DB tx is open here (§14).
      await putPrivateObject(key, normalized.body, normalized.contentType);

      const rx = await prisma.prescription.create({
        data: {
          // Owned by the uploader (Rx locker); the order link stays set because
          // this route uploads against a specific order.
          userId,
          orderId,
          fileKey: key,
          mimeType: normalized.contentType,
          status: RxStatus.PENDING,
        },
      });

      reply.code(201);
      return {
        data: {
          id: rx.id,
          status: rx.status,
          mimeType: rx.mimeType,
          reviewNote: rx.reviewNote,
          createdAt: rx.createdAt.toISOString(),
          reviewedAt: rx.reviewedAt ? rx.reviewedAt.toISOString() : null,
        },
      };
    },
  );

  typed.get(
    "/prescriptions",
    {
      config: customerOnly,
      schema: {
        tags: ["prescriptions"],
        summary: "List the caller's prescriptions (cursor-paginated, newest first)",
        querystring: ListRxQuerySchema,
        response: { 200: ListRxResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { cursor, limit, unattached } = request.query;
      const { items, nextCursor } = await listLockerPrescriptions(userId, {
        cursor,
        limit,
        unattached,
      });
      return { data: items, meta: { nextCursor } };
    },
  );

  typed.post(
    "/prescriptions",
    {
      config: customerOnly,
      schema: {
        tags: ["prescriptions"],
        summary: "Upload a prescription to the locker (multipart, ≤5MB, no order)",
        consumes: ["multipart/form-data"],
        response: { 201: LockerPrescriptionResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const { buffer, mimetype, fields } = await readUpload(request);

      // The optional form fields are exactly the PATCH surface.
      const parsed = UpdateRxBodySchema.safeParse(fields);
      if (!parsed.success) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Invalid prescription fields",
          422,
          parsed.error.issues,
        );
      }

      const data = await createLockerPrescription(userId, {
        buffer,
        mimetype,
        label: parsed.data.label,
        patientId: parsed.data.patientId,
        doctorName: parsed.data.doctorName,
      });

      reply.code(201);
      return { data };
    },
  );

  typed.get(
    "/prescriptions/:id/file",
    {
      config: customerOnly,
      schema: {
        tags: ["prescriptions"],
        summary: "Short-lived presigned URL for the caller's own prescription file",
        params: IdParamsSchema,
        response: { 200: RxFileUrlResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await presignLockerFile(userId, request.params.id) };
    },
  );

  typed.patch(
    "/prescriptions/:id",
    {
      config: customerOnly,
      schema: {
        tags: ["prescriptions"],
        summary: "Edit an unattached prescription's label / patient / doctor",
        params: IdParamsSchema,
        body: UpdateRxBodySchema,
        response: { 200: LockerPrescriptionResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await updateLockerPrescription(userId, request.params.id, request.body) };
    },
  );

  typed.delete(
    "/prescriptions/:id",
    {
      config: customerOnly,
      schema: {
        tags: ["prescriptions"],
        summary: "Delete an unattached prescription from the locker",
        params: IdParamsSchema,
        response: { 200: AckResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      await deleteLockerPrescription(userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );

  typed.post(
    "/orders/:id/prescriptions/attach",
    {
      config: customerOnly,
      schema: {
        tags: ["orders"],
        summary: "Attach an unattached locker prescription to an order that needs one",
        params: IdParamsSchema,
        body: AttachRxBodySchema,
        response: { 200: LockerPrescriptionResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const data = await attachPrescriptionToOrder(
        userId,
        request.params.id,
        request.body.prescriptionId,
      );
      return { data };
    },
  );
};
