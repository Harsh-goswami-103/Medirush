# Runbook — Key / Secret Rotation

**Source:** BLUEPRINT §10.4 (Secrets Lifecycle). Budget: ~30 min per quarterly run.

## Purpose

Rotate every production secret on a quarterly calendar (and immediately on compromise) with zero downtime, using dual-secret windows where verification must not break mid-swap.

## Trigger

- **Quarterly rotation calendar** (recurring reminder — set in Phase 7).
- **Immediate triggers:** staff departure · laptop loss · any secret appearing in logs/Sentry.

## Inventory rule (§10.4)

Every secret exists in exactly **one** runtime place (Railway / Vercel / EAS env stores) + **one** encrypted password-manager export (§16 "Config/secrets" backup row, latest 3 kept). If a secret is found anywhere else, that is an incident.

## Steps — quarterly run

1. **Razorpay webhook secret (dual-secret window):**
   1. Generate the new secret in the Razorpay dashboard.
   2. Deploy API verifying **old ‖ new** (accept either signature) for 24h.
   3. After 24h with zero old-secret hits, drop the old secret from env and dashboard.
2. **R2 keys:** create key pair #2 → swap `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` in Railway env → redeploy → verify uploads/presigned GETs → delete key pair #1.
3. **`REVALIDATE_SECRET`:** generate new value → update Railway (API) and Vercel (web/ops) in the same sitting → verify an ops product edit still revalidates the catalog page.
4. **`BACKUP_GPG_PASSPHRASE`:** rotate passphrase → **re-encrypt the latest dump** with the new passphrase (older dumps stay on the old one — keep it in the password manager until they age out of retention) → verify `gpg -d` on the re-encrypted dump.
5. **Firebase service account:** create key #2 → swap `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` → verify token verification works (login smoke test) → revoke key #1.
6. **Export**: refresh the encrypted password-manager export of all Railway/Vercel/EAS env sets (keep latest 3).

## Steps — immediate (compromise) rotation

1. Identify blast radius: which secret, where it leaked (logs/Sentry/laptop).
2. Rotate that secret first using the matching procedure above, compressing dual-secret windows to the minimum that avoids breaking in-flight traffic.
3. Scrub the leak source (delete Sentry event / purge log line), then check for use of the leaked credential (R2 access logs, Razorpay dashboard, Firebase audit).
4. Record the incident + rotation in AuditLog / incident notes.

## Verification

- [ ] All rotated services smoke-tested (webhook event, R2 presign, revalidate, backup decrypt, OTP login).
- [ ] Password-manager export refreshed; no secret exists outside its one runtime store + export.
- [ ] Next quarterly reminder scheduled.

> **Fill during Phase 7 drill:** dashboard click-paths per provider, the dual-secret verify implementation detail (env var names for old‖new), and measured duration vs the 30-min budget. Scale path (§10.4): move encryption keys to a managed KMS; env then holds only references.
