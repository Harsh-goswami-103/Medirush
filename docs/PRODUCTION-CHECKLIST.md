# Production Launch Checklist (Blueprint §24)

Status legend: ✅ done · 🟡 code-complete, needs a production key/account · ⬜ operator action (human/ops) · ▫️ not started

Updated 2026-07-12 (Phase 7 in progress).

## Infra / Env
- ⬜ Railway prod service + PG, `/readyz` deploy gating — *code ready (`/readyz` implemented); provision needed*
- ⬜ Custom domains + TLS (api/app/ops)
- ⬜ Cloudflare proxy + WAF ON, origin locked, edge rate rule `/v1/auth/*` 20/min, `ops.*` geo-IN, WS passthrough
- 🟡 All env vars set & validated at boot — *`config.ts` fails loudly on missing prod keys; fill at deploy*
- ✅ Prisma `migrate deploy` clean (3 migrations)
- ✅ pg-boss crons registered (stuck-order, payment-timeout, invoice, offer-expiry, notification-fanout, **db-backup**, **drift-audit**)
- 🟡 Feature-flag defaults reviewed (risky = OFF) — *AppSetting flags exist; review at launch*

## Payments
- ⬜ Razorpay LIVE keys · webhook URL + secret + test event · LIVE refund test · COD limit — *code + webhook idempotency done + tested with stub; LIVE keys needed*

## Security
- ✅ CORS allowlist (prod origins; native apps allowed)
- ✅ Rate limits on (global 100/min + `/auth/sync` 20/min, verified live)
- ✅ Helmet/CSP (CSP enforced in prod)
- ✅ Webhook signature verification + replay-idempotency (tested)
- ✅ Presigned Rx URLs expire (short-lived GET)
- ⬜ Admin accounts limited & audited — *AuditLog written; provision real admins*
- ✅ CI security job (`pnpm audit --prod --audit-level=high` + frozen-lockfile + SHA-pinned actions + `pnpm.onlyBuiltDependencies` allowlist + **Renovate** weekly PRs/digest-pinning) — ⬜ GitHub secret-scanning toggle (operator)
- 🟡 Fraud rules (COD refusal, velocity, new-account cap) — *present; velocity/COD-cap are TOCTOU under burst (documented follow-up)*
- ✅ 426 app-version gate (tested)
- ✅ **Security pass done** — adversarial review of authz/money/state paths; 3 findings fixed (P0 ops-cancel refund, P1 markReady FEFO-expiry, P2 socket driver-verify) + regression tests; core surface verified strong
- 🟡 Sentry backend + web + ops (DSN-gated, no-op without key) — ⬜ driver Sentry pending (EAS rebuild)

## Data
- 🟡 Nightly backup job DONE (config-gated `pg_dump|gzip|gpg`→R2) + restore runbook DONE (`docs/runbooks/restore.md`) — ⬜ **run the restore drill** + set BACKUP_GPG_PASSPHRASE/R2 creds (operator)
- ⬜ R2 versioning on
- ⬜ Seed removed / real catalog loaded (prices, GST, HSN, Rx flags reviewed by pharmacist)

## Compliance
- 🟡 Drug Licence / Pharmacist / FSSAI / GSTIN in StoreConfig → invoice renders them ✅; **footer/legal page** 🟡 (`/legal`, operator fills placeholders)
- 🟡 Privacy policy (DPDP) + T&C live — *`/privacy`, `/terms` built with `[OPERATOR: …]` placeholders*
- ✅ Rx-gate tested (cannot pack an unapproved Rx order)
- ✅ H1 register export verified
- ✅ Invoice numbering FY counter correct
- ⬜ Fridge-temperature register live (≥2 logs) — *TempLog model + ops flow exist; record at launch*

## Apps
- ⬜ Play listing (screenshots, data-safety incl. location) · staged rollout · EAS OTA channel — *driver app built + device-verified*
- 🟡 PWA installability (manifest/icons/offline) — *manifest exists; icons + offline SW = Phase 4/6 polish follow-up*

## Observability
- 🟡 Sentry DSNs all surfaces, release tags — *backend + web + ops wired (DSN-gated); driver pending (EAS rebuild)*
- ⬜ Uptime monitor + alert channel (Better Stack / WhatsApp)
- ✅ Stuck-order watchdog (alert path implemented) — ⬜ test-fire in prod

## Ops readiness / Day-1
- ⬜ Pharmacist trained (SOP dry-run ×3) · ≥3 drivers verified + test-paid · kill-switch drill · support number live · runbooks
- ⬜ Soft-launch radius 3km · founder monitors ops room · first-10-orders QA · 48h retro

---
**Summary:** the platform's *code* is launch-hardened (auth/money/authz paths tested, rate limits + helmet +
webhook-idempotency + Rx-gate + 426 verified, Sentry backend wired). The open items are (a) a handful of
remaining code tasks (backup job + runbook, web/ops Sentry, k6, security pass, CI security job) and (b)
operator actions requiring real accounts/keys and a pharmacist (catalog, drivers, Play Store, soft launch).
