/**
 * Prescription locker — prescriptions belong to the CUSTOMER and can be
 * re-used across orders, so a chronic patient uploads once instead of
 * re-photographing the same paper every refill.
 *
 * | Endpoint                          | Body / Query                  | Response data           |
 * |-----------------------------------|-------------------------------|-------------------------|
 * | GET    /v1/prescriptions          | ListRxQuerySchema             | LockerPrescription[]    |
 * | POST   /v1/prescriptions          | multipart `file` (+ fields)   | LockerPrescriptionSchema|
 * | GET    /v1/prescriptions/:id/file | —                             | RxFileUrlSchema         |
 * | PATCH  /v1/prescriptions/:id      | UpdateRxBodySchema            | LockerPrescriptionSchema|
 * | DELETE /v1/prescriptions/:id      | —                             | OkSchema                |
 * | POST   /v1/orders/:id/prescriptions/attach | AttachRxBodySchema   | LockerPrescriptionSchema|
 *
 * The standalone POST is also the "upload a prescription and we'll take it
 * from here" lead-in flow. Files are private R2 objects — the customer reads
 * their own via a short-lived presigned GET, never a raw key. A prescription
 * already attached to an order is immutable (ops has reviewed it).
 */
import { z } from "zod";
import { RxStatusSchema } from "../enums";
import {
  CursorQuerySchema,
  IdSchema,
  IsoDateTimeSchema,
  envelope,
  paginatedEnvelope,
} from "./common";

export const LockerPrescriptionSchema = z.object({
  id: IdSchema,
  /** Customer-chosen label, e.g. "Dr Rao — Aug". */
  label: z.string().nullable(),
  status: RxStatusSchema,
  mimeType: z.string(),
  /** Set once attached to an order; null while it sits in the locker. */
  orderId: IdSchema.nullable(),
  orderNo: z.string().nullable(),
  /** Dependent this prescription belongs to; null = account holder. */
  patientId: IdSchema.nullable(),
  patientName: z.string().nullable(),
  doctorName: z.string().nullable(),
  /** Pharmacist's note — the reason on a rejection. */
  reviewNote: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema.nullable(),
});
export type LockerPrescription = z.infer<typeof LockerPrescriptionSchema>;

export const ListRxQuerySchema = CursorQuerySchema.extend({
  /** true → only prescriptions not yet attached to an order (re-usable). */
  unattached: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});
export type ListRxQuery = z.infer<typeof ListRxQuerySchema>;

export const UpdateRxBodySchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  patientId: IdSchema.nullish(),
  doctorName: z.string().trim().min(1).max(80).optional(),
});
export type UpdateRxBody = z.infer<typeof UpdateRxBodySchema>;

/** Re-use a locker prescription for an order that needs one. */
export const AttachRxBodySchema = z.object({ prescriptionId: IdSchema });
export type AttachRxBody = z.infer<typeof AttachRxBodySchema>;

/** Short-lived presigned GET so the customer can view what they submitted. */
export const RxFileUrlSchema = z.object({
  url: z.url(),
  expiresInSec: z.number().int().positive(),
});
export type RxFileUrl = z.infer<typeof RxFileUrlSchema>;

export const ListRxResponseSchema = paginatedEnvelope(LockerPrescriptionSchema);
export const LockerPrescriptionResponseSchema = envelope(LockerPrescriptionSchema);
export const RxFileUrlResponseSchema = envelope(RxFileUrlSchema);
