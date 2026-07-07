# Phase 3 — Ops / Admin panel

Binding brief for Phase 3. Extends `phase-0-conventions.md` + `phase-1-core-api.md` +
`phase-2-payments-rx.md` (all still binding). Blueprint sections: §5 (structure), §7.2 (Ops +
Admin endpoints), §7.3 (socket), §8 (RBAC), §9.6 (wallet/payouts), §9.7 (H1 register), §19
(ops/admin workflows), §20 (UI/UX), §23 (roadmap DoD).

**DoD (§23):** the store is operable by a non-developer using only this panel — a pharmacist can
process a real order start-to-finish on a tablet without touching the DB; every sensitive action is
audit-logged.

## Layout (post-restructure)

- Backend lives in `backend/api` (moved from `apps/api`). Frontend apps live in `frontend/*`.
- **Phase 3 frontend app = `frontend/ops`** — one role-gated Next.js 15 app (Ops + Admin).
- Shared `packages/{contracts,ui,config}` at repo root, consumed by both sides.

## Overriding principle (carried from P2): everything third-party has a LOCAL STUB MODE

The panel must be fully runnable locally with NO real credentials. Firebase, R2, Razorpay all use
the P2 stub paths. The frontend adds a **dev login**: in dev/test it mints the backend dev token
`dev:<firebaseUid>:<phone>` (P1 auth path) from a simple form, so ops/admin screens work with the
seeded users (`seed-firebase-{inventory,admin}`) and no Firebase project. When
`NEXT_PUBLIC_FIREBASE_*` is set it uses the real Firebase phone-OTP SDK. Same client code, config-selected.

## Scope decisions (adjudicated — do not relitigate)

1. **No schema changes.** Every model needed (Product, Category, Batch, StockAdjustment, Order,
   User, DriverProfile, Wallet, WalletTxn, Payout, Coupon, CouponRedemption, StoreConfig,
   AppSetting, AuditLog, Prescription, ItemBatchAlloc) already exists. Report a mismatch, don't migrate.
2. **Contracts are already frozen** — `schemas/inventory.ts` (ops product/category/batch/stock) and
   `schemas/admin.ts` (dashboard/orders/drivers/payouts/users/coupons/settings/reports) define every
   request/response. Implement EXACTLY to them; never hand-roll. Do NOT edit `packages/contracts`.
3. **Backend gap** — two new route groups (contracts exist, routes don't):
   - **Ops inventory management** (role INVENTORY/ADMIN): products CRUD, categories CRUD, batches
     (GRN), stock adjust, low-stock, near-expiry.
   - **Admin** (role ADMIN): dashboard KPIs, orders+CSV, drivers verify/block, payouts
     approve/mark-paid/reject, users list/block/role, coupons CRUD, settings get/put, reports.
4. **Money/audit rules** (carry P1/P2): `assertTransition` never applies here (no order status
   changes except payout compensation touches wallet, not orders); wallet mutations use a
   FOR-UPDATE-locked ledger; external calls (none new here) stay outside tx; **AuditLog on every
   sensitive admin action** (verify/block/role/payout/coupon/settings); `no-store` on all authed routes.
5. **Payout money flow (§9.6):** approve → `WalletTxn(PAYOUT, DEBIT)` immediately under a wallet row
   lock (funds locked; reject if balance < amount → 409); mark-paid → record UTR (status PAID, no
   ledger move); reject a REQUESTED/APPROVED payout → compensating `WalletTxn(CREDIT)` only if it was
   already APPROVED (debited). Idempotent per status guard (conditional updateMany on Payout.status).
6. **Set-role (§8.2):** sets `User.role` in PG + `invalidateUserCache(firebaseUid)`. The Firebase
   custom-claim + refresh-token revocation is real only when Firebase is configured (stub no-op in
   dev/test, mirroring `core/firebase.ts`). Blocking a user sets `User.isBlocked` + cache-invalidate.
7. **Reports:** `format=csv` → `text/csv` attachment (`content-disposition`); else JSON per schema.
   GST back-compute reuses `core/pdf.ts backComputeGst` (per-line, §9.2). H1 register = DELIVERED
   orders' Rx items joined to ItemBatchAlloc + the order's approved Prescription patient/doctor.
8. **NOT in Phase 3:** dispatch waves / offers (Phase 5), driver Expo app (Phase 5), customer PWA
   (Phase 4), live driver-location map data (Phase 5/6 — the fleet screen shows last-known only),
   FCM push (Phase 6), image AVIF/WebP variant generation beyond the P2 sharp resize.

## Backend file ownership (disjoint — single writer per file)

All under `backend/api/src/modules`. Each plugin is self-contained (routes + co-located service),
`config:{roles:[…]}`, `no-store` onSend, Zod `@medrush/contracts` schemas on every route. The
integrator registers the exported plugin names in `modules/v1.ts`.

| Agent | Owns (NEW) | Endpoints (contract) | Tests |
|---|---|---|---|
| **A ops-inventory** | `inventory/opsRoutes.ts`, `inventory/opsCatalogService.ts` | ops products CRUD, categories CRUD, batches (GRN), stock adjust, low-stock, near-expiry (`schemas/inventory.ts`) | `test/ops-inventory.int.test.ts` |
| **B admin-analytics** | `admin/analyticsRoutes.ts`, `admin/dashboardService.ts`, `admin/orderService.ts`, `admin/reportService.ts` | dashboard, orders+CSV, reports sales/gst/h1 (`schemas/admin.ts`) | `test/admin-analytics.int.test.ts` |
| **C admin-fleet** | `admin/fleetRoutes.ts`, `admin/driverService.ts`, `admin/payoutService.ts`, `admin/userService.ts`, `admin/payoutLedger.ts` | drivers verify/block, payouts approve/mark-paid/reject, users list/block/role | `test/admin-fleet.int.test.ts` |
| **D admin-marketing** | `admin/marketingRoutes.ts`, `admin/couponService.ts`, `admin/settingsService.ts` | coupons CRUD, settings get/put | `test/admin-marketing.int.test.ts` |

Exported plugin names (integrator registers these in `v1.ts`): `opsInventoryRoutes`,
`adminAnalyticsRoutes`, `adminFleetRoutes`, `adminMarketingRoutes`.

Reusable existing helpers: `core/db getPrisma`, `core/errors AppError`, `core/storeInfo
{getStoreConfig,bustStoreConfigCache,haversineM}`, `core/flags {getFlag,bustFlagCache}`, `core/pdf
backComputeGst`, `core/storage {putPrivateObject,presignPrivateGet}`, `plugins/auth
{requireSyncedAuth,invalidateUserCache,invalidateDriverVerifiedCache}`, `wallet/ledger
assertLedgerInvariant`, `orders/opsService` patterns, `core/realtime emitOpsAlert`. Product image
upload reuses P2 `putPrivateObject` to the PUBLIC bucket path + returns the CDN/stub URL.

## Backend conventions

- Cursor pagination exactly like ops orders (`take: limit+1`, `cursor/skip`, `meta.nextCursor`).
- Slugs auto-generated from name when omitted (reuse the catalog slugify approach); price ≤ MRP
  re-checked server-side on product create/update (legal, §9.2).
- Category/product DELETE = soft-deactivate (`isActive=false`) — order/history references survive.
- Batch GRN: create Batch + bump `Product.stockQty` + write a `StockAdjustment(RECEIVED)` in one tx.
- Stock adjust: signed delta, never negative (conditional UPDATE guard), `StockAdjustment` row,
  optional batch decrement. Manual reasons only (RETURN/DAMAGE/EXPIRY/CORRECTION).
- Dashboard/report date ranges are IST calendar days (reuse the `Asia/Kolkata` Intl pattern from
  `storeInfo`/`invoices`). onTime SLA = deliveredAt − placedAt ≤ 40 min.
- Settings PUT: partial store + flags; `bustStoreConfigCache()` + `bustFlagCache()` after; AuditLog.

## Frontend — `frontend/ops` (Next.js 15, App Router)

Scaffolded by the integrator; screens built after the backend is green. Tech: Next 15 + React 19,
TypeScript strict, Tailwind + shadcn components in `packages/ui` (promote from stub), TanStack Query
for server state, `@medrush/contracts` for all types, `socket.io-client` for the live board.
Desktop-first, sidebar → drawer < 1024px, dense keyboard-friendly tables (§20). Light theme.

- **API client** (`src/lib/api.ts`): typed `fetch` wrapper — base `NEXT_PUBLIC_API_URL`, attaches
  `Authorization: Bearer <token>`, parses the `{data,meta}` / `{error}` envelope, throws typed
  `ApiError`. Zero hand-written response types — infer from contract schemas.
- **Auth** (`src/lib/auth.tsx`): dev-login form (uid+phone → dev token, dev/test only) OR Firebase
  phone-OTP (when configured); stores token; role-gates nav (INVENTORY sees Ops; ADMIN sees Ops +
  Admin). Guards redirect unauthenticated → `/login`.
- **Routes** (§5): `/login`, `/orders` (live board, socket `ops` room, new-order sound),
  `/orders/[id]` (detail: Rx zoom viewer via presigned url + approve/reject, start-packing, ready
  with FEFO allocation editor, cancel), `/rx-queue`, `/packing`, `/products` (+ create/edit + image
  upload), `/batches` (GRN), `/stock` (adjust + low-stock + near-expiry), and admin:
  `/admin/dashboard` (KPI tiles + trend), `/admin/drivers`, `/admin/payouts`, `/admin/coupons`,
  `/admin/users`, `/admin/reports` (sales/GST/H1 + CSV download), `/admin/settings`.
- Build/verify: `next build` + `tsc --noEmit` clean; a Playwright smoke (login → board → open order)
  is the frontend DoD proxy since there's no unit-test bar for screens yet.

## Tests (backend — same P1 harness against `medrush_test`)

Integration tests via `test/helpers/{db,factories,auth}`. Required coverage:
- **ops-inventory:** create product (price ≤ MRP enforced, slug gen), update, soft-delete;
  category CRUD; GRN batch → stock cache bumped + RECEIVED adjustment; stock adjust signed delta +
  never-negative guard; low-stock lists at/below threshold; near-expiry within window; RBAC
  (CUSTOMER → 403).
- **admin-analytics:** dashboard KPIs on a seeded day (orders/revenue/AOV/onTime/lowStock/codDue);
  orders filter + `format=csv` returns text/csv; sales report per-day rollup + totals; GST report
  back-compute (CGST=SGST, Σ = taxable); H1 register rows for a DELIVERED Rx order.
- **admin-fleet:** driver verify flips isVerified + audit; block user → isBlocked + cache bust;
  set-role changes PG role; **payout approve debits wallet (ledger invariant holds), balance <
  amount → 409, reject after approve compensating-credits, mark-paid records UTR**; double-approve → 409.
- **admin-marketing:** coupon create (PERCENT>100 → 422 via contract, endsAt≤startsAt → 422), update,
  deactivate, list; settings GET returns store+flags; PUT partial updates + busts caches + audit.

## Notes for agents

- Node 20 local; ESM; do NOT run pnpm install/build/git. Report a JSON manifest
  `{"files":[...],"notes":[...],"contractMismatches":[...]}`.
- Wallet payout debit: add `admin/payoutLedger.ts` mirroring `wallet/ledger.ts creditWallet` — a
  `SELECT … FOR UPDATE` on the wallet row, compute balanceAfter, insert `WalletTxn(PAYOUT/CREDIT)`,
  update balance; refuse a debit that would go negative (409 `CONFLICT`). Keep `assertLedgerInvariant`
  green.
- Every list endpoint: newest-first, cursor-paginated. Every mutation: one tx, conditional guards,
  AuditLog for sensitive actions, emit `emitOpsAlert`/socket only where the contract/§7.3 says.
