/**
 * Where the golden-path stack lives. The runner (a developer shell or
 * .github/workflows/ci.yml) starts these BEFORE `pnpm e2e` — see
 * playwright.config.ts for why there are no `webServer` entries.
 */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const OPS_URL = process.env.E2E_OPS_URL ?? "http://localhost:3001";

/**
 * Backend dev bearer for the seeded demo customer (`dev:<firebaseUid>:<phone>`,
 * accepted only when the API has no Firebase config and is not production —
 * backend/api/src/plugins/auth.ts). Used for test-data cleanup only; the spec
 * itself signs in through the UI like a real user.
 */
export const DEMO_CUSTOMER_TOKEN = "dev:seed-firebase-customer:+919876543210";
