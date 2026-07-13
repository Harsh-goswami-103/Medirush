# Runbook — Database backup & restore drill

Covers the nightly encrypted backup (§11/§24) and the **restore drill** that makes those backups
trustworthy. A backup you have never restored is not a backup. Run the drill **monthly** (§19 Admin weekly/
monthly cadence) and record the result.

## What the backup is

- **Job:** pg-boss cron `db-backup` (`backend/api/src/jobs/dbBackup.ts`), nightly **02:00 IST**.
- **Pipeline:** `pg_dump` (plain SQL, `--no-owner --no-privileges`) → gzip → `gpg --symmetric` (AES-256).
- **Destination:** the **backup bucket**, key `backups/medrush-<ISO-timestamp>.sql.gz.gpg`. Each
  `BACKUP_R2_*` value (`BACKUP_R2_BUCKET`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_ACCESS_KEY_ID`,
  `BACKUP_R2_SECRET_ACCESS_KEY`) falls back to its runtime `R2_*` counterpart when unset — set the
  dedicated ones so a compromised runtime R2 key cannot destroy the backups.
- **Config gate (no-op unless set):** `BACKUP_GPG_PASSPHRASE` + effective R2 credentials + an effective
  bucket (dedicated `BACKUP_R2_*` or the runtime fallback). In dev/CI these are unset → the job logs a
  skip and spawns nothing. It only runs in configured production.
- **After a successful upload (never before):**
  - *Heartbeat* — if `BACKUP_HEARTBEAT_URL` is set, the job GETs it (dead-man's-switch: point it at a
    Better Stack heartbeat; the monitor pages when the pings STOP arriving).
  - *Retention prune* — backup objects older than `BACKUP_RETENTION_DAYS` (default **60**) are deleted.
    The prune runs only after a green upload, so a broken pipeline can never age out the last good backup.
- **Prod prerequisites in the API image:** `pg_dump` (postgresql-client) and `gpg` on `PATH`. A failed backup
  is logged as `db-backup FAILED` (wire this to the alert channel — §24 Observability).

## Prerequisites to restore

- The `BACKUP_GPG_PASSPHRASE` used at backup time (from the secret store — NOT from this file).
- Read access to the backup bucket — `BACKUP_R2_BUCKET` if set, else `R2_PRIVATE_BUCKET` — with the
  matching credentials (`aws` CLI against the R2 endpoint, or the Cloudflare dashboard).
- `gpg`, `gunzip`, and `psql` locally.
- A **target** database URL. For a drill this is a throwaway DB; for a real DR it is the new prod DB.

## Restore procedure

```bash
# 0. Resolve the EFFECTIVE backup location: each BACKUP_R2_* wins over its
#    runtime R2_* fallback (same rule the job uses). Credentials likewise:
#    BACKUP_R2_ACCESS_KEY_ID/SECRET if set, else the runtime R2 pair.
export BACKUP_BUCKET="<BACKUP_R2_BUCKET, or R2_PRIVATE_BUCKET when unset>"
export R2_ENDPOINT="https://<BACKUP_R2_ACCOUNT_ID, or R2_ACCOUNT_ID when unset>.r2.cloudflarestorage.com"

# 1. Pick a backup object (newest, or a specific date).
aws s3 ls "s3://$BACKUP_BUCKET/backups/" --endpoint-url "$R2_ENDPOINT" | tail
OBJ="backups/medrush-2026-07-12T20-30-00-000Z.sql.gz.gpg"     # example

# 2. Download it.
aws s3 cp "s3://$BACKUP_BUCKET/$OBJ" ./backup.sql.gz.gpg --endpoint-url "$R2_ENDPOINT"

# 3. Decrypt → decompress → restore into the TARGET db (never prod during a drill).
export RESTORE_DATABASE_URL="postgresql://user:pass@host:5432/medrush_restore"
gpg --batch --quiet --decrypt --passphrase "$BACKUP_GPG_PASSPHRASE" ./backup.sql.gz.gpg \
  | gunzip \
  | psql "$RESTORE_DATABASE_URL"

# 4. Clean up the plaintext.
shred -u ./backup.sql.gz.gpg 2>/dev/null || rm -f ./backup.sql.gz.gpg
```

## Verify the restore (the drill's actual point)

Against `RESTORE_DATABASE_URL`, confirm the data is intact and recent:

```sql
SELECT (SELECT count(*) FROM "Order")            AS orders,
       (SELECT count(*) FROM "Product")          AS products,
       (SELECT count(*) FROM "WalletTxn")        AS wallet_txns,
       (SELECT max("createdAt") FROM "Order")    AS latest_order;
```

- Row counts are non-zero and roughly match production.
- `latest_order` is within ~24h of the backup timestamp (proves freshness).
- Spot-check one known recent order (id + `totalPaise` + status) matches what prod had.
- Optional: point a local API at `RESTORE_DATABASE_URL`, hit `/readyz` (migrations current) and load an order.

## Record the drill

Log in the ops journal: date, backup object restored, target DB, the counts above, pass/fail, and time-to-
restore. **Target: < 2h** (§22.3 DB rollback). Any failure → fix the pipeline/creds and re-drill before relying
on backups. Tick §24 Data → "restore drill passed" only after a green drill.

## Related

- Rollback matrix — `docs/BLUEPRINT.md` §22.3 (DB: point-in-time / R2 dump restore, ≤ 2h).
- Production checklist — `docs/PRODUCTION-CHECKLIST.md` (Data section).
