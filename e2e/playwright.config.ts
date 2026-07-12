import * as path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./stack";

/**
 * MedRush golden-path e2e (the CI job BLUEPRINT §22.1 promised "when the web
 * app lands"). Run from the repo root with `pnpm e2e`.
 *
 * There are deliberately NO `webServer` entries: the stack is three long-lived
 * dev servers (tsx-watch API + two `next dev` apps) spawned through pnpm shims,
 * and tearing that tree down from Playwright is unreliable on Windows (orphaned
 * node children keep the ports). The runner starts the stack first instead —
 * locally:
 *
 *   pnpm --filter @medrush/api dev    # API      http://localhost:4000
 *   pnpm --filter @medrush/web dev    # customer http://localhost:3000
 *   pnpm --filter @medrush/ops dev    # ops      http://localhost:3001
 *
 * against a migrated + seeded dev DB (`pnpm db:migrate && pnpm db:seed`); in CI
 * the e2e job in .github/workflows/ci.yml does the same. DEV servers on
 * purpose: production builds tree-shake the dev-token login the spec drives.
 * global-setup.ts waits for all three, forces the seeded store open 24×7 and
 * pre-warms routes (first `next dev` compiles are slow).
 */
export default defineConfig({
  testDir: __dirname,
  outputDir: path.join(__dirname, "test-results"),
  globalSetup: "./global-setup",

  // One worker, no parallelism: the two tests are a serial story (the ops test
  // asserts on the order the customer test placed) sharing one seeded DB.
  fullyParallel: false,
  workers: 1,
  retries: 1, // a serial group retries as a whole — a fresh order each attempt
  forbidOnly: Boolean(process.env.CI),

  timeout: 120_000, // whole customer journey incl. leftover dev-compile stalls
  expect: { timeout: 20_000 },

  reporter: process.env.CI
    ? [["list"], ["github"]]
    : [["list"], ["html", { outputFolder: path.join(__dirname, "playwright-report"), open: "never" }]],

  use: {
    baseURL: WEB_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000, // first hit on a `next dev` route compiles it
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
