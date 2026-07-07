# Phase 0 — Engineering Conventions (binding for all agents)

Master spec: `docs/BLUEPRINT.md` (frozen; §6–§9 are contracts). This brief pins the
mechanical decisions so independently-built packages compose. Do not deviate.

## Workspace map

| Path | Package name | Purpose |
|---|---|---|
| `packages/contracts` | `@medrush/contracts` | ★ single source of truth: enums, Zod schemas, socket events, error codes |
| `packages/config` | `@medrush/config` | eslint flat preset, prettier config, tsconfig bases, tailwind preset |
| `packages/ui` | `@medrush/ui` | shared web components (Phase 3+; stub now) |
| `backend/api` | `@medrush/api` | Fastify 5 + Prisma 6 + Socket.io + pg-boss (private) |

Workspace deps use `"workspace:*"`.

## Module system & TypeScript

- ESM everywhere: `"type": "module"` in every package.json.
- TS strict. Target `ES2022`, `module: ESNext`, `moduleResolution: Bundler`,
  `verbatimModuleSyntax: true` — extensionless relative imports are fine (tsup/tsx/vitest).
- tsconfig bases live at `@medrush/config/tsconfig/{base,library,node}.json`
  (config package has NO `exports` field so JSON is reachable). Packages extend them
  with a relative path fallback allowed: `"extends": "../config/tsconfig/library.json"`
  style is NOT used — always `"@medrush/config/tsconfig/library.json"`.
- Builds: `tsup` (`dist/`, esm, dts, sourcemap, clean). Dev runner for api: `tsx watch src/server.ts`.
- `@medrush/contracts` package.json: `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`,
  `"sideEffects": false`. Apps import ONLY from the root barrel `@medrush/contracts`.

## Pinned dependency ranges

typescript `^5.8` · zod `^4.1` · fastify `^5.6` · fastify-type-provider-zod `^6`
· @fastify/helmet `^13` · @fastify/cors `^11` · @fastify/rate-limit `^10`
· @fastify/swagger `^9` · @fastify/swagger-ui `^5` · prisma + @prisma/client `^6`
· pg-boss `^10` · pino `^9` · pino-pretty `^13` (dev) · socket.io `^4.8`
· tsup `^8` · tsx `^4` · vitest `^3` · eslint `^9` · typescript-eslint `^8` · prettier `^3`.

Zod v4 note: import as `import { z } from "zod"` (v4 API: `z.iso.datetime()`, `z.email()`, etc.).

## Scripts contract (every package defines what applies)

`build` (tsup) · `dev` · `typecheck` (`tsc --noEmit`) · `lint` (`eslint .`) · `test` (`vitest run`).
backend/api additionally: `db:migrate` (`prisma migrate dev`), `db:deploy`, `db:seed` (`tsx prisma/seed.ts`), `db:studio`.

## Domain conventions (from BLUEPRINT §6–§7 — verbatim rules)

- Money = integer paise (`z.number().int()`), quantities int, distance meters int. No floats near money.
- Timestamps in API payloads: ISO-8601 UTC strings (`z.iso.datetime()`).
- IDs: cuid strings — validate as `z.string().min(1)` (do not over-pin cuid format).
- Phone: E.164, `z.string().regex(/^\+[1-9]\d{7,14}$/)`.
- Envelope: success `{ data, meta? }`, error `{ error: { code, message, details? } }`.
- Pagination: query `?cursor=<id>&limit=20` (limit 1–50 default 20), response `meta: { nextCursor: string | null }`.
- Error codes (single source in `contracts/src/errors.ts`, used by API error handler):
  `VALIDATION_ERROR, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, STOCK_INSUFFICIENT,
  OFFER_TAKEN, INVALID_TRANSITION, STORE_CLOSED, OUT_OF_SERVICE_AREA, MIN_ORDER_NOT_MET,
  COD_LIMIT_EXCEEDED, COD_DISABLED, COUPON_INVALID, RX_REQUIRED, OTP_INVALID, OTP_LOCKED,
  IDEMPOTENCY_CONFLICT, RATE_LIMITED, UPGRADE_REQUIRED, PAYMENT_FAILED, STORE_CONFIG_MISSING,
  INTERNAL`.
- Prisma enums are mirrored in `contracts/src/enums.ts` as `const` objects + `z.enum`
  (contracts must NOT import from @prisma/client — it is the client-facing package).

## API skeleton conventions (backend/api)

- `src/core/config.ts`: Zod-parsed `process.env` (§26 keys). In `development`/`test`,
  third-party keys optional; in `production` all required — boot fails loudly.
- `src/core/logger.ts`: pino; redact paths: `req.headers.authorization`, `*.token`, `*.phone`,
  `*.addressSnapshot`, `*.otp`.
- Error handler maps `AppError(code, message, statusCode, details?)` → envelope; Zod/Fastify
  validation errors → 400 `VALIDATION_ERROR`.
- Route registration: modules export `FastifyPluginAsync`, registered under `/v1` prefix
  (health endpoints `/healthz`, `/readyz` unprefixed).
- Auth: Phase 0 stub only — `plugins/auth.ts` decorates `request.auth = null`, reads route
  `config: { public?: boolean; roles?: Role[] }`; real Firebase verify lands Phase 1 behind
  the same interface.
- Swagger UI at `/docs` only when `NODE_ENV !== "production"`.
- Graceful shutdown per §11: SIGTERM → readyz 503 → `server.close()` → boss stop → prisma disconnect.

## Style

Prettier: default config + `printWidth: 100`. ESLint 9 flat config from
`@medrush/config/eslint` (typescript-eslint recommended, no type-aware rules in Phase 0).
No `console.log` in api src (use logger); tests exempt.
