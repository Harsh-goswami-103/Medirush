# Runbook — DPDP Data-Erasure Request

**Source:** DPDP Act 2023 (right to erasure), privacy policy erasure promise, `POST /v1/admin/users/:id/anonymize`, AuditLog `USER_ANONYMIZED`.

## Purpose

Handle a customer's "delete my data" request: scrub identity PII and marketing/convenience data immediately, while keeping the records pharmacy and tax law require us to retain. This is **anonymization, not row deletion** — the account becomes a permanent tombstone.

## 1. Verify the requester

Never erase on an email alone.

1. Requester must contact from the phone number on the account (call back the registered number, or verify an OTP-style challenge from the logged-in app before they lose access).
2. Record: date, channel, phone number verified, operator name — in the grievance log.
3. If the requester cannot prove control of the account phone, refuse and escalate to the grievance officer.

## 2. Pre-flight checks (the API enforces these; check first to set expectations)

- **In-flight orders**: any order not DELIVERED/CANCELLED blocks erasure (409). Wait for delivery or cancel per §18.3, then retry.
- **Driver accounts**: refused (409) — drivers have wallet/payout obligations; driver offboarding is a separate (future) flow.
- **Admins**: cannot erase yourself or the last active admin.

## 3. Execute

Admin panel → Users → (user) → **Anonymize**, or:

```
POST /v1/admin/users/:id/anonymize   (ADMIN role)
```

One transaction does all of:

| Scrubbed / deleted | Detail |
|---|---|
| name / email | `"Deleted user"` / null |
| phone, firebaseUid | tombstoned to `anon:<userId>` (frees the real phone/uid to re-register fresh) |
| Addresses | deleted |
| Device push tokens | deleted |
| Cart + items | deleted |
| Notifications | deleted |
| Account | `isBlocked = true` — live sessions die immediately |
| Audit | `USER_ANONYMIZED` row with actor + per-table delete counts |

Repeat call → `409 CONFLICT` with `details.reason = "ALREADY_ANONYMIZED"` (safe; the first call did all the work).

## 4. What is KEPT, and why (tell the requester this)

Retained under statutory obligation — erasure does not extend to these:

| Kept | Legal basis |
|---|---|
| Orders + order items | Drugs & Cosmetics Rules sale records; consumer-dispute defence |
| Invoices (incl. GST data) | GST Act — tax records |
| Payments / refunds | RBI / payment-settlement reconciliation |
| Prescriptions + stored images | Pharmacy records (Schedule H/H1 register) |
| Wallet / payout ledger | Financial records |
| Audit logs | Integrity of the erasure trail itself |

Note: retained orders contain the delivery `addressSnapshot` (name/phone/address frozen at order time) — that snapshot is part of the statutory sale record.

Retention wording for the reply to the requester: "Your identity, addresses, devices, cart and notifications have been erased. Records of past orders, invoices, payments and prescriptions are retained for [OPERATOR: confirm retention periods with CA/legal] as required by pharmacy and tax law, after which they are destroyed."

## 5. Confirm + close

1. Verify: `GET /v1/admin/users?search=anon:<userId>` shows the tombstone; `GET /v1/admin/audit-log?action=USER_ANONYMIZED&entityId=<userId>` shows the row.
2. Reply to the requester within the SLA: **acknowledge in 72h, complete + confirm within 30 days** [OPERATOR: confirm SLA with legal — DPDP rules may prescribe shorter].
3. Log closure in the grievance register.

## Grievance officer

[OPERATOR: name, email, postal address of the DPDP grievance officer — must be published on the privacy page.]

| Date | User id | Verified by | Completed | Notes |
|---|---|---|---|---|
| | | | | |
