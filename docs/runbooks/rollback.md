# Runbook — Rollback

**Source:** BLUEPRINT §22.3 (rollback matrix), §22.2 (expand → deploy → contract migration policy).

## Purpose

Revert a bad release on any surface with known, pre-agreed levers and time budgets. Schema is always rollback-safe because destructive migrations ship one release **after** code stops using the column (expand → deploy → contract) — a rollback never fights the schema.

## Trigger

- Sev-1 after deploy: 5xx >2% over 5 min, checkout broken, money/stock defect, order flow blocked.
- Failed health-check gate on Railway deploy (auto-holds) plus manual decision to revert.

## Rollback matrix (§22.3)

| Surface | Action | Time budget |
|---|---|---|
| API | Railway → redeploy previous build (schema safe by expand/contract) | <2 min |
| Web/Ops | Vercel "Instant Rollback" to previous deployment | <1 min |
| Driver | Halt Play staged rollout + `eas update --branch production` revert for JS-only changes | mins (JS) / hrs (native) |
| DB | Point-in-time snapshot or R2 dump restore → see `db-restore.md` | ≤2 h |

## Steps

1. **Declare** the rollback (who decides: operator). Note the offending release/commit.
2. **Pick the surface(s)** from the matrix above; roll back the smallest thing that stops the bleeding first (usually API or Web).
3. **API:** Railway dashboard → deployments → redeploy previous build. Verify `/readyz` green. Migrations already applied stay in place — they must be expand-safe by policy; do NOT attempt to down-migrate.
4. **Web/Ops:** Vercel → project → Instant Rollback. Verify the previous deployment serves.
5. **Driver:** halt the Play staged rollout (20%→100% window); if the defect is JS-only, publish an OTA revert via `eas update --branch production`. Native defects require a new build → hours; consider bumping `minDriverAppVersion` only for contract breaks (426 UPGRADE_REQUIRED path).
6. **DB (last resort):** only for data corruption — follow `db-restore.md`.
7. **Verify** the golden path: place a COD test order end-to-end; check Sentry error rate back to baseline.
8. **Follow up:** fix forward on a branch; the contracted (destructive) part of any in-flight migration is postponed until the fixed code has been live for a full release.

## Verification

- [ ] `/readyz` green, 5xx back under baseline.
- [ ] Golden-path order completes.
- [ ] Incident + root cause noted (docs/ or issue).

> **Fill during Phase 7 drill:** Railway/Vercel UI click-paths (screenshots), EAS commands verified against the live project, and measured rollback times vs the budgets above.
