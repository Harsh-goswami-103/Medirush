# MedRush

40-minute medicine & supplement delivery platform — single dark store, hyperlocal (≤5 km),
licensed pharmacy model. Master spec: [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) (frozen —
amend the doc first, code second).

## Monorepo

Top level splits **backend** (the API) from **frontend** (all client apps); shared code lives in
**packages** and is consumed by both.

| Path | What |
|---|---|
| `backend/api` | Fastify 5 + Prisma 6 + Socket.io + pg-boss — the one backend |
| `frontend/ops` | Ops + Admin panel (Next.js, role-gated) — Phase 3 |
| `frontend/web` | Customer PWA (Next.js) — Phase 4 |
| `frontend/driver` | Driver app (Expo) — Phase 5 |
| `packages/contracts` | ★ Single source of truth: enums, Zod schemas, socket events, error codes |
| `packages/config` | Shared eslint / prettier / tsconfig / tailwind presets |
| `packages/ui` | Shared web components (shadcn-based) |

Clients never hand-write API types — they import from `@medrush/contracts`.

## Local setup (§21.1)

```bash
nvm use && corepack enable && pnpm i
docker compose -f docker-compose.dev.yml up -d   # postgres:16
cp .env.example backend/api/.env                 # fill TEST keys as phases need them
pnpm db:migrate && pnpm db:seed
pnpm dev                                         # api :4000 (ops :3001, web :3000 in later phases)
```

Health: `GET :4000/healthz` (liveness) · `GET :4000/readyz` (DB + migrations + jobs).
API docs (non-prod): `GET :4000/docs`.

## Workflow

Trunk-based, `main` protected, Conventional Commits, squash-merge. Every PR: self-review +
AI review pass (state-machine legality, TX boundaries, Zod coverage, authz, migration safety).
Phase briefs live in `docs/phase-briefs/`.
