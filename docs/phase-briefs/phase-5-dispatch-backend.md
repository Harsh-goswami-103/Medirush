# Phase 5 (backend) — Dispatch, driver ops, wallet payouts

Binding brief for the Phase 5 BACKEND (the driver Expo app is a separate, later effort — it can't be
built/run in this environment). Extends P1–P4 briefs. Blueprint: §7.2 (Driver), §7.3 (socket), §9.5
(dispatch/offers), §9.6 (wallet/payouts), §11 (in-memory location). Depends: P1–P3.

**DoD (backend slice):** an order reaching READY offers to the nearest online drivers; exactly ONE driver
wins the accept under concurrency; rejects/expiry escalate to wave 2 then alert ops; drivers toggle
online, stream location, see history; drivers request payouts (≤ balance). Money-safe + race-safe;
integration tests green (incl. a multi-driver accept race + wallet-credit-once).

## Scope — all contracts already frozen (`schemas/{driver,wallet}.ts`), NO schema changes

Missing today (build these):
- **Dispatch** (`modules/dispatch/service.ts`, extend the P1 `assignDriver`): offers, waves, atomic accept,
  reject, expiry escalation. Plus `jobs/offerExpiry.ts`.
- **Driver endpoints** (`modules/drivers/routes.ts`, extend — already has active/picked-up/deliver):
  `PATCH /v1/driver/status`, `GET /v1/driver/offers`, `POST /v1/driver/offers/:id/accept`,
  `POST /v1/driver/offers/:id/reject`, `POST /v1/driver/location`, `GET /v1/driver/history`.
- **Wallet payouts** (`modules/wallet/routes.ts`, extend — already has wallet + txns):
  `POST /v1/driver/payouts` (Idempotency-Key), `GET /v1/driver/payouts`.
- **Location pipeline** (`core/locationStore.ts` — in-memory, §11): batch HTTP write + socket
  `location:update` handler broadcasting `driver:location` to the order room; `GET /orders/:id/track`
  reads the last ping from the store (P1 returned null).
- Wire: `markReady` (opsService) → `dispatchOrder` AFTER commit; register `offerExpiry` in `core/jobs.ts`.

## Pinned dispatch design (match exactly)

Constants (`@medrush/contracts`): DISPATCH_WAVE1_DRIVER_COUNT=3, OFFER_EXPIRES_SEC=25,
UNASSIGNED_ALERT_AFTER_SEC=300. Enums: OfferStatus OFFERED|ACCEPTED|REJECTED|EXPIRED.

- `dispatchOrder(orderId)`: order must be READY. Candidates = DriverProfile where isOnline && isVerified &&
  user not blocked && has NO active delivery (no Delivery for an order still ASSIGNED/PICKED_UP), ordered by
  distance to the STORE (lastLat/lastLng haversine; nulls last), take wave-1 count (3). Create one
  `DeliveryOffer(status OFFERED, wave)` per candidate (skip drivers already offered this order —
  `@@unique([orderId,driverId])`). Emit `offer:new` to each `driverRoom(driverId)` (payload from
  socket-events OfferNewEvent: offerId, orderId, pickup, drop, distanceM, commissionPaise=`base+perKm×
  ceil(distanceM/1000)`, expiresInSec=OFFER_EXPIRES_SEC). Enqueue `offerExpiry` for the order at +25s. If NO
  candidates, go straight to wave 2 (all online+verified+free in radius); if still none, emit ops alert
  UNASSIGNED_ORDER + re-enqueue a check.
- `acceptOffer(offerId, driverProfileId): Promise<{ deliveryId: string; orderId: string }>` — ATOMIC
  first-wins, ONE tx:
  1. load the offer (must belong to driverProfileId, status OFFERED, not past expiry) → else 409 OFFER_TAKEN
     / 404. Load order; assert it is still READY.
  2. `tx.delivery.create({ orderId, driverId, distanceM })` — the `Delivery.orderId` UNIQUE index is the
     first-wins gate; a P2002 → throw AppError("OFFER_TAKEN", 409) (a competitor already won).
  3. conditional `updateMany order READY→ASSIGNED` (count must be 1, else 409). OrderEvent (SYSTEM,
     note driver). Mark THIS offer ACCEPTED; mark all sibling OFFERED offers for the order EXPIRED.
  4. return { deliveryId, orderId }. Emit `emitOrderStatus(ASSIGNED)` + `offer:cancelled` to the other
     offered drivers AFTER commit.
  Reuse the P1 pattern in the existing `assignDriver` (same unique-gate + conditional-update). The route
  then shapes `ActiveDelivery` via the existing `findActiveDelivery` helper.
- `rejectOffer(offerId, driverProfileId)`: mark the driver's OFFERED offer REJECTED. If, after this, the
  order (still READY) has no OFFERED offers left, escalate: wave 2 (or ops alert if none). Idempotent.
- `offerExpiry` job (per order, +25s): expire still-OFFERED offers for the order; if the order is still
  READY with no live offers → wave 2; if wave 2 already ran (or no candidates) and > UNASSIGNED_ALERT_AFTER_SEC
  since readyAt → emit ops alert UNASSIGNED_ORDER (the P1 stuck-order watchdog also covers this).

## Money / concurrency rules (carry from P1–P3)

- Exactly one Delivery per order (unique orderId). Accept is idempotent-safe under N concurrent drivers —
  exactly one 200, the rest 409 OFFER_TAKEN. `assertTransition` inside the tx; one OrderEvent per transition;
  emits/enqueues AFTER commit; external calls never in a tx.
- Payout request (`POST /driver/payouts`, Idempotency-Key): amount ≥ MIN_PAYOUT_PAISE and ≤ current wallet
  balance (else 422/409); create `Payout(REQUESTED)`. NO ledger move here — the debit happens at admin
  approval (P3 `admin/payoutLedger`). List newest-first, cursor.
- `PATCH /driver/status`: only a verified, unblocked driver may go online (else 403 / surface isVerified).
  Going offline is always allowed. Update DriverProfile.isOnline (+ lastSeenAt).
- `POST /driver/location`: validate the driver has an ACTIVE delivery; write the latest ping to the
  in-memory `locationStore` keyed by orderId; broadcast `driver:location` to `orderRoom(orderId)`. Never
  touches Postgres. `GET /orders/:id/track` returns the stored ping (or null).
- `GET /driver/history?date`: that IST day's DELIVERED deliveries for the driver + totals (count,
  commission, cod collected).

## Tests (the bar is race-safety)

`test/dispatch.int.test.ts` + `test/driver-dispatch.int.test.ts`:
- READY order → wave-1 offers created for the N nearest online+verified drivers (not offline/unverified).
- **accept race:** M drivers offered, all accept in parallel → EXACTLY ONE ActiveDelivery/ASSIGNED, others
  409 OFFER_TAKEN; order ASSIGNED once; single OrderEvent.
- reject by all wave-1 → wave-2 offers (or alert). expiry handler expires offers + escalates.
- status: unverified driver online → 403; verified → ok. location: ping while active → stored, GET /track
  returns it; ping with no active delivery → 4xx. history rollup. payout: request ≤ balance ok, > balance
  rejected, < ₹500 rejected (contract), list.

## File ownership (disjoint)

| Agent | Owns |
|---|---|
| **A dispatch** | `modules/dispatch/service.ts` (extend), `jobs/offerExpiry.ts` (new), `core/locationStore.ts` (new) |
| **B driver-ep** | `modules/drivers/routes.ts` (extend: status/offers/accept/reject/location/history) |
| **C wallet** | `modules/wallet/routes.ts` (extend: payouts request/list) |

Integrator (me): wire `markReady`→`dispatchOrder`, `trackOrder`→locationStore, `core/jobs` offerExpiry
register, socket `location:update` handler; write the race tests; full verify. Agents: no pnpm/git/tests;
report a JSON manifest; do NOT edit `packages/contracts` or `modules/v1.ts`.
