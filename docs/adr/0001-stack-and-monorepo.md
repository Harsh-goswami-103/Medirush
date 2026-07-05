# ADR 0001 — Technology Stack & Monorepo Shape

- **Status:** Accepted
- **Date:** 2026-07-05
- **Reference:** [`docs/BLUEPRINT.md` §2 (Technology Stack)](../BLUEPRINT.md) — the full decision table with per-row rationale and rejected alternatives. This ADR records the decision; the blueprint is the authoritative spec.

## Context

MedRush is a single-store medicine delivery platform built by a solo developer (with AI agents) in ~11 weeks: one API, customer PWA, ops/admin web, and a driver mobile app. Money (integer paise) and pharmacy stock (batches, expiry, Rx) demand ACID transactions and end-to-end type safety. Guiding rule (§2): **boring, proven, TypeScript end-to-end, minimum moving parts** — every service free-tier or already in the operator's toolbelt.

## Decision

- **TypeScript 5.x everywhere** on **Node.js 22 LTS**; one language across API, three clients, and shared contracts.
- **Fastify 5 + Zod contracts** (`fastify-type-provider-zod`, Swagger/OpenAPI) for the API; **Prisma 6** on **PostgreSQL 16 (Railway)** — one database covering OLTP, search (`pg_trgm`), and jobs.
- **pg-boss** for jobs/cron (Postgres-backed, transactional enqueue — no Redis) and **Socket.io** in the same Node process for realtime; a single API service until load demands otherwise.
- **Next.js 15 (App Router) on Vercel** for customer PWA (Serwist) and ops/admin (second app); **Tailwind + shadcn/ui**, **TanStack Query 5** (+ Zustand for cart UI state).
- **Expo / React Native** for the driver app (EAS builds, OTA updates).
- Services: **Firebase Auth** (phone OTP + custom claims), **Razorpay** (payments/webhooks), **Cloudflare R2** (public images, private Rx/invoices/backups), **Ola Maps** + Google Maps deep-link, **FCM**, **Sentry**, **pino**.
- **Monorepo: pnpm workspaces + Turborepo.** `packages/contracts` (`@medrush/contracts`) is the single source of truth for enums/schemas/events/error codes; `packages/config` holds shared tsconfig/eslint/prettier/tailwind presets; `packages/ui` shares web components. ESM everywhere, TS strict, workspace deps via `workspace:*` (binding details: `docs/phase-briefs/phase-0-conventions.md`).

## Consequences

- One language + one shared contracts package eliminates API/client type drift — the failure mode that kills solo multi-client projects.
- Zero-Redis, single-process architecture keeps infra to Railway + Vercel + free tiers; the scale path (multi-instance Socket.io adapter, separate workers, KMS) is deferred until triggers fire (§5, §10.4).
- Rejected alternatives (Express, NestJS, MongoDB, BullMQ, Flutter, multi-repo, etc.) and the one-line reasons are recorded in the §2 table and are not re-litigated per phase.
- Any future deviation from this stack requires a superseding ADR plus a blueprint note (PR checklist "docs/BLUEPRINT drift?").
