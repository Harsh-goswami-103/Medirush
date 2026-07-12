# Runbook — Database Restore (superseded)

> **This runbook is deprecated — use [`restore.md`](./restore.md).**
>
> This file described a backup job that was never implemented as written
> (02:30 IST schedule, `backups/pg/{date}.sql.gz.gpg` keys, a "30 daily +
> 12 weekly" retention policy). The **actual** job — pg-boss cron `db-backup`
> in `backend/api/src/jobs/dbBackup.ts` — runs nightly at **02:00 IST** and
> writes `backups/medrush-<ISO-timestamp>.sql.gz.gpg` to the backup R2 bucket
> (`BACKUP_R2_BUCKET`, falling back to the private bucket); after each
> successful upload it prunes backups older than `BACKUP_RETENTION_DAYS`
> (default 60).
>
> [`restore.md`](./restore.md) is the single canonical backup & restore-drill
> runbook. This stub is kept only so existing links keep resolving.
