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

### Remaining code items (subsequent commits)
- **Sentry on web/ops/driver** — `@sentry/nextjs` (web, ops) + `@sentry/react-native` (driver); DSN-gated,
  no-op without `NEXT_PUBLIC_SENTRY_DSN`. Driver needs an EAS rebuild (defer with the Phase-6 push follow-up).
- **Backup cron** — pg-boss nightly `db-backup` job: `pg_dump | gzip | gpg --symmetric` (BACKUP_GPG_PASSPHRASE)
  → private R2; config-stub no-op when R2/pg_dump absent. Plus `docs/runbooks/restore.md` (the restore drill).
- **k6 load script** — `backend/api/scripts/load/checkout.js`: 50 concurrent COD checkouts, p95 thresholds.
- **Security pass** — adversarial review of the authz + money paths (state machine, wallet TX, webhook
  idempotency, RBAC, ownership, refund/restock) — run before launch, fix P0/P1.
- **CI** — ensure `ci.yml` runs lint/typecheck/test/build + `pnpm audit` + frozen-lockfile (§22.1).

## Operational (operator-executed — tracked, not built)
Play Store listing + staged rollout; real catalog seed with pharmacist (remove dev seed); ≥3 verified drivers
+ test payout; restore-drill execution; external accounts/DSNs (Sentry, Better Stack, R2, Razorpay LIVE,
Firebase, Ola); Cloudflare WAF/rate rules; domain + TLS; store kill-switch drill; soft-launch monitoring.

## Verify (per code item)
- turbo `typecheck` + `lint` + `build` (api, web, ops) clean; `pnpm --filter @medrush/api test` green.
- Boots with NO new env (all stubs no-op); Sentry/backup activate only when their keys are set.
- Live: server starts, `/healthz` 200, `/v1/auth/sync` 429s after 20/min (done); web builds with the new routes.
