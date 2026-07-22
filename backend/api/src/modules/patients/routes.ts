import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AckResponseSchema,
  ApiErrorSchema,
  CreatePatientBodySchema,
  IdParamsSchema,
  ListPatientsResponseSchema,
  PatientResponseSchema,
  Role,
  UpdatePatientBodySchema,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import { createPatient, deletePatient, listPatients, updatePatient } from "./service";

/**
 * Dependent patient profiles (Batch 3):
 * - GET    /v1/patients
 * - POST   /v1/patients
 * - PATCH  /v1/patients/:id
 * - DELETE /v1/patients/:id
 *
 * CUSTOMER-only and owner-scoped; a foreign id answers 404 (§8.3).
 */

const customerOnly = { roles: [Role.CUSTOMER] };

export const patientRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Health data — never cache (§12).
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.getHeader("cache-control")) void reply.header("cache-control", "no-store");
  });

  app.get(
    "/patients",
    {
      config: customerOnly,
      schema: {
        tags: ["patients"],
        summary: "List own dependent patient profiles, oldest first",
        response: { 200: ListPatientsResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await listPatients(userId) };
    },
  );

  app.post(
    "/patients",
    {
      config: customerOnly,
      schema: {
        tags: ["patients"],
        summary: "Create a dependent patient profile (max 10 per account)",
        body: CreatePatientBodySchema,
        response: { 201: PatientResponseSchema, 422: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const patient = await createPatient(userId, request.body);
      void reply.code(201);
      return { data: patient };
    },
  );

  app.patch(
    "/patients/:id",
    {
      config: customerOnly,
      schema: {
        tags: ["patients"],
        summary: "Update an own patient profile",
        params: IdParamsSchema,
        body: UpdatePatientBodySchema,
        response: { 200: PatientResponseSchema, 404: ApiErrorSchema, 422: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await updatePatient(userId, request.params.id, request.body) };
    },
  );

  app.delete(
    "/patients/:id",
    {
      config: customerOnly,
      schema: {
        tags: ["patients"],
        summary: "Delete an own patient profile (blocked once referenced)",
        params: IdParamsSchema,
        response: { 200: AckResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      await deletePatient(userId, request.params.id);
      return { data: { ok: true as const } };
    },
  );
};
