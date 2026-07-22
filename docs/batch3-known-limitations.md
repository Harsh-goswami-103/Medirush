# Batch 3 — known limitations and deliberate deferrals

Recorded at build time so the next person does not rediscover them. Everything
here is a conscious decision, not an oversight.

## Deferred features (and why)

**Rider tip.** The only remaining Batch-2/3 feature that touches the driver
wallet ledger, the nightly drift audit and COD reconciliation at once. Money
paths deserve an isolated change with its own review, not a slot in a
sixteen-agent parallel build. The `Order` schema has room for it; the work is
the ledger credit and the reconciliation math.

**Subscriptions / auto-refill orders.** Auto-creating an order re-runs payment
authorisation, stock reservation and prescription validity on every cycle —
each of which can fail independently and needs a defined recovery path. Refill
*reminders* (shipped) deliver most of the retention value at a fraction of the
risk. Build subscriptions only with that failure matrix designed up front.

**Referral rewards as wallet credit.** Rejected in favour of issuing a
**personal coupon** (`Coupon.userId`). This reuses the existing, already-audited
validation, per-user limit and redemption machinery rather than introducing a
second spendable-balance system that the drift audit would also have to learn.

**Bilingual EN/HI (§20.1).** Genuinely cross-cutting: every screen must route
its copy through the translation layer, so splitting it across parallel agents
guarantees half-translated screens. It needs one focused pass that also picks
the framework (next-intl vs a light dictionary) and does the string extraction
in a single sweep.

## Accepted limitation

**A locker prescription attaches to exactly one order.**
`Prescription.orderId` is a single nullable FK, and `attachPrescriptionToOrder`
sets it — so a prescription that has been used once leaves the re-usable pool,
and if that order is cancelled the prescription is not automatically returned to
the locker.

This is a real limit on the "upload once, reuse every refill" promise. Fixing it
properly means modelling the link as many-to-many (an `OrderPrescription` join
row, leaving the source `Prescription.orderId` null so the original stays
re-usable) — a schema change plus a migration of existing links, and a decision
about whether ops re-reviews a prescription each time it is attached (a
pharmacist arguably must). That is a design question, not a patch, so it was not
rushed in at the end of this batch.

Workaround today: the customer uploads again. The locker still removes the
re-photographing burden for everything that has not yet been attached.
