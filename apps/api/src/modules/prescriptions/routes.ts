import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  IdParamsSchema,
  OrderStatus,
  Role,
  RxStatus,
  UploadPrescriptionResponseSchema,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { validateAndNormalizeUpload } from "../../core/rxProcessing";
import { putPrivateObject } from "../../core/storage";
import { requireSyncedAuth } from "../../plugins/auth";

/**
 * Prescription upload (BLUEPRINT §7.2, §10.1, §13; phase-2 brief §5):
 * - POST /v1/orders/:id/prescriptions — multipart, CUSTOMER, own order.
 *
 * A single `file` part (≤5MB jpeg/png/pdf) is magic-byte validated and (for
 * images) re-encoded to strip EXIF/GPS, stored to the private bucket under a
 * SERVER-generated key `rx/{orderId}/{cuid}.{ext}` (no client-controlled path),
 * and recorded as a PENDING Prescription. Allowed only while the order still
 * needs a prescription (requiresRx, rxStatus PENDING/REJECTED, not terminal).
 */

/** @fastify/multipart raises this when a part exceeds the configured fileSize. */
const FILE_TOO_LARGE = "FST_REQ_FILE_TOO_LARGE";

function isTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: string; statusCode?: number };
  return e.code === FILE_TOO_LARGE || e.statusCode === 413;
}

const customerOnly = { roles: [Role.CUSTOMER] };

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
};
