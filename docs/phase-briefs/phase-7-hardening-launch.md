# Phase 7 — Hardening & launch

Binding brief. Blueprint: §23 Phase 7, §24 Production Launch Checklist, §5 (infra/WAF/rate rules),
§10 (security), §11 (shutdown/backup), §22 (CI/CD). Depends: P0–P6 (all feature work complete).

**DoD:** soft launch — 10 friendly-user orders delivered, zero Sev-1. Concretely, every §24 box is either
ticked or has a code-complete implementation waiting only on a production key/account. Nothing that CAN be
built and verified locally is left unbuilt.

This phase is **part code, part operational**. Code items are built here with the project's config-stub
posture (real keys wired at deploy). Operational items (Play Store, real catalog with pharmacist, restore
drill, soft launch) are the operator's to execute — tracked in `docs/PRODUCTION-CHECKLIST.md`.

## Already in place (earlier phases — do NOT rebuild)
- `@fastify/helmet` (CSP on in prod), `@fastify/cors` (origin allowlist, native apps allowed), global
  `@fastify/rate-limit` 100/min, multipart 5MB cap — all in `backend/api/src/app.ts`.
- Graceful shutdown (§11), `/healthz` + `/readyz` (DB ping + boss + drain), request-id, 426 app-version gate.
- Invoices already render StoreConfig statutory fields (drug licence / pharmacist / GSTIN / FSSAI).
- pg-boss cron infra (stuck-order, payment-timeout, invoice, offer-expiry, notification-fanout).

## Code work

### Security hardening — DONE (this commit)
- **Sentry (`core/sentry.ts`)** — config-selected no-op (mirrors Razorpay/R2): `initSentry()` at process
  start (no-op unless `SENTRY_DSN`), `captureException()` wired into the 5xx branch of the error handler and
  the `uncaughtException` / `unhandledRejection` crash hooks, `flushSentry()` on graceful shutdown.
- **Tuned rate limit** — `/v1/auth/sync` dropped to 20/min (login-abuse vector, defense-in-depth behind the
  Cloudflare edge rule §5). Pattern: per-route `config.rateLimit`. Verified live (20×200 → 429).
- Helmet CSP already enforced in prod; webhook route stays rate-limit-exempt (Razorpay retries).

### Legal & compliance pages (customer PWA) — DONE (this commit)
- `/privacy` (DPDP Act 2023-aligned), `/terms`, `/legal` (statutory identifiers) with `[OPERATOR: …]`
  placeholders for anything the business must supply; linked from Account. No fabricated licence data.

### Sentry on web + ops — DONE (commit 60bd6f7)
- `@sentry/nextjs` via Next's native `instrumentation.ts` + `instrumentation-client.ts` (no `withSentryConfig`
  webpack plugin — build pipeline untouched). DSN-gated no-op; Session Replay off (health data). Driver
  Sentry (`@sentry/react-native`) deferred — needs an EAS rebuild (bundle with the Phase-6 push follow-up).

### k6 load script — DONE (commit dddbcf7)
- `backend/api/scripts/load/checkout.js`: 50 concurrent COD checkouts, p95/error thresholds. Not run in CI
  (needs the k6 binary + a staging target).

### Security pass — DONE (this commit)
Adversarial read-only review of the authz + money + state/stock/concurrency surfaces (3 focused agents).
**Verdict: strong** — IDOR closed everywhere (owner-scoped, 404-not-403), no role escalation/mass-assignment,
webhook idempotency + oversell + double-delivery/assign + wallet-credit-once + payout invariants all sound.
**3 findings fixed** (+ regression tests): P0 — `opsCancel` never refunded a PAID prepaid order (added
`initiateRefund`); P1 — `markReady` skipped the FEFO expiry check (now re-enforced at commit); P2 — socket
handshake granted `driverProfileId` to an unverified driver (now verified-only). Documented-not-fixed (latent/
edge, rationale in commit): capture-vs-cancel manual-refund race, refund-before-guard reorder hardening,
velocity/COD-cap TOCTOU under burst, unwired ASSIGNED→READY edge.

### CI security job — DONE (this commit)
`.github/workflows/ci.yml` already existed from Phase 0 (quality / security[`pnpm audit --prod
--audit-level=high`] / test[postgres:16 + migrate] / build; actions SHA-pinned; least-privilege
`permissions`). The `pnpm.onlyBuiltDependencies` postinstall allowlist (prisma/esbuild/sharp/@prisma/*)
already existed too. Closed the §22.1 gap by adding **`renovate.json`** — weekly dependency PRs, grouped
non-major, GitHub-Action **digest pinning** (upholds the SHA policy), lockfile maintenance, vulnerability
alerts. Secret-scanning = a GitHub repo toggle (operator; a self-hosted scanner isn't added because it
couldn't be SHA-pinned without violating our own §10.5 policy).

### Backup cron + restore runbook — DONE (this commit)
`backend/api/src/jobs/dbBackup.ts` — pg-boss nightly `db-backup` (02:00 IST): `pg_dump | gzip |
gpg --symmetric AES-256` → private R2 (`backups/medrush-<iso>.sql.gz.gpg`), reusing `putPrivateObject`.
Config-selected no-op via `isBackupConfigured` (needs BACKUP_GPG_PASSPHRASE + all R2 creds) — dev/CI spawn
nothing. Registered in `core/jobs.ts`; verified live (server logs "db-backup scheduled"). Gating unit-tested
(183 tests). `docs/runbooks/restore.md` documents the download→decrypt→restore + the monthly restore drill
(the pipeline itself is operator-verified there — the portable PG here has no `pg_dump`/`gpg`).

### Remaining code items
- **drift-audit cron** (wallet/stock reconciliation alert, §24) — small follow-up.
- **Driver Sentry** (`@sentry/react-native`) — needs an EAS rebuild (with the Phase-6 push follow-up).

## Operational (operator-executed — tracked, not built)
Play Store listing + staged rollout; real catalog seed with pharmacist (remove dev seed); ≥3 verified drivers
+ test payout; restore-drill execution; external accounts/DSNs (Sentry, Better Stack, R2, Razorpay LIVE,
Firebase, Ola); Cloudflare WAF/rate rules; domain + TLS; store kill-switch drill; soft-launch monitoring.

## Verify (per code item)
- turbo `typecheck` + `lint` + `build` (api, web, ops) clean; `pnpm --filter @medrush/api test` green.
- Boots with NO new env (all stubs no-op); Sentry/backup activate only when their keys are set.
- Live: server starts, `/healthz` 200, `/v1/auth/sync` 429s after 20/min (done); web builds with the new routes.
