# Phase 1 — Core API: auth, catalog, cart, orders (COD-first)

Binding brief for all Phase 1 agents. Extends (never overrides) `phase-0-conventions.md`.
Blueprint sections that govern this phase: §7.2 (endpoints), §8 (auth), §9 (domain logic),
§10.3 (fraud rules), §12 (caching), §15 (watchdogs), §18.3 (cancellation matrix), §21.3 (tests).

**DoD (§23):** a COD order can be driven PLACED→DELIVERED via API calls alone (driver
simulated), stock + events correct; parallel stock-race test green; illegal transitions rejected.

## Scope decisions (adjudicated — do not relitigate)

1. **PREPAID checkout** is Phase 2. `POST /v1/orders` with `paymentMethod: "PREPAID"` →
   `422 VALIDATION_ERROR`, message "PREPAID checkout ships in Phase 2 — use COD".
2. **Rx flow**: orders with Rx items land in `RX_REVIEW` (rxStatus PENDING) but the review
   endpoint is Phase 2 — such orders cannot reach PACKING in Phase 1 (start-packing on
   RX_REVIEW requires `rxStatus=APPROVED` → `422 RX_REQUIRED` otherwise).
3. **Driver simulation**: dispatch waves/offers are Phase 5. Phase 1 ships
   `modules/dispatch/service.ts` with `assignDriver(orderId, driverId)` (creates the
   `Delivery` row atomically on the unique orderId, Order→ASSIGNED, event, socket emit) —
   called from integration tests, NO HTTP surface. Driver `picked-up` / `deliver` ARE HTTP
   (they're in the frozen §7.2 catalog) so the golden path runs over the API.
4. **Delivery OTP attempts** (§9.7, 5 max then locked): tracked in an in-memory Map
   (orderId → count) — there is no schema column; ops unlock = Phase 2+. Note this limit.
5. **Roles come from PG** (`User.role`) via a 60s LRU on every request — §8.2 "PG is the
   source of truth"; Firebase custom claims are a client-side mirror, set on role change
   (admin endpoint lands Phase 3). Blocked users rejected at the hook (403 FORBIDDEN).
6. **Coupon fraud rule** (§10.3 per-address-hash limit): Phase 1 enforces per-user limits
   only; address-hash arrives with the fraud pass in a later phase. Velocity rule
   (>3 orders/hour/user → 429 RATE_LIMITED + OrderEvent note) IS in scope.
7. **Refunds** are Phase 2 (COD has nothing to refund). Cancel = restock + status only.

## Auth verification chain (`plugins/auth.ts` rewrite)

```
Authorization: Bearer <token>
  ├─ FIREBASE_PROJECT_ID configured → firebase-admin verifyIdToken (core/firebase.ts,
  │    lazy init from config; cached certs are the SDK default)
  └─ else, NODE_ENV !== "production" → DEV TOKEN: `dev:<firebaseUid>:<phone>`
       (phone must be E.164). Production without Firebase creds already fails boot.
Then: User lookup by firebaseUid (60s LRU, exported invalidateUserCache(firebaseUid)):
  - no row + route config { allowUnsynced: true } (only POST /v1/auth/sync) → proceed,
    request.auth = { uid, phone, userId: null, role: null }
  - no row otherwise → 401 UNAUTHENTICATED
  - isBlocked → 403 FORBIDDEN
  - request.auth = { uid, userId, role }
Role guard: route config { roles: [...] } → 403 FORBIDDEN when role not in list.
DRIVER routes additionally require DriverProfile.isVerified (same LRU pattern, 60s).
```

Socket handshake (core/socket.ts): same token verification; joins:
`order:{id}` (order owner, or INVENTORY/ADMIN), `driver:{id}` (that driver), `ops`
(INVENTORY/ADMIN). Reject bad tokens with connect error UNAUTHENTICATED.

## File ownership (disjoint — do not touch another agent's files)

| Agent | Owns |
|---|---|
| A platform | `core/firebase.ts`, `core/flags.ts`, `core/storeInfo.ts` (StoreConfig LRU + haversineM + isStoreOpenNow + deliveryFeePaise), `plugins/auth.ts` (rewrite), `plugins/appVersion.ts` (426 gate), `src/app.ts` (register appVersion), `modules/auth/routes.ts` (sync, me), `modules/addresses/routes.ts`, `modules/store/routes.ts` (GET /v1/store, POST /v1/serviceability), `modules/devices/routes.ts`, `apps/api/package.json` (add firebase-admin ^13), tests: `test/auth.int.test.ts`, `test/store.int.test.ts` |
| B catalog+cart | `modules/catalog/routes.ts` + `modules/catalog/search.ts` (trgm raw SQL), `modules/cart/routes.ts` + `modules/cart/service.ts`, tests: `test/catalog.int.test.ts`, `test/cart.int.test.ts` |
| C orders-core | `modules/orders/stateMachine.ts`, `modules/orders/pricing.ts`, `modules/orders/orderNo.ts`, `modules/orders/service.ts`, `modules/orders/routes.ts` (customer endpoints), `core/idempotency.ts`, `core/realtime.ts` (emit helpers over getIo()), `core/jobs.ts` (extend: register cron), `core/socket.ts` (extend: room auth), `jobs/stuckOrders.ts`, `test/helpers/db.ts` + `test/helpers/factories.ts` + `test/helpers/auth.ts`, tests: `test/orders-create.int.test.ts`, `test/orders-race.int.test.ts`, `test/orders-cancel.int.test.ts`, `test/pricing.test.ts` |
| D fulfillment | `modules/inventory/fefo.ts` (pure) + `modules/inventory/service.ts`, `modules/orders/opsService.ts`, `modules/orders/opsRoutes.ts`, `modules/dispatch/service.ts`, `modules/drivers/routes.ts`, `modules/wallet/ledger.ts` + `modules/wallet/routes.ts`, tests: `test/fefo.test.ts`, `test/fulfillment.int.test.ts`, `test/wallet.int.test.ts` |

`src/modules/v1.ts` is pre-written by the integrator and imports these EXACT names:
`authRoutes`, `addressRoutes`, `storeRoutes`, `deviceRoutes` (A), `catalogRoutes`,
`cartRoutes` (B), `orderRoutes` (C), `opsOrderRoutes`, `driverRoutes`, `walletRoutes` (D).
Export exactly those names or typecheck fails.

## Cross-agent interfaces (pinned signatures)

```ts
// C provides — D consumes
// core/realtime.ts
emitOrderStatus(order: { id: string; status: OrderStatus }): void          // order room + ops room
emitOpsAlert(kind: string, msg: string): void                              // ops room
// modules/orders/stateMachine.ts
assertTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): void // throws AppError("INVALID_TRANSITION", …, 409)
// modules/orders/service.ts
restockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> // reverse stock + CANCEL_RESTOCK adj + batch restore if allocated

// D provides — C/tests consume
// modules/inventory/fefo.ts  (pure, unit-tested)
proposeFefo(requiredQty: number, batches: Array<{ id: string; qtyAvailable: number; expiryDate: Date }>, today: Date):
  Array<{ batchId: string; qty: number }>                                  // FEFO, excludes expiry ≤ today+30d; throws/returns short when insufficient (return { allocations, shortfall })
// modules/inventory/service.ts
commitAllocations(tx: Prisma.TransactionClient, orderItemId: string, allocs: Array<{ batchId: string; qty: number }>): Promise<void>
// modules/dispatch/service.ts
assignDriver(orderId: string, driverId: string): Promise<Delivery>
// modules/wallet/ledger.ts
creditWallet(tx: Prisma.TransactionClient, driverProfileId: string, amountPaise: number,
  ref: { type: "ORDER"; id: string }, note?: string): Promise<void>        // SELECT … FOR UPDATE on wallet row, balanceAfter computed inside
```

## Domain rules (from the frozen spec — encode exactly)

- **Checkout validation order** (§9.2): store open (isOpen + hours + `maintenance_banner`
  flag off) → address belongs to user + within `serviceRadiusM` (haversine) → cart
  non-empty; each item active, qty ≤ maxPerOrder → totals recomputed from PG prices →
  coupon (active, window, usageLimit, perUserLimit, minOrder) → COD gates → Rx flag.
- **Totals** (§9.2): `items = Σ price×qty` · `delivery = items ≥ freeDeliveryAbovePaise ? 0
  : deliveryBasePaise` · `discount` · `total = items + delivery − discount`. Min order:
  `items ≥ minOrderPaise` else 422 MIN_ORDER_NOT_MET. Integer paise only.
- **COD gates**: `cod_enabled` flag; `total ≤ codLimitPaise` else COD_LIMIT_EXCEEDED;
  `codRefusalCount ≥ 2` or `riskFlag ∈ {COD_BLOCKED, BLOCKED}` → COD_DISABLED; first order
  ever for the user → total ≤ `new_account_cod_cap` flag (paise) else COD_LIMIT_EXCEEDED
  with explanatory message.
- **Stock reservation** (§9.4): inside the create TX, per item:
  `UPDATE "Product" SET "stockQty" = "stockQty" - $qty WHERE id = $id AND "stockQty" >= $qty`
  via `tx.$executeRaw`; affected ≠ 1 → abort 409 STOCK_INSUFFICIENT with per-item details.
  Write `StockAdjustment(SALE, -qty, refOrderId)` rows. COD order → status PLACED (or
  RX_REVIEW when any item requiresRx), paymentStatus COD_DUE, placedAt now, cart cleared.
- **orderNo**: `MR-<yymmdd>-<seq padded 4>` — create the row, then set orderNo from the
  autoincremented `seq` in the same TX.
- **Idempotency** (§7.1): `Idempotency-Key` header required on POST /v1/orders (400 if
  missing). Same key + same user within 24h → replay stored response verbatim (200).
  Same key, different user → 409 IDEMPOTENCY_CONFLICT. Store response JSON in the TX.
- **Cancellation** (§18.3): customer may cancel PLACED/RX_REVIEW (one-tap → CANCELLED +
  restock, outcome CANCELLED); PACKING/READY → outcome CANCEL_REQUESTED (OrderEvent with
  note "cancel-requested", status unchanged; ops sees it on the detail); ASSIGNED+ → 422.
  Ops/admin cancel: any status before DELIVERED → CANCELLED + restock (restore batch
  allocations too when READY+). Every cancel records cancelReason + cancelledAt.
- **FEFO** (§9.4): propose from batches `expiryDate > today + 30d` ordered expiry ASC;
  pharmacist may edit; `ready` validates Σ alloc qty per item == item qty, batches
  decremented conditionally (`qtyAvailable >= qty`), `ItemBatchAlloc` snapshots batchNo +
  expiry. OTP generated at READY: `crypto.randomInt(0, 10000)` zero-padded 4-digit string.
- **Deliver** (§9.6/§9.7): driver owns the delivery; OTP must match (5 attempts → 423? No —
  use 422 OTP_LOCKED after 5, 422 OTP_INVALID before); COD orders require
  `codCollectedPaise === totalPaise`; TX: wallet `SELECT … FOR UPDATE`, commission =
  `commissionBasePaise + commissionPerKmPaise × ceil(distanceM/1000)` (StoreConfig),
  WalletTxn CREDIT (amount positive, balanceAfter), wallet balance update, delivery
  deliveredAt/otpVerifiedAt, order → DELIVERED + paymentStatus COD_COLLECTED +
  codCollectedPaise on Delivery, OrderEvent, socket emit after commit.
- **Watchdog** (§15): pg-boss cron `*/5 * * * *`: PLACED > 10 min, READY > 7 min
  (no Delivery), PICKED_UP > 40 min → `emitOpsAlert` + warn log per stuck order.
- **Caching** (§12): `GET /v1/products*`, `/v1/categories`, `/v1/store` set
  `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`. Everything else
  `no-store`. StoreConfig + flags: in-process LRU, 60s TTL, exported cache-bust fns.
- **Search** (§7.2): pg_trgm via `$queryRaw`: `WHERE (name || ' ' || coalesce(brand,'') ||
  ' ' || composition || ' ' || "searchKeywords") % ${q}` ordered by `similarity(...) DESC`
  when `q.length >= 3`, else `name ILIKE q%`. Only `isActive` products. Cursor = last id.

## HTTP + validation conventions

Routes use the Zod type provider with schemas imported from `@medrush/contracts` — never
hand-rolled shapes. Do NOT modify `packages/contracts`; if a schema doesn't fit, note the
mismatch in your final report and code to the contract as-is (integrator adjudicates).
Ownership checks live in services (§8.3). Socket emits happen AFTER the DB TX commits.

## Tests

- Unit (`*.test.ts`): pure functions, no DB.
- Integration (`*.int.test.ts`): real Postgres. `test/helpers/db.ts` (agent C) exports:
  `setupTestDb()` — reads `process.env.DATABASE_URL` (default
  `postgresql://postgres@localhost:5433/medrush_test` — the local portable PG; CI overrides),
  asserts it ends in `_test` (never wipe a real DB), truncates all volatile tables;
  `factories.ts` — minimal fixture builders (user(role), product({stock, requiresRx}),
  batch, storeConfig, appSettings defaults); `auth.ts` — `devToken(uid, phone)` +
  `authHeaders(user)`. beforeEach truncate; app built once per file via buildApp().
- vitest.config.ts (integrator will set): `fileParallelism: false` (shared DB).
- Required coverage (§21.3 + DoD): COD golden path PLACED→DELIVERED over HTTP (ops
  start-packing → ready w/ FEFO allocations → assignDriver(service) → driver picked-up →
  deliver w/ OTP → wallet credited exactly once); stock race (`Promise.all` ×5 buyers,
  stock 3 → exactly 3 succeed — hmm, one order each buying qty 1); idempotency replay
  (same key twice → same orderNo, single order row); RBAC 403s (customer hits ops route,
  driver hits admin); illegal transition (deliver a PLACED order → 409); cancel restores
  stock; OTP wrong ×5 → OTP_LOCKED; COD amount mismatch rejected.

## Contract amendments made at integration (additive)

- `ValidateCartResultSchema` gained a required `totals` object (`CartTotalsSchema`:
  itemsPaise, deliveryPaise, totalPaise, minOrderPaise, minOrderMet) — the brief required a
  checkout-preview from `validateCart` but the frozen contract had nowhere to put it.
- `OpsOrderDetailSchema` gained `cancelRequested: boolean` — the brief required getOpsDetail
  to surface the §18.3 cancel-request marker; it was being stripped on the wire.

Both are additive; no client breakage. `CartIssueKind.PRICE_CHANGED` stays in the contract
but is unemittable in Phase 1 (CartItem stores no price snapshot to diff against).

## Notes for agents

- Node 20 locally; `crypto.randomInt` is fine. Windows paths; use the Write/Edit tools.
- pg-boss cron: `boss.schedule(name, cron, data, { tz: "Asia/Kolkata" })` after `boss.work(name, handler)` registration — extend `core/jobs.ts` (agent C owns).
- After the TX that flips status, always write exactly one OrderEvent per transition
  (from, to, actorType, actorId, note?) — the event chain is asserted in tests.
- Do not run pnpm install/test — the integrator does. Report a JSON manifest
  {"files": [...], "notes": [...], "contractMismatches": [...]} as your final message.
