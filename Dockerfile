# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# MedRush API image (BLUEPRINT §3.6, §5, §22.2) — built by Railway's
# DOCKERFILE builder (see railway.json).
#
# Stages:
#   build   — pnpm filtered install (@medrush/api + its workspace deps),
#             prisma generate, tsup build (contracts → api). Mirrors the
#             known-good .github/workflows/ci.yml steps.
#   runtime — node:22 slim + PG16 client tools + gnupg (the nightly backup job
#             spawns `pg_dump | gzip | gpg` — src/jobs/dbBackup.ts) + the app.
#
# ⚠ UNEXERCISED locally (the dev machine has no Docker). The first Railway
#   deploy is this file's validation run — see docs/runbooks/deploy.md.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# Manifests only, so installs are layer-cached. pnpm validates the frozen
# lockfile against EVERY workspace manifest, so all package.json files must be
# present even though only the api dependency tree is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/api/package.json backend/api/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY frontend/driver/package.json frontend/driver/
COPY frontend/ops/package.json frontend/ops/
COPY frontend/web/package.json frontend/web/

# Pinned pnpm via corepack (root package.json "packageManager" — same as CI),
# then install ONLY the api workspace + its workspace deps (contracts, config).
# devDependencies are kept deliberately: the runtime image needs the prisma CLI
# (a devDep of @medrush/api) so Railway's pre-deploy `prisma migrate deploy`
# runs offline inside this image.
RUN corepack enable pnpm && pnpm --version \
 && pnpm install --frozen-lockfile --filter @medrush/api...

# Sources for the packages we build (frontend apps deploy via Vercel/EAS).
COPY packages/config/ packages/config/
COPY packages/contracts/ packages/contracts/
COPY backend/api/ backend/api/

# Prisma client into node_modules (pnpm skips @prisma/client's postinstall
# generation — CI parity), then build workspace deps before the app.
RUN pnpm --filter @medrush/api exec prisma generate \
 && pnpm --filter @medrush/contracts run build \
 && pnpm --filter @medrush/api run build

# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

# PG16 client tools from PGDG — bookworm ships only Postgres 15 clients and
# pg_dump's major version must be >= the server's (prod DB is Postgres 16).
# gnupg — the backup job pipes through `gpg --symmetric`.
# openssl — Prisma's native engines link against libssl, which slim omits.
# curl is build-time only (fetches the PGDG signing key) and purged after.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

# The whole built workspace: dist bundle + prisma schema/migrations (also read
# at runtime by /readyz's migrations-current check) + node_modules including
# the prisma CLI (`npx prisma migrate deploy` resolves it locally, no network).
COPY --from=build --chown=node:node /app /app

USER node
WORKDIR /app/backend/api

# Railway injects PORT; 4000 is the config default (src/core/config.ts).
EXPOSE 4000

CMD ["node", "dist/server.js"]
