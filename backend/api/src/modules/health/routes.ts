import { readdirSync } from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPrisma } from "../../core/db";
import { isJobsStarted } from "../../core/jobs";
import { isShuttingDown } from "../../core/lifecycle";

/**
 * System endpoints (§7.2, unprefixed):
 * - GET /healthz — liveness: process is up. Always 200.
 * - GET /readyz  — readiness: DB ping + migrations current + boss started +
 *   not shutting down. Railway deploy gate + shutdown drain (§11).
 */

const okEnvelope = z.object({ data: z.object({ status: z.literal("ok") }) });
const readyEnvelope = z.object({ data: z.object({ status: z.literal("ready") }) });
const notReadyEnvelope = z.object({
  error: z.object({
    code: z.literal("INTERNAL"),
    message: z.string(),
    details: z.object({ failed: z.array(z.string()) }),
  }),
});

/**
 * Migration directories shipped with this build (prisma/migrations/*). Read
 * once, lazily — cwd is the api package root in dev (`pnpm --filter api dev`),
 * tests (vitest) and prod (Railway start command). If the directory is not
 * shipped alongside the process we can't know what "current" means, so we fall
 * back to row-state checks only.
 */
let expectedMigrations: string[] | null = null;
function getExpectedMigrations(): string[] {
  if (expectedMigrations === null) {
    try {
      expectedMigrations = readdirSync(path.join(process.cwd(), "prisma", "migrations"), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      expectedMigrations = [];
    }
  }
  return expectedMigrations;
}

async function collectReadinessFailures(): Promise<string[]> {
  const failures: string[] = [];

  if (isShuttingDown()) failures.push("shutting_down");

  try {
    const prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
    try {
      const rows = await prisma.$queryRaw<
        Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
      >`
        SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations"
      `;
      // A migration is outstanding if it started but never finished (mid-flight
      // failure), or if it ships with this build but has no applied row at all
      // — `migrate deploy` skipped/failed leaves NO row, not an unfinished one.
      const applied = new Set(
        rows
          .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
          .map((row) => row.migration_name),
      );
      const midFlight = rows.some(
        (row) => row.finished_at === null && row.rolled_back_at === null,
      );
      const missing = getExpectedMigrations().some((name) => !applied.has(name));
      if (midFlight || missing) failures.push("migrations_pending");
    } catch {
      failures.push("migrations_not_applied");
    }
  } catch {
    failures.push("database_unreachable");
  }

  if (!isJobsStarted()) failures.push("jobs_not_started");

  return failures;
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/healthz",
    {
      config: { public: true },
      schema: {
        tags: ["system"],
        summary: "Liveness probe",
        response: { 200: okEnvelope },
      },
    },
    async () => ({ data: { status: "ok" as const } }),
  );

  typed.get(
    "/readyz",
    {
      config: { public: true },
      schema: {
        tags: ["system"],
        summary: "Readiness probe (deploy gate + shutdown drain)",
        response: { 200: readyEnvelope, 503: notReadyEnvelope },
      },
    },
    async (_request, reply) => {
      const failures = await collectReadinessFailures();
      if (failures.length > 0) {
        return reply.code(503).send({
          error: {
            code: "INTERNAL" as const,
            message: `Not ready — failed checks: ${failures.join(", ")}`,
            details: { failed: failures },
          },
        });
      }
      return { data: { status: "ready" as const } };
    },
  );
};
