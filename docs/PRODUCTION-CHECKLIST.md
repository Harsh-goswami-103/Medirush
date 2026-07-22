# Production Launch Checklist (Blueprint §24)

Status legend: ✅ done · 🟡 code-complete, needs a production key/account · ⬜ operator action (human/ops) · ▫️ not started

Updated 2026-07-13 (Phase 7.5 — post-audit hardening wave; 70-finding production-readiness audit driven to code-complete).

## Auth (P0 found by the audit — was missing entirely)
- ✅ **Firebase phone-OTP login built on all three surfaces** (was: dev-token-only everywhere — a launch-blocking outage). Web + ops: firebase JS SDK (invisible reCAPTCHA, hourly token refresh via `onIdTokenChanged`, 401→force-refresh-once retry, socket reconnects use the fresh token); driver: `@react-native-firebase/auth` (lazy-loaded; activates on next EAS build) + expo-secure-store token storage. Dev logins exist ONLY in dev builds — verified tree-shaken from production bundles.
- ⬜ Operator: Firebase project — enable the **Phone** provider, add prod domains to authorized domains (web/ops reCAPTCHA), set the four `NEXT_PUBLIC_FIREBASE_*` at Vercel build time, register the EAS keystore **SHA-1 + SHA-256** in the Firebase Android app, deliver `google-services.json` via an EAS file env (gitignored; plugins auto-enable when present), and set backend `FIREBASE_*` to the SAME project.
- ⬜ Operator: first-admin bootstrap — prod DB must carry NO seed users; create the first ADMIN by phone after their first OTP sign-in (`docs/runbooks/deploy.md` §launch sequence). Role changes are ADMIN-gated (chicken-and-egg).

## Infra / Env
- 🟡 **Deploy path now exists in-repo** (was: nothing): `Dockerfile` (multi-stage; runtime installs postgresql-client-16 + gnupg so the backup cron works), `railway.json` (healthcheck `/readyz`, pre-deploy `prisma migrate deploy`), `start` script, `docs/runbooks/deploy.md` (sequenced launch plan with lead times + env inventory). ⚠️ Image is code-complete but **unexercised** (no Docker locally) — the first Railway deploy validates it. ⬜ provision Railway prod service + PG.
- ⬜ Custom domains + TLS (api/app/ops)
- ⬜ Cloudflare proxy + WAF ON, origin locked, edge rate rule `/v1/auth/*` 20/min, `ops.*` geo-IN, WS passthrough. Then set `RATE_LIMIT_TRUST_CF_HEADER=true` + `TRUST_PROXY_HOPS=2`.
- 🟡 All env vars set & validated at boot — backend fails loudly; **web/ops/driver now fail loudly too** (prod builds throw on missing `NEXT_PUBLIC_API_URL` / `EXPO_PUBLIC_API_URL`; eas.json carries REPLACE-BEFORE-BUILD placeholders).
- ✅ Prisma `migrate deploy` clean (4 migrations)
- ✅ pg-boss crons registered (stuck-order, payment-timeout, invoice, offer-expiry, notification-fanout, db-backup, drift-audit, **data-prune**) — all wrapped with logging + Sentry capture on failure
- 🟡 Feature-flag defaults reviewed (risky = OFF) — *AppSetting flags exist; review at launch*

## Payments
- ⬜ Razorpay LIVE keys · webhook URL + secret + test event · LIVE refund test · COD limit — start KYC FIRST (longest lead)
- ✅ **Refund races closed** (audit P1/P2): late `payment.captured` on a CANCELLED order now auto-refunds (replay-safe); `initiateRefund` claims state BEFORE the external call and reverts on failure; a watchdog sweep re-drives refund claims orphaned by a crash. All failure paths page `MANUAL_REFUND_REQUIRED` (durable alert + Sentry). On-call must know the manual dashboard-refund procedure — `refund.processed` then auto-completes state.
- ✅ Razorpay/S3/Firebase outbound calls now carry deadlines (10s/10s/5s); Razorpay outage surfaces as 503 `PAYMENT_UNAVAILABLE` with friendly retry copy in checkout; 30s request-timeout backstop.

## Security
- ✅ CORS allowlist (prod origins; native apps allowed)
- ✅ Rate limits on — **spoofable-XFF hole closed** (`TRUST_PROXY_HOPS`, default 1 in prod; optional CF-Connecting-IP keying)
- ✅ Helmet/CSP (CSP enforced in prod)
- ✅ Webhook signature verification + replay-idempotency (tested)
- ✅ Presigned Rx URLs expire (short-lived GET)
- ⬜ Admin accounts limited & audited — AuditLog written **and now readable**: `GET /v1/admin/audit-log` (paginated, filterable); provision real admins
- ✅ CI security job (audit + frozen lockfile + SHA-pinned actions + Renovate) — **security job now gates the build end-state** — ⬜ GitHub secret-scanning + branch-protection toggles (operator)
- ✅ Fraud rules — **velocity/COD-cap TOCTOU closed** (in-tx `FOR UPDATE` re-checks, alert fires on burst path too); **codRefusalCount now wired** (ops cancel `codRefused` flag, COD + out-for-delivery only)
- ✅ 426 app-version gate (tested; driver `x-app-version` now derives from app config — single source of truth, v1.0.0)
- ✅ Security pass done (3 findings fixed + regression tests — the socket driver-verify regression test now actually exists)
- ✅ Delivery-OTP attempts persisted on the Order (was in-memory; restart no longer resets the brute-force budget); ops **Reset OTP attempts** action for locked doorsteps
- 🟡 Sentry all surfaces wired + **release tags + browser source maps**; activate with DSNs at deploy

## Data
- 🟡 Nightly backup: pipeline + restore runbook + **runtime image ships pg_dump/gpg** + **failure now pages** (`DB_BACKUP_FAILED` alert + Sentry) + optional heartbeat (`BACKUP_HEARTBEAT_URL`) + retention prune (`BACKUP_RETENTION_DAYS`, default 60) + optional **dedicated backup bucket/creds** (`BACKUP_R2_*`) — ⬜ run the restore drill + set `BACKUP_GPG_PASSPHRASE`/R2 creds (operator)
- ⬜ R2 versioning on (verify R2's S3-compat versioning before relying on it)
- ✅ Housekeeping prune cron (IdempotencyKey >7d, read notifications >90d; PaymentEvent never pruned)
- ✅ FK indexes on hot child tables (OrderItem, ItemBatchAlloc, Prescription, Delivery)
- 🟡 Real-catalog loader ready — ⬜ operator: pharmacist CSV, run it, remove dev seed. **Seed is now guarded**: refuses non-localhost DB (`SEED_FORCE_DESTRUCTIVE=yes` to override) and always refuses `NODE_ENV=production`.
- ✅ **DPDP erasure path** (was: privacy page promised rights no code could fulfil): `POST /v1/admin/users/:id/anonymize` (statutory retention honored — orders/invoices/Rx kept; PII scrubbed, uniques tombstoned, sessions killed) + `docs/runbooks/data-erasure.md` — ⬜ operator: fill grievance-officer + retention-period placeholders (align privacy page copy: erasure = anonymization with statutory retention)

## Compliance
- 🟡 Drug Licence / Pharmacist / FSSAI / GSTIN in StoreConfig → invoice renders them ✅; footer/legal page 🟡 (`/legal`, operator fills placeholders)
- 🟡 Privacy policy (DPDP) + T&C live — `[OPERATOR: …]` placeholders remain
- ✅ Rx-gate tested (cannot pack an unapproved Rx order)
- ✅ H1 register export verified
- ✅ Invoice numbering FY counter correct
- ⬜ Fridge-temperature register live (≥2 logs) — record at launch

## Dispatch (audit P1 — dead-end closed)
- ✅ Ops can now recover any dispatch dead-end from the order page: **manual assign** (driver picker for ADMIN), **re-dispatch** (clears stale offers, restarts wave 1), **un-assign pre-pickup** (optionally auto-redispatching). All audited + driver notified (socket/push/durable notification).

## Apps
- ⬜ Play listing (screenshots, **data-safety now incl. BACKGROUND location** + foreground-service disclosure video) · staged rollout
- ✅ **EAS OTA channel wired** (expo-updates; `preview`/`production` channels, runtimeVersion=appVersion — bump the app version on any native change before publishing an update)
- ✅ **PWA installable**: manifest icons (any+maskable) + favicon + apple-touch-icon + offline fallback + production service worker (never caches `/v1/` or authed requests)
- ✅ Error boundaries on all three apps (branded retry + Sentry capture; was: white screen)
- ✅ **Retry-payment flow**: a dismissed Razorpay sheet no longer strands the order — "Complete payment" + auto-cancel countdown on the order page
- 🟡 **Driver background location + FCM push registration built** (foreground service during active deliveries, graceful permission-denial banner, native FCM token → `POST /v1/devices`) — activates on next EAS build with google-services.json; until then brief drivers: keep the app open while on delivery (SOP)

## Observability
- ✅ **Ops alerts are durable** (was: fire-and-forget socket toast): every alert persists an `OpsAlert` row; critical kinds (WALLET_DRIFT, DB_BACKUP_FAILED, STUCK_ORDER, MANUAL_REFUND_REQUIRED, UNASSIGNED_ORDER, FRAUD_VELOCITY) also page via Sentry; ops console has an **/alerts inbox** with unacked badge + live updates
- ✅ Watchdog blindspots closed: PENDING_PAYMENT (auto-expires + releases stock), PACKING >20m, RX_REVIEW >45m, ASSIGNED-no-pickup >15m, orphaned refund claims
- ✅ All pg-boss worker failures log + reach Sentry (queue-tagged) — was silent
- 🟡 Sentry DSNs all surfaces + release tags — set 4 DSNs at deploy (backend refuses to boot without its DSN)
- 🟡 **Uptime self-check cron now in-repo** (was: nothing watching `/readyz`): a 5-minute pg-boss job GETs a health URL (10s deadline), logs status + response time, and on failure POSTs a Slack-compatible `{ text }` alert **and** captures to Sentry. Alert fatigue is bounded — it pages on entering failure, then only every 6th consecutive failure (~30 min), plus one recovery line. Never throws out of the worker. Config-gated: no webhook → not scheduled (dev/CI silent).
  - `UPTIME_ALERT_WEBHOOK_URL` (optional) — Slack/Google-Chat-style incoming webhook. **Setting it is what enables the job.**
  - `UPTIME_CHECK_URL` (optional) — defaults to the local `http://127.0.0.1:<PORT>/readyz`. Leave it defaulted to catch a process that is up but not READY; point it at the public API URL to also cover DNS/TLS/Cloudflare.
  - ⬜ Operator: create the webhook (Slack channel or WhatsApp/phone bridge), set it on the Railway service, and **still** provision the EXTERNAL probe (Better Stack on the public `/readyz` + phone escalation) — a dead process cannot alert about itself. `BACKUP_HEARTBEAT_URL` remains the backup dead-man's-switch. Test-fire both after the first deploy.
- ✅ Stuck-order watchdog (alert path implemented + durable) — ⬜ test-fire in prod
- ✅ Support codes: `x-request-id` shown on web checkout/order error toasts

## Testing
- ✅ 298 backend tests green (was 185 pre-audit; +refund races, fraud TOCTOU, dispatch ops, OTP durability, shutdown, alerts, anonymize, audit-log, sweeps, proxy-trust, timeouts)
- ✅ Playwright golden-path e2e (browse → COD checkout → ops board) + non-blocking CI job — *see `e2e/`*
- 🟡 k6 load script ready — needs the staging env (run in stub-auth mode; documented)
- ⬜ Staging environment (one scratch Railway env doubles as k6 target + restore/rollback drill ground)

## Ops readiness / Day-1
- ⬜ Pharmacist trained (SOP dry-run ×3) · ≥3 drivers verified + test-paid · kill-switch drill · support number live (`NEXT_PUBLIC_SUPPORT_PHONE` — CTAs hidden until set) · runbooks (deploy/restore/rollback/erasure/razorpay-outage/key-rotation — drill placeholders to fill)
- ⬜ Soft-launch radius 3km · founder monitors ops room · first-10-orders QA · 48h retro

---
**Summary:** after the Phase-7.5 audit-driven hardening wave, every code item from the 70-finding production audit is
closed or code-complete: real auth on all surfaces, an in-repo deploy path, durable+paging alerts, refund/dispatch/fraud
race closures, DPDP erasure, PWA installability, driver OTA/background-location/push, error boundaries, and e2e coverage.
What remains is exclusively operator work: accounts/keys (Razorpay LIVE, Firebase, Sentry, R2, Better Stack, domains,
Cloudflare), the first Railway deploy (validates the unexercised Docker image), the restore drill, Play listing, catalog
+ staff provisioning, and the soft launch itself — sequenced in `docs/runbooks/deploy.md`.
