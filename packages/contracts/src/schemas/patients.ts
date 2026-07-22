/**
 * Dependent patient profiles — "who is this order for" (industry-standard for
 * medicine apps; also sharpens the Schedule-H1 register, which records the
 * patient rather than the account holder).
 *
 * | Endpoint                | Body / Query             | Response data    |
 * |-------------------------|--------------------------|------------------|
 * | GET    /v1/patients     | —                        | PatientSchema[]  |
 * | POST   /v1/patients     | CreatePatientBodySchema  | PatientSchema    |
 * | PATCH  /v1/patients/:id | UpdatePatientBodySchema  | PatientSchema    |
 * | DELETE /v1/patients/:id | —                        | OkSchema         |
 *
 * Owner-scoped. A profile referenced by an existing order is never hard
 * deleted — past orders must keep rendering who they were for.
 */
import { z } from "zod";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, envelope } from "./common";

export const PatientRelation = {
  SELF: "SELF",
  SPOUSE: "SPOUSE",
  CHILD: "CHILD",
  PARENT: "PARENT",
  OTHER: "OTHER",
} as const;
export type PatientRelation = (typeof PatientRelation)[keyof typeof PatientRelation];
export const PatientRelationSchema = z.enum(PatientRelation);

export const PatientGender = { M: "M", F: "F", OTHER: "OTHER" } as const;
export type PatientGender = (typeof PatientGender)[keyof typeof PatientGender];
export const PatientGenderSchema = z.enum(PatientGender);

export const PatientSchema = z.object({
  id: IdSchema,
  name: z.string(),
  relation: PatientRelationSchema,
  /** Date only (no time) — used for age-appropriate dispensing checks. */
  dob: IsoDateSchema.nullable(),
  gender: PatientGenderSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Patient = z.infer<typeof PatientSchema>;

export const CreatePatientBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  relation: PatientRelationSchema,
  dob: IsoDateSchema.optional(),
  gender: PatientGenderSchema.optional(),
});
export type CreatePatientBody = z.infer<typeof CreatePatientBodySchema>;

export const UpdatePatientBodySchema = CreatePatientBodySchema.partial();
export type UpdatePatientBody = z.infer<typeof UpdatePatientBodySchema>;

export const ListPatientsResponseSchema = envelope(z.array(PatientSchema));
export const PatientResponseSchema = envelope(PatientSchema);
