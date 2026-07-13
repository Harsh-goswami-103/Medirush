# Runbook — First deploy & launch sequence

**Source:** BLUEPRINT §3.6 (deployment flow), §5 (infrastructure), §16 (backup/DR), §22 (CI/CD),
§24 (launch checklist). Companion to `docs/PRODUCTION-CHECKLIST.md` — this is the *how/in-what-order*;
the checklist is the *what*.

> ⚠️ **Honesty note:** `Dockerfile` + `railway.json` are code-complete but **unexercised** — the dev
> machine has no Docker, so the image has never been built. The first Railway deploy is their
> validation run; budget time to iterate on build errors there. What IS verified locally:
> `pnpm --filter @medrush/api build` then `node dist/server.js` boots against a real PG and serves
> `/healthz` + `/readyz` 200.

## Topology (§3.6, §5)

| Surface | Host | Config |
|---|---|---|
| API + workers (one service) | Railway, Dockerfile builder | `railway.json` at repo root |
| PostgreSQL 16 | Railway managed PG | private networking, `connection_limit=10` |
| Customer PWA | Vercel — `medrush.in` | root directory `frontend/web` |
| Ops/Admin | Vercel — `ops.medrush.in` | root directory `frontend/ops` |
| Edge (DNS/CDN/WAF) | Cloudflare, proxied, in front of all three | §5 row "DNS/CDN + Edge WAF" |
| Driver app | EAS build → Play Console | `frontend/driver/eas.json` |
| Objects | Cloudflare R2 (`medrush-public`, `medrush-private`) | versioning ON |

**Ordering constraints (chicken-and-egg):** Razorpay LIVE KYC and Play Console verification are the
longest leads — start first. The **domain** must exist before: Razorpay webhook URL, Vercel prod
domains, and the **production driver build** (`EXPO_PUBLIC_API_URL` is baked in at EAS build time —
the live API domain must resolve FIRST). The Play listing needs the privacy policy URL live → web
deploy precedes Play submission.

---

## Phase A — long-lead items (start 4–6 weeks out)

- [ ] **Razorpay LIVE KYC** — business verification (drug licence, GSTIN, bank a/c) takes weeks.
      Until approved you only have TEST keys; everything else can proceed in parallel.
- [ ] **Google Play Console** account (₹2,100 one-time) — identity/org verification takes days–weeks.
      Start collecting listing assets (screenshots, data-safety form incl. background location).
- [ ] Business docs ready: Drug Licence no., Pharmacist name/RegNo, FSSAI, GSTIN (Razorpay KYC +
      StoreConfig + invoice/compliance pages all need them).

## Phase B — domain & accounts (≈2 weeks out)

- [ ] Buy `medrush.in` → add zone to **Cloudflare**, switch nameservers.
- [ ] **Railway** account + project (region: Singapore, §5).
- [ ] **Vercel** account (two projects, Phase D).
- [ ] **Firebase**: project on **Blaze** (phone-OTP SMS is pay-per-use), enable **Phone** sign-in,
      create a service-account key (→ `FIREBASE_*` env vars).
- [ ] **Cloudflare R2**: buckets `medrush-public` + `medrush-private`, **versioning ON** (both),
      API token scoped to the two buckets (→ `R2_*` env vars). Public bucket: attach the CDN domain
      (→ `R2_PUBLIC_CDN_URL`).
- [ ] **Sentry**: 4 projects (api / web / ops / driver) → 4 DSNs.
- [ ] **Better Stack**: uptime monitor placeholder (point at `/readyz` once live) + alert channel.
- [ ] **Ola Maps** API key.
- [ ] Generate now and store in the password manager: `REVALIDATE_SECRET`, `BACKUP_GPG_PASSPHRASE`
      (restore depends on it — `restore.md`), and a **self-chosen** `RAZORPAY_WEBHOOK_SECRET`
      (Razorpay webhooks use an operator-chosen secret, so it can be set at first boot and pasted
      into the dashboard later — Phase E).

## Phase C — backend live on Railway

1. - [ ] Railway project → **add PostgreSQL 16** (managed).
2. - [ ] **New service from the GitHub repo** (`Harsh-goswami-103/Medirush`, branch `main`).
         `railway.json` at repo root is picked up automatically: DOCKERFILE builder, pre-deploy
         `npx prisma migrate deploy` (runs in the image's workdir `/app/backend/api`), health check
         `/readyz`, restart ON_FAILURE. First build validates the Dockerfile — iterate here.
3. - [ ] **Env vars** — set ALL of the table below before the first successful boot
         (`src/core/config.ts` fails loudly in production if any required key is missing):

   | Key | Value / source |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}?connection_limit=10` (private networking, §5) |
   | `NODE_ENV` | already `production` (baked into the image); setting it again is harmless |
   | `PORT` | injected by Railway automatically — do not hardcode |
   | `FIREBASE_PROJECT_ID` | Firebase service account |
   | `FIREBASE_CLIENT_EMAIL` | Firebase service account |
   | `FIREBASE_PRIVATE_KEY` | Firebase service account (paste multi-line key as-is in the raw editor) |
   | `RAZORPAY_KEY_ID` | LIVE key (TEST until KYC clears — swap before launch) |
   | `RAZORPAY_KEY_SECRET` | LIVE secret |
   | `RAZORPAY_WEBHOOK_SECRET` | the self-chosen secret from Phase B (dashboard gets it in Phase E) |
   | `R2_ACCOUNT_ID` | Cloudflare R2 |
   | `R2_ACCESS_KEY_ID` | R2 API token |
   | `R2_SECRET_ACCESS_KEY` | R2 API token |
   | `R2_PUBLIC_BUCKET` | `medrush-public` |
   | `R2_PRIVATE_BUCKET` | `medrush-private` |
   | `R2_PUBLIC_CDN_URL` | public bucket's CDN URL, e.g. `https://cdn.medrush.in` |
   | `OLA_MAPS_API_KEY` | Ola Maps console |
   | `SENTRY_DSN` | Sentry **api** project |
   | `REVALIDATE_SECRET` | random string from Phase B (reserved for the web ISR revalidate hook) |
   | `BACKUP_GPG_PASSPHRASE` | from Phase B — **losing it makes every backup unreadable** |
   | `WEB_ORIGIN` | `https://medrush.in` (CORS allowlist) |
   | `OPS_ORIGIN` | `https://ops.medrush.in` (CORS allowlist) |
   | `RESEND_API_KEY` | *optional* — email integration |

4. - [ ] **Deploy.** Watch: image builds → pre-deploy applies all migrations (4 at launch) →
         `/readyz` goes 200 (checks DB + migrations current + pg-boss started) → traffic cut over.
5. - [ ] Smoke on the `*.up.railway.app` domain: `GET /healthz` 200, `GET /readyz` 200,
         `GET /v1/store` returns store config; boot log shows all 8 workers registered
         (stuck-order watchdog, payment-timeout, invoice-pdf, offer-expiry, notification-fanout,
         db-backup, drift-audit, data-prune — `src/core/jobs.ts` is the authoritative list).
6. - [ ] **Cloudflare edge** (§5): DNS `api.medrush.in` → CNAME to the Railway domain, **proxied**;
         SSL/TLS mode **Full (strict)**; **WAF managed rules ON**; **Bot Fight Mode ON**;
         rate rule `/v1/auth/*` **20 req/min/IP**; **WebSockets ON** (Socket.io passthrough);
         `ops.medrush.in` **geo-restricted to IN**. Origin lock (Railway accepts Cloudflare ranges
         only): at minimum treat the `*.up.railway.app` URL as secret; harden with Cloudflare
         Authenticated Origin Pulls as a follow-up.
7. - [ ] Re-smoke via `https://api.medrush.in/readyz`.
8. - [ ] **Real catalog** (§24 Data): fill `backend/api/scripts/catalog.example.csv` with the
         pharmacist-reviewed catalog, then from the Railway service shell:
         `npx tsx scripts/seed-catalog.ts --file catalog.csv --dry-run` → review → rerun without
         `--dry-run`. Never run `prisma/seed.ts` (dev seed) in production.

## Phase D — web + ops on Vercel

- [ ] Two Vercel projects from the same repo — **Root Directory** `frontend/web` and `frontend/ops`
      (framework: Next.js; Vercel handles pnpm workspaces natively).
- [ ] Env vars — **web** (`medrush.in`): `NEXT_PUBLIC_API_URL=https://api.medrush.in`,
      `NEXT_PUBLIC_FIREBASE_API_KEY` (presence switches real Firebase auth on — without it the
      dev-login path renders; the remaining `NEXT_PUBLIC_FIREBASE_*` keys per `.env.example`),
      `NEXT_PUBLIC_RAZORPAY_KEY_ID` (LIVE), `NEXT_PUBLIC_OLA_MAPS_KEY`,
      `NEXT_PUBLIC_SENTRY_DSN` (web project), `NEXT_PUBLIC_SUPPORT_PHONE` (real support line —
      deliberately no code fallback: support/WhatsApp CTAs are hidden when unset).
- [ ] Env vars — **ops** (`ops.medrush.in`): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_FIREBASE_API_KEY`
      (+ other `NEXT_PUBLIC_FIREBASE_*`), `NEXT_PUBLIC_SENTRY_DSN` (ops project).
- [ ] Domains: `medrush.in` → web, `ops.medrush.in` → ops; Cloudflare DNS proxied, Full (strict).
- [ ] Verify: home page renders products (catalog live), login works (Firebase OTP), ops board
      loads behind geo-restriction, `/privacy` + `/terms` live (Play listing needs the URL).

## Phase E — Razorpay webhook (needs the domain)

- [ ] Dashboard → Webhooks → add `https://api.medrush.in/v1/webhooks/razorpay`, secret = the value
      already in Railway's `RAZORPAY_WEBHOOK_SECRET`. Events: payment.captured, payment.failed,
      refund.processed (per `src/modules/payments/webhook.ts`).
- [ ] Fire a test event → 200 in dashboard, `razorpay webhook` line in API logs.
- [ ] LIVE micro-transaction + LIVE refund test (§24 Payments); set the COD limit flag.

## Phase F — driver app via EAS (needs the LIVE API domain first)

- [ ] **Ordering:** `EXPO_PUBLIC_API_URL` is baked into the binary at build time — do NOT cut the
      production build until `https://api.medrush.in` is live (Phases C+E done).
- [ ] EAS env (production profile): `EXPO_PUBLIC_API_URL=https://api.medrush.in`,
      `EXPO_PUBLIC_SENTRY_DSN` (driver project) + `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT`
      for source maps (see `frontend/driver/README.md`).
- [ ] `eas build --profile production --platform android` → AAB.
- [ ] Play Console: internal testing track first (real drivers do a paid test delivery), then
      production with **staged rollout 20% → 100% over 48h** (§22.2). Listing needs screenshots +
      data-safety form (background location!) + the live privacy-policy URL.

## Phase G — drills & soft launch (operator, §24)

- [ ] **Restore drill** — after the first nightly backup lands in R2 (`backups/medrush-*.sql.gz.gpg`,
      02:00 IST), run `restore.md` end-to-end into a scratch DB. Backups are rumors until this passes.
- [ ] **Kill-switch drill** — `store-close-switch.md`.
- [ ] **Stuck-order watchdog** — test-fire the alert path in prod.
- [ ] Pharmacist SOP dry-run ×3 on the ops panel; ≥3 drivers verified + test-paid.
- [ ] Better Stack monitor live on `https://api.medrush.in/readyz` + alert channel test.
- [ ] Feature-flag defaults reviewed (risky = OFF); soft launch: 3 km radius, founder in the ops
      room, first-10-orders manual QA, 48 h retro (§24 Day-1).

---

## Day-2 — deploying a change

1. Merge to `main` with CI green (lint+typecheck+test+build — branch protection per §22.1).
2. **Railway auto-deploys** the API: image rebuild → pre-deploy `npx prisma migrate deploy` →
   `/readyz` gate → cutover. **Vercel auto-deploys** web + ops (preview per PR, prod on main).
3. Watch for ~15 min: `/readyz` stays 200, Sentry error rate flat, Railway logs clean.
4. Migration policy: **expand → deploy → contract** (§22.2) — destructive schema changes ship one
   release after code stops using them, so rollbacks never fight the schema.
5. Deploy ≠ release: risky behavior ships behind an AppSetting flag defaulting OFF (§5).
6. Driver: JS-only fixes via `eas update` OTA; native changes = new EAS build + staged rollout.
7. **Something broke →** `rollback.md` (Railway redeploy previous build <2 min, Vercel Instant
   Rollback <1 min, EAS OTA revert; DB last resort via `restore.md`).

One-off commands (Railway service shell, lands in `/app/backend/api`):
`npx prisma migrate status` · `npx tsx scripts/seed-catalog.ts --file catalog.csv --dry-run`.

## Related

- `docs/PRODUCTION-CHECKLIST.md` — the full §24 gate; tick items as phases above complete.
- `docs/runbooks/rollback.md` · `restore.md` · `store-close-switch.md` · `key-rotation.md` ·
  `razorpay-outage.md`.
- BLUEPRINT §5 (infra table), §16 (backup/DR), §22 (CI/CD + rollback matrix), §26 (env appendix).
