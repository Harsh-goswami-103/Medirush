# Runbook — Store Close Kill-Switch

**Source:** BLUEPRINT §19 (Incident lever), §6 (`StoreConfig.isOpen`), error code `STORE_CLOSED`.

## Purpose

Instantly stop new checkouts with a friendly customer-facing banner, without deploys or downtime. This is the **first lever** for: pharmacist absence, stock chaos, weather, or any incident where fulfilling new orders is unsafe.

## Trigger

- Pharmacist unavailable (no one to review Rx / pack safely).
- Stock integrity in doubt (reconciliation mismatch, suspected batch problem).
- Weather / rider safety, or any Sev-1 where new orders would pile up unfulfillable.
- Normal daily close (pharmacist SOP: toggle store off at end of day).

## Steps — close

1. Flip the switch: Ops panel store toggle (sets `StoreConfig.isOpen = false`). Fallback if ops UI is down: admin settings endpoint. _Fill during Phase 7 drill: exact ops UI location + fallback API call._
2. Verify checkout is blocked: attempt a checkout — it must fail with `STORE_CLOSED` and the customer PWA must show the friendly "store closed" banner (not a raw error).
3. **In-flight orders are NOT cancelled by the switch** — work the existing queue: Rx reviews, packing, active deliveries continue to completion.
4. Decide on already-PLACED orders that cannot be fulfilled (e.g. pharmacist absent): cancel per the §18.3 matrix (restock + full refund for prepaid), reason recorded on the order.
5. If closure will be long, note customer comms (banner copy / expected reopen time). _Fill during Phase 7 drill: where the banner copy is configured._

## Steps — reopen

1. Confirm the closure cause is resolved (pharmacist present / stock reconciled / weather cleared).
2. Flip `isOpen = true` via the same toggle.
3. Verify: place a small test order end-to-end (or at least reach the payment step) and confirm no stuck orders from the closed window (watchdog alerts clear).

## Verification

- [ ] Checkout rejected with `STORE_CLOSED` while closed; banner shown.
- [ ] Toggle action audited (who flipped it, when — AuditLog).
- [ ] No stuck orders after reopen; watchdog quiet.

| Date | Closed | Reopened | Reason |
|---|---|---|---|
| _fill during Phase 7 drill_ | | | |
