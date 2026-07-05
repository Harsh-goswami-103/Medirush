# Runbook — Database Restore (total DB loss)

**Source:** BLUEPRINT §16 (Backup & Disaster Recovery). **RPO ≤ 24h · RTO ≤ 2h.**

## Purpose

Restore the production PostgreSQL database from the most recent encrypted dump in R2 after total loss of the Railway Postgres instance (or unrecoverable corruption).

## Trigger

- Railway Postgres instance destroyed, unrecoverable, or corrupted beyond point-in-time snapshot repair.
- Monthly restore drill (into a **scratch** Railway PG, never production) — "an untested backup is a rumor."

## Preconditions

- Access to: Railway project `medrush`, R2 bucket `medrush-private` (`backups/pg/{date}.sql.gz.gpg`), `BACKUP_GPG_PASSPHRASE` (password manager, §10.4).
- Backups run daily 02:30 IST via pg-boss cron: `pg_dump | gzip | gpg` → R2. Retention: 30 daily + 12 weekly.

## Steps (§16 runbook, verbatim order)

1. Provision a fresh instance: `railway add postgresql` in the `medrush` project.
2. Download the latest dump from R2 and restore:
   `gpg -d backups/pg/<latest>.sql.gz.gpg | gunzip | psql "<new DATABASE_URL>"`.
3. Point `DATABASE_URL` at the new instance (Railway env for `api`), redeploy the API.
4. Verify `/healthz` returns 200 and `/readyz` is green, then smoke test: place a COD test order end-to-end (PLACED → DELIVERED with a simulated driver).
5. Reconcile the Razorpay dashboard against orders for the gap window (payments captured after the last backup) — fix `paymentStatus` / refund mismatches manually and record each fix in AuditLog.
6. Announce downtime end (ops + customers per comms checklist).

## Verification

- [ ] `/readyz` green (PG `SELECT 1` + migrations current + boss started).
- [ ] Smoke order delivered; stock counts and order events correct.
- [ ] Razorpay reconciliation for the gap window complete.
- [ ] Wallet drift audit job run once manually — drift must be 0.

## Drill log

Monthly drill into a scratch Railway PG. Record date, duration, and issues below.

| Date | Restored dump | Duration | Issues |
|---|---|---|---|
| _fill during Phase 7 drill_ | | | |

> **Fill during Phase 7 drill:** exact `railway` CLI invocations, measured restore duration vs the 2h RTO, dump size, and the comms template for the downtime-end announcement.
