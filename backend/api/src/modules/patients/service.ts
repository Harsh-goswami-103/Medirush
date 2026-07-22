import type {
  CreatePatientBody,
  Patient as PatientDto,
  PatientGender,
  PatientRelation,
  UpdatePatientBody,
} from "@medrush/contracts";
import type { Patient, Prisma } from "@prisma/client";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";

/**
 * Dependent patient profiles — "who is this order for" (Batch 3).
 * Every query is owner-scoped in its WHERE; a foreign id answers 404 so ids
 * cannot be probed (§8.3).
 */

const MAX_PATIENTS_PER_USER = 10;

// Customers enter dates on an IST clock; comparing against the UTC calendar day
// would reject a legitimate "today" for the ~5.5h the two disagree.
const IST_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toDto(row: Patient): PatientDto {
  return {
    id: row.id,
    name: row.name,
    relation: row.relation as PatientRelation,
    dob: row.dob ? row.dob.toISOString().slice(0, 10) : null,
    gender: row.gender as PatientGender | null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `YYYY-MM-DD` (already format-validated by the contract) → UTC midnight. */
function toDobDate(dob: string): Date {
  if (dob > IST_DATE.format(new Date())) {
    throw new AppError("VALIDATION_ERROR", "Date of birth cannot be in the future", 422);
  }
  return new Date(`${dob}T00:00:00.000Z`);
}

async function findOwnedPatientId(id: string, userId: string): Promise<string> {
  const row = await getPrisma().patient.findFirst({ where: { id, userId }, select: { id: true } });
  if (!row) {
    throw new AppError("NOT_FOUND", "Patient profile not found", 404);
  }
  return row.id;
}

/** Own profiles, oldest first. */
export async function listPatients(userId: string): Promise<PatientDto[]> {
  const rows = await getPrisma().patient.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toDto);
}

export async function createPatient(
  userId: string,
  body: CreatePatientBody,
): Promise<PatientDto> {
  const dob = body.dob === undefined ? null : toDobDate(body.dob);

  const row = await getPrisma().$transaction(async (tx) => {
    const existing = await tx.patient.count({ where: { userId } });
    if (existing >= MAX_PATIENTS_PER_USER) {
      throw new AppError(
        "VALIDATION_ERROR",
        `You can save at most ${MAX_PATIENTS_PER_USER} patient profiles`,
        422,
      );
    }
    return tx.patient.create({
      data: {
        userId,
        name: body.name,
        relation: body.relation,
        dob,
        gender: body.gender ?? null,
      },
    });
  });

  return toDto(row);
}

export async function updatePatient(
  userId: string,
  id: string,
  body: UpdatePatientBody,
): Promise<PatientDto> {
  await findOwnedPatientId(id, userId);

  const data: Prisma.PatientUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.relation !== undefined) data.relation = body.relation;
  if (body.dob !== undefined) data.dob = toDobDate(body.dob);
  if (body.gender !== undefined) data.gender = body.gender;

  return toDto(await getPrisma().patient.update({ where: { id }, data }));
}

/**
 * Hard delete, but only when nothing points at the profile — a past order or a
 * locker prescription must keep rendering who it was for.
 */
export async function deletePatient(userId: string, id: string): Promise<void> {
  await findOwnedPatientId(id, userId);
  const prisma = getPrisma();

  const [orders, prescriptions] = await Promise.all([
    prisma.order.count({ where: { patientId: id } }),
    prisma.prescription.count({ where: { patientId: id } }),
  ]);
  if (orders > 0 || prescriptions > 0) {
    throw new AppError(
      "CONFLICT",
      "This profile is used by an existing order or prescription and cannot be deleted",
      409,
    );
  }

  await prisma.patient.delete({ where: { id } });
}
