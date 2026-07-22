import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Dependent patient profiles (Batch 3): owner-scoped CRUD, the 10-profile cap,
 * future-dob rejection and the referenced-profile delete guard. Real Postgres.
 */

// Env must be set BEFORE the app is imported (config/logger parse eagerly).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_c2_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { patientRoutes } = await import("../src/modules/patients/routes");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;
type Headers = Record<string, string>;

const prisma = getPrisma();
let app: App;

interface PatientDto {
  id: string;
  name: string;
  relation: string;
  dob: string | null;
  gender: string | null;
  createdAt: string;
}

async function customer(): Promise<{ id: string; headers: Headers }> {
  const row = await user("CUSTOMER");
  return { id: row.id, headers: authHeaders(row) };
}

function createPatient(headers: Headers, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/patients", headers, payload });
}

/** Create a profile straight through the API and return the DTO. */
async function seedPatient(
  headers: Headers,
  payload: Record<string, unknown> = { name: "Asha", relation: "PARENT" },
): Promise<PatientDto> {
  const res = await createPatient(headers, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data as PatientDto;
}

/** Minimal DELIVERED order row for `userId`, optionally attributed to a patient. */
async function order(userId: string, patientId: string | null) {
  return prisma.order.create({
    data: {
      orderNo: `MR-TEST-${Math.random().toString(36).slice(2, 10)}`,
      userId,
      status: "DELIVERED",
      paymentMethod: "COD",
      paymentStatus: "PAID",
      addressSnapshot: { line1: "1 Test Road", pincode: "560001", lat: 12.9716, lng: 77.5946 },
      distanceM: 1200,
      itemsPaise: 20_000,
      deliveryPaise: 2_000,
      totalPaise: 22_000,
      patientId,
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  // The orchestrator wires patientRoutes into v1.ts; register here only while
  // that has not happened yet, so this file passes either way.
  if (!app.hasRoute({ method: "GET", url: "/v1/patients" })) {
    await app.register(patientRoutes, { prefix: "/v1" });
  }
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  clearAuthCaches();
  bustStoreConfigCache();
  bustFlagCache();
  await storeConfig();
  await appSettings();
});

describe("POST /v1/patients", () => {
  it("creates a profile, echoes the DTO and stores dob at UTC midnight", async () => {
    const { headers } = await customer();

    const res = await createPatient(headers, {
      name: "  Asha Devi  ",
      relation: "PARENT",
      dob: "1961-03-09",
      gender: "F",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");

    const dto = res.json().data as PatientDto;
    expect(dto.name).toBe("Asha Devi"); // contract trims
    expect(dto.relation).toBe("PARENT");
    expect(dto.dob).toBe("1961-03-09");
    expect(dto.gender).toBe("F");
    expect(dto.createdAt).toMatch(/Z$/);

    const row = await prisma.patient.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.dob?.toISOString()).toBe("1961-03-09T00:00:00.000Z");
  });

  it("omitted dob/gender land as null", async () => {
    const { headers } = await customer();
    const dto = await seedPatient(headers, { name: "Rahul", relation: "CHILD" });
    expect(dto.dob).toBeNull();
    expect(dto.gender).toBeNull();
  });

  it("rejects a future dob with 422 VALIDATION_ERROR", async () => {
    const { headers } = await customer();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await createPatient(headers, { name: "Future", relation: "OTHER", dob: tomorrow });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.patient.count()).toBe(0);
  });

  it("accepts today as a dob", async () => {
    const { headers } = await customer();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const dto = await seedPatient(headers, { name: "Newborn", relation: "CHILD", dob: today });
    expect(dto.dob).toBe(today);
  });

  it("caps a user at 10 profiles — the 11th is 422 VALIDATION_ERROR", async () => {
    const { headers } = await customer();
    const other = await customer();

    for (let i = 0; i < 10; i += 1) {
      await seedPatient(headers, { name: `Dependent ${i}`, relation: "OTHER" });
    }

    const res = await createPatient(headers, { name: "Eleventh", relation: "OTHER" });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await prisma.patient.count({ where: {} })).toBe(10);

    // The cap is per user, not global.
    const forOther = await createPatient(other.headers, { name: "Theirs", relation: "SELF" });
    expect(forOther.statusCode, forOther.body).toBe(201);
  });

  it("rejects malformed bodies with 400", async () => {
    const { headers } = await customer();

    const blank = await createPatient(headers, { name: "   ", relation: "SELF" });
    expect(blank.statusCode, blank.body).toBe(400);

    const badRelation = await createPatient(headers, { name: "X", relation: "COUSIN" });
    expect(badRelation.statusCode, badRelation.body).toBe(400);

    const badDob = await createPatient(headers, { name: "X", relation: "SELF", dob: "09-03-1961" });
    expect(badDob.statusCode, badDob.body).toBe(400);

    const badGender = await createPatient(headers, { name: "X", relation: "SELF", gender: "male" });
    expect(badGender.statusCode, badGender.body).toBe(400);
  });
});

describe("GET /v1/patients", () => {
  it("returns only own profiles, oldest first", async () => {
    const { headers } = await customer();
    const other = await customer();

    await seedPatient(headers, { name: "First", relation: "SELF" });
    await seedPatient(headers, { name: "Second", relation: "SPOUSE" });
    await seedPatient(headers, { name: "Third", relation: "CHILD" });
    await seedPatient(other.headers, { name: "Stranger", relation: "SELF" });

    const res = await app.inject({ method: "GET", url: "/v1/patients", headers });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as PatientDto[];
    expect(data.map((p) => p.name)).toEqual(["First", "Second", "Third"]);

    const theirs = await app.inject({ method: "GET", url: "/v1/patients", headers: other.headers });
    expect((theirs.json().data as PatientDto[]).map((p) => p.name)).toEqual(["Stranger"]);
  });

  it("returns an empty list for a user with no profiles", async () => {
    const { headers } = await customer();
    const res = await app.inject({ method: "GET", url: "/v1/patients", headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});

describe("PATCH /v1/patients/:id", () => {
  it("updates only the supplied fields", async () => {
    const { headers } = await customer();
    const created = await seedPatient(headers, {
      name: "Asha",
      relation: "PARENT",
      dob: "1961-03-09",
      gender: "F",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/patients/${created.id}`,
      headers,
      payload: { name: "Asha Devi", relation: "OTHER" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      id: created.id,
      name: "Asha Devi",
      relation: "OTHER",
      dob: "1961-03-09",
      gender: "F",
    });
  });

  it("an empty body is a no-op", async () => {
    const { headers } = await customer();
    const created = await seedPatient(headers);

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/patients/${created.id}`,
      headers,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual(created);
  });

  it("rejects a future dob with 422 and leaves the row untouched", async () => {
    const { headers } = await customer();
    const created = await seedPatient(headers, { name: "Asha", relation: "PARENT" });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/patients/${created.id}`,
      headers,
      payload: { dob: tomorrow },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: created.id } })).dob).toBeNull();
  });

  it("another user's profile is 404 and is never mutated", async () => {
    const owner = await customer();
    const intruder = await customer();
    const created = await seedPatient(owner.headers, { name: "Asha", relation: "PARENT" });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/patients/${created.id}`,
      headers: intruder.headers,
      payload: { name: "Hijacked" },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: created.id } })).name).toBe("Asha");
  });

  it("an unknown id is 404", async () => {
    const { headers } = await customer();
    const res = await app.inject({
      method: "PATCH",
      url: "/v1/patients/ckzzzzzzzzzzzzzzzzzzzzzzz",
      headers,
      payload: { name: "Nobody" },
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe("DELETE /v1/patients/:id", () => {
  it("deletes an unreferenced own profile", async () => {
    const { headers } = await customer();
    const created = await seedPatient(headers);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/patients/${created.id}`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
    expect(await prisma.patient.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("another user's profile is 404 and survives", async () => {
    const owner = await customer();
    const intruder = await customer();
    const created = await seedPatient(owner.headers);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/patients/${created.id}`,
      headers: intruder.headers,
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(await prisma.patient.findUnique({ where: { id: created.id } })).not.toBeNull();
  });

  it("a profile referenced by an order is 409 CONFLICT", async () => {
    const owner = await customer();
    const created = await seedPatient(owner.headers);
    await order(owner.id, created.id);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/patients/${created.id}`,
      headers: owner.headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(await prisma.patient.findUnique({ where: { id: created.id } })).not.toBeNull();
  });

  it("a profile referenced by a prescription is 409 CONFLICT", async () => {
    const owner = await customer();
    const created = await seedPatient(owner.headers);
    await prisma.prescription.create({
      data: {
        userId: owner.id,
        patientId: created.id,
        fileKey: "rx/locker/test.jpg",
        mimeType: "image/jpeg",
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/patients/${created.id}`,
      headers: owner.headers,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("an order with no patient never blocks an unrelated profile", async () => {
    const owner = await customer();
    const created = await seedPatient(owner.headers);
    await order(owner.id, null);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/patients/${created.id}`,
      headers: owner.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("auth", () => {
  it("every verb requires a customer token", async () => {
    const owner = await customer();
    const created = await seedPatient(owner.headers);
    const admin = authHeaders(await user("ADMIN"));

    const anonymous = await Promise.all([
      app.inject({ method: "GET", url: "/v1/patients" }),
      app.inject({ method: "POST", url: "/v1/patients", payload: { name: "X", relation: "SELF" } }),
      app.inject({ method: "PATCH", url: `/v1/patients/${created.id}`, payload: { name: "X" } }),
      app.inject({ method: "DELETE", url: `/v1/patients/${created.id}` }),
    ]);
    for (const res of anonymous) {
      expect(res.statusCode, res.body).toBe(401);
    }

    const asAdmin = await app.inject({ method: "GET", url: "/v1/patients", headers: admin });
    expect(asAdmin.statusCode, asAdmin.body).toBe(403);
  });
});
