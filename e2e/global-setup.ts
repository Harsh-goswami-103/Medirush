import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { API_URL, OPS_URL, WEB_URL } from "./stack";

/**
 * Golden-path pre-flight. Assumes the stack is already running (see
 * playwright.config.ts header) and the DB is migrated + seeded. Then:
 *
 *  1. waits for API / web / ops to answer;
 *  2. normalises the seeded store to 24×7 hours (sql/open-store.sql) so the
 *     checkout STORE_CLOSED gate can't flake runs outside 08:00–22:00 IST,
 *     and polls /v1/store until the API's 60s StoreConfig cache reflects it;
 *  3. deletes orders left behind by previous runs (sql/reset-demo-orders.sql)
 *     so checkout's 3-orders/hour velocity gate never 429s a local re-run;
 *  4. pre-warms the routes the specs visit — `next dev` compiles per route on
 *     first hit, which would otherwise eat most of the navigation timeout.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(name: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (res.status < 500) return; // any served response means the process is up
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  throw new Error(
    `${name} did not come up at ${url} within ${Math.round(timeoutMs / 1000)}s (${lastError}).\n` +
      "The e2e runner must start the stack first:\n" +
      "  pnpm --filter @medrush/api dev   (API :4000, seeded DB)\n" +
      "  pnpm --filter @medrush/web dev   (customer PWA :3000)\n" +
      "  pnpm --filter @medrush/ops dev   (ops console :3001)",
  );
}

/** Run an e2e/sql/*.sql file against the API's DATABASE_URL via the prisma CLI. */
function runSqlFile(fileName: string, what: string): void {
  const sqlFile = path.join(__dirname, "sql", fileName);
  const command =
    `pnpm --filter @medrush/api exec prisma db execute` +
    ` --file "${sqlFile}" --schema prisma/schema.prisma`;
  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to ${what} (prisma db execute exited ${result.status}):\n` +
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

/** Poll /v1/store until the API serves the 24×7 hours (its cache TTL is 60s). */
async function waitForStoreOpen(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_URL}/v1/store`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { isOpen?: boolean; openTime?: string; closeTime?: string };
        };
        const store = body.data;
        if (store?.isOpen && store.openTime === "00:00" && store.closeTime === "00:00") return;
        last = `isOpen=${String(store?.isOpen)} hours=${store?.openTime}-${store?.closeTime}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  throw new Error(
    `API still reports the store as closed/limited hours after ${Math.round(timeoutMs / 1000)}s (${last}). ` +
      "Is the DB seeded (pnpm db:seed) and did sql/open-store.sql apply?",
  );
}

/** Touch each route once so `next dev` compiles it before the spec navigates. */
async function prewarm(urls: string[]): Promise<void> {
  for (const url of urls) {
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(90_000) });
    } catch {
      // Best-effort — a slow compile just falls back to the nav timeout.
    }
  }
}

function openStoreAllHours(): void {
  runSqlFile("open-store.sql", "normalise store hours");
}

/**
 * Delete the demo customer's orders left behind by previous e2e runs and
 * restore their stock reservations (sql/reset-demo-orders.sql) — checkout's
 * 3-orders/hour velocity gate counts rows, so without this back-to-back local
 * runs 429 at checkout. CI databases are fresh; there it's a no-op.
 */
function resetDemoOrders(): void {
  runSqlFile("reset-demo-orders.sql", "reset previous e2e orders");
}

export default async function globalSetup(): Promise<void> {
  await waitForHttp("API", `${API_URL}/healthz`, 120_000);
  await waitForHttp("web (customer PWA)", `${WEB_URL}/login`, 180_000);
  await waitForHttp("ops console", `${OPS_URL}/login`, 180_000);

  openStoreAllHours();
  resetDemoOrders();
  await waitForStoreOpen(90_000);

  await prewarm([
    `${WEB_URL}/login`,
    `${WEB_URL}/shop`,
    `${WEB_URL}/p/vicks-vaporub-50ml`,
    `${WEB_URL}/cart`,
    `${WEB_URL}/checkout`,
    `${WEB_URL}/orders`,
    `${WEB_URL}/orders/prewarm`, // compiles the dynamic orders/[id] route
    `${OPS_URL}/login`,
    `${OPS_URL}/orders`,
    `${OPS_URL}/orders/prewarm`, // compiles the ops orders/[id] route (rx spec)
  ]);
}
