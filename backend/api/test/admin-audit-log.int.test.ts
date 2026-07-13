import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Admin audit-log read API integration tests (Phase 7 hardening). Real Postgres.
 * GET /v1/admin/audit-log: newest-first cursor pagination, entity/entityId/
 * actorId/action filters, ADMIN-only, and the write→read loop (an admin action
 * performed over HTTP is visible in the trail).
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const factories = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;

async function makeAdmin() {
  const admin = await factories.user("ADMIN");
  return { admin, headers: authHeaders(admin) };
}

/** Seed an AuditLog row at an explicit instant (deterministic newest-first order). */
function seedAudit(data: {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  agoMs: number;
}) {
  return prisma.auditLog.create({
    data: {
      actorId: data.actorId,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId,
      meta: { seeded: true },
      createdAt: new Date(Date.now() - data.agoMs),
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
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
  await factories.storeConfig();
  await factories.appSettings();
});

describe("GET /v1/admin/audit-log", () => {
  it("rejects a non-admin token with 403", async () => {
    const staff = await factories.user("INVENTORY");
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log",
      headers: authHeaders(staff),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("pages newest-first with a working cursor", async () => {
    const { admin, headers } = await makeAdmin();
    const oldest = await seedAudit({
      actorId: admin.id,
      action: "A",
      entity: "User",
      entityId: "u1",
      agoMs: 3_000,
    });
    const middle = await seedAudit({
      actorId: admin.id,
      action: "B",
      entity: "User",
      entityId: "u2",
      agoMs: 2_000,
    });
    const newest = await seedAudit({
      actorId: admin.id,
      action: "C",
      entity: "Order",
      entityId: "o1",
      agoMs: 1_000,
    });

    const page1 = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log?limit=2",
      headers,
    });
    expect(page1.statusCode, page1.body).toBe(200);
    expect(page1.headers["cache-control"]).toBe("no-store");
    const body1 = page1.json() as {
      data: Array<{ id: string; createdAt: string }>;
      meta: { nextCursor: string | null };
    };
    expect(body1.data.map((r) => r.id)).toEqual([newest.id, middle.id]);
    expect(body1.meta.nextCursor).toBe(middle.id);

    const page2 = await app.inject({
      method: "GET",
      url: `/v1/admin/audit-log?limit=2&cursor=${body1.meta.nextCursor}`,
      headers,
    });
    expect(page2.statusCode, page2.body).toBe(200);
    const body2 = page2.json() as {
      data: Array<{ id: string }>;
      meta: { nextCursor: string | null };
    };
    expect(body2.data.map((r) => r.id)).toEqual([oldest.id]);
    expect(body2.meta.nextCursor).toBeNull();
  });

  it("filters by entity(+entityId), actorId, and action (AND-combined)", async () => {
    const { admin, headers } = await makeAdmin();
    const otherAdmin = await factories.user("ADMIN");
    await seedAudit({
      actorId: admin.id,
      action: "USER_BLOCKED",
      entity: "User",
      entityId: "u1",
      agoMs: 4_000,
    });
    await seedAudit({
      actorId: admin.id,
      action: "USER_ANONYMIZED",
      entity: "User",
      entityId: "u2",
      agoMs: 3_000,
    });
    await seedAudit({
      actorId: otherAdmin.id,
      action: "PAYOUT_APPROVED",
      entity: "Payout",
      entityId: "p1",
      agoMs: 2_000,
    });

    const byEntity = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log?entity=User",
      headers,
    });
    expect(byEntity.statusCode, byEntity.body).toBe(200);
    const entityRows = byEntity.json().data as Array<{ entity: string }>;
    expect(entityRows).toHaveLength(2);
    expect(entityRows.every((r) => r.entity === "User")).toBe(true);

    const byEntityId = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log?entity=User&entityId=u2",
      headers,
    });
    const entityIdRows = byEntityId.json().data as Array<{ action: string; entityId: string }>;
    expect(entityIdRows).toHaveLength(1);
    expect(entityIdRows[0]?.action).toBe("USER_ANONYMIZED");

    const byActor = await app.inject({
      method: "GET",
      url: `/v1/admin/audit-log?actorId=${otherAdmin.id}`,
      headers,
    });
    const actorRows = byActor.json().data as Array<{ actorId: string }>;
    expect(actorRows).toHaveLength(1);
    expect(actorRows[0]?.actorId).toBe(otherAdmin.id);

    const byAction = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-log?action=USER_ANONYMIZED",
      headers,
    });
    const actionRows = byAction.json().data as Array<{ entityId: string }>;
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]?.entityId).toBe("u2");
  });

  it("shows rows written by real admin mutations (write→read loop)", async () => {
    const { admin, headers } = await makeAdmin();
    const target = await factories.user("CUSTOMER");

    const block = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${target.id}/block`,
      headers,
      payload: { blocked: true, reason: "audit trail probe" },
    });
    expect(block.statusCode, block.body).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/audit-log?action=USER_BLOCKED&entityId=${target.id}`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Array<{
      actorId: string;
      entity: string;
      meta: { reason: string } | null;
      createdAt: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(admin.id);
    expect(rows[0]?.entity).toBe("User");
    expect(rows[0]?.meta?.reason).toBe("audit trail probe");
    expect(new Date(rows[0]?.createdAt ?? "").getTime()).not.toBeNaN();
  });
});
