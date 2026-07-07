# MedRush — 40-Minute Medicine & Supplement Delivery Platform
## Production Engineering Blueprint v1.1

> **Codename:** MedRush (placeholder — rename anytime).
> **Model:** Single dark store, hyperlocal (≤5 km radius), own inventory, 40-minute delivery promise. Licensed retail pharmacy model (Form 20/21) with registered pharmacist acting as Inventory Manager. Pure resale of sealed manufactured products — no manufacturing/repacking.
> **Team:** Solo developer + AI agents (Claude Code for architecture/security-critical code and review; Codex for well-specced CRUD/boilerplate). One pharmacist (ops), delivery drivers (gig).
> **How to use this document:** This is the frozen master spec. Each Roadmap phase (§23) maps to one Claude Code work package. Do not let implementation drift from the contracts in §6–§8 without updating this doc first.
> **v1.1 changelog:** Merged MVP-scoped items from `BLUEPRINT-ADDENDUM-v1.1.md` — S1 WAF, S2 fraud rules, S5 secrets policy, S8 supply-chain CI, S9 runtime hardening, R1 graceful shutdown, R6 app-update gate, A1 feature flags, C5 composition field, P4a temp register, P7 bin/barcode fields. Growth/Scale items stay in the Addendum, shipped by trigger.

---

## Table of Contents

1. System Overview
2. Technology Stack (with rationale)
3. System Architecture
4. Project & Folder Structure
5. Infrastructure
6. Database Architecture (full schema)
7. API Architecture (conventions + endpoint catalog)
8. Authentication & Authorization
9. Core Domain Logic (order state machine, dispatch, stock, wallet)
10. Security Architecture
11. Performance Optimization
12. Caching Strategy
13. File Storage
14. Third-Party Integrations
15. Monitoring & Logging
16. Backup & Disaster Recovery
17. Complete Feature List (all 4 panels)
18. User Flows
19. Ops & Admin Workflows
20. UI/UX Design System
21. Development Workflow (git, testing, environments)
22. CI/CD & Deployment Pipeline
23. Development Roadmap (phased, with DoD)
24. Production Launch Checklist
25. Cost Summary
26. Appendix A — Environment Variables

---

# 1. System Overview

Four client surfaces, one backend:

| Surface | Form | Users | Purpose |
|---|---|---|---|
| **Customer app** | Next.js PWA (mobile-first web) | Public | Browse, order, pay, upload Rx, live-track |
| **Driver app** | React Native (Expo), Android-first | Verified drivers | Receive offers, accept, navigate, deliver via OTP, wallet/payouts |
| **Ops panel** | Next.js web (role: INVENTORY) | Pharmacist | Order queue, Rx verification, packing, stock/batch management |
| **Admin panel** | Same Next.js ops app (role: ADMIN) | Owner | KPIs, drivers, payouts, catalog, coupons, reports, settings |

One **modular monolith API** (Fastify + PostgreSQL + Socket.io + pg-boss) serves all four. The Ops and Admin panels ship as a single deployed app with role-gated navigation — one codebase, one deploy, less maintenance for a solo dev.

**Non-goals for v1** (explicitly out of scope): multiple stores, iOS customer app, in-app chat, ratings/reviews, subscriptions, ML demand forecasting, surge pricing. The schema leaves room for these; the code does not build them.

---

# 2. Technology Stack

Guiding rule: boring, proven, TypeScript end-to-end, minimum moving parts. Every service below is either free-tier or already in the operator's toolbelt.

| Layer | Choice | Why this (one line) | Rejected alternative & why |
|---|---|---|---|
| Language | **TypeScript 5.x everywhere** | One language across API, 3 web/mobile clients, shared contracts | JS (no contract safety) |
| Runtime | **Node.js 22 LTS** | LTS until 2027, native fetch/test-runner | Bun/Deno (ecosystem risk for payments/SDKs) |
| API framework | **Fastify 5** | Schema-first validation built in (pairs with Zod contracts), ~2–3× Express throughput, TS-native, plugin encapsulation | Express (manual validation wiring, slower); NestJS (abstraction tax a solo dev pays daily) |
| ORM | **Prisma 6** | Operator already fluent (TFG project), best-in-class migrations, typed client, interactive transactions for stock/ledger | Drizzle (younger, fewer battle scars); raw SQL (slower iteration) |
| Database | **PostgreSQL 16 (Railway managed)** | ACID for stock + money, one DB for OLTP + search (pg_trgm) + jobs (pg-boss) | MongoDB (money/stock need transactions & constraints); Firestore (no joins/ledger integrity) |
| Job queue / cron | **pg-boss** | Postgres-backed → zero extra infra, **transactional enqueue** (job commits atomically with the order row), built-in cron & retries | BullMQ (needs Redis — an extra paid service and failure point at this scale) |
| Realtime | **Socket.io** (same Node process) | Rooms, acks, auto-reconnect, auth middleware; single instance needs no adapter | Raw `ws` (rebuild rooms/reconnect); Pusher/Ably (recurring cost, vendor lock) |
| Customer web | **Next.js 15 (App Router)** on Vercel | ISR for catalog SEO + speed, image optimization, free hosting | Vite SPA (no ISR/SSR, worse SEO for product pages) |
| PWA layer | **Serwist** | Maintained successor to next-pwa; precache shell + offline fallback | next-pwa (unmaintained) |
| Ops/Admin web | **Next.js 15** (second app, same monorepo) | Shares UI package + contracts; role-gated sections | Separate admin framework (needless divergence) |
| Web UI | **Tailwind CSS + shadcn/ui** | Owned component code (no dependency lock-in), fast to restyle, operator's daily driver | MUI/AntD (heavy, hard to make non-generic) |
| Client data | **TanStack Query 5** (+ Zustand for cart UI state) | Cache, retries, optimistic updates for cart/order actions | Redux (ceremony without benefit here) |
| Mobile (driver) | **Expo SDK 52+ / React Native** | Reuses React+TS skills; `expo-location` background tracking; EAS builds; OTA updates for JS fixes | Flutter (new language = weeks lost); bare RN (config pain, no OTA out of box) |
| Auth | **Firebase Auth (Phone OTP)** + custom claims | India-standard OTP UX, SMS infra + abuse protection outsourced, operator already runs custom-claims RBAC (Servio) | Self-rolled OTP (SMS deliverability + fraud burden); Auth0 (cost) |
| Payments | **Razorpay** (Orders API + Webhooks; RazorpayX payouts later) | India default: UPI/cards/netbanking + COD coexistence; operator has prior webhook-hardening experience | Stripe India (onboarding friction, weaker UPI story) |
| File storage | **Cloudflare R2** (S3 API) | Zero egress fees; private bucket + presigned URLs for prescriptions (medical privacy); public bucket + CDN for product images | Cloudinary (transform pricing; private medical docs awkward); S3 (egress cost) |
| Maps – search/tiles | **Ola Maps** (Places autocomplete, map tiles via **MapLibre GL**) | India-focused, generous free tier, 70–80% cheaper than Google | Google Maps JS (cost balloons with live tracking) |
| Maps – driver navigation | **Google Maps app deep-link** (`google.navigation:q=lat,lng`) | Turn-by-turn quality of Google at **zero API cost** | Embedded nav SDK (cost + build complexity) |
| Push | **FCM** (web push + Expo notifications) | Free, covers PWA + Android | OneSignal (unneeded layer) |
| Transactional email | **Resend** (invoices/receipts, optional) | Free tier, trivial API; India is SMS/WhatsApp-first so email is secondary | — |
| PDF invoices | **pdfkit** (server-side) | Lightweight, no headless browser | Puppeteer (500MB+ deps for a receipt) |
| Monorepo | **pnpm workspaces + Turborepo** | Shared `contracts` package = single source of truth for types across API/web/mobile | Multi-repo (contract drift is how solo projects die) |
| Validation/contracts | **Zod** (+ `fastify-type-provider-zod`, `@fastify/swagger` for OpenAPI) | One schema → runtime validation + TS types + API docs | class-validator (decorator ceremony) |
| Lint/format | **ESLint + Prettier** (shared config pkg) | Proven Next.js/Expo plugin ecosystem | Biome (fast, but Next/Expo rules still maturing) |
| Testing | **Vitest** (unit/integration) + `app.inject()` for HTTP + **Playwright** (E2E web) | Fast, TS-native; Fastify inject needs no port | Jest (slower, config-heavy) |
| Error tracking | **Sentry** (API + web + Expo) | One pane for all four surfaces, free tier suffices | — |
| Logging | **pino** (structured JSON → Railway logs) | Fast, request-id correlation | winston (slower, unstructured habits) |
| Uptime | **Better Stack / UptimeRobot** free tier | External heartbeat on `/healthz` | — |

**Money is stored as integer paise** (`Int`), never floats — eliminates rounding bugs in totals, GST, ledger. Format to ₹ only at the UI edge. Distances in meters (`Int`).

---

# 3. System Architecture

## 3.1 Topology

```
                          ┌──────────────────────────────────────────┐
                          │  RAILWAY (project: medrush)              │
                          │                                          │
   ┌────────────┐  HTTPS  │  ┌────────────────────────────────────┐  │
   │ Customer   │────────▶│  │ api  (single Node process)         │  │
   │ PWA        │  WSS    │  │  Fastify REST /v1/*                │  │
   │ (Vercel)   │◀───────▶│  │  Socket.io  (rooms)                │  │
   └────────────┘         │  │  pg-boss workers (same process)    │  │
   ┌────────────┐         │  │  Prisma ──────────────┐            │  │
   │ Ops/Admin  │────────▶│  └───────────────────────┼────────────┘  │
   │ (Vercel)   │         │                          ▼               │
   └────────────┘         │  ┌────────────────────────────────────┐  │
   ┌────────────┐         │  │ PostgreSQL 16 (managed, private    │  │
   │ Driver app │────────▶│  │ network, daily snapshots)          │  │
   │ (Expo/Play │  WSS    │  └────────────────────────────────────┘  │
   │  Store)    │◀───────▶│                                          │
   └────────────┘         └──────────────────────────────────────────┘
        │                        │                │              │
        ▼                        ▼                ▼              ▼
  Google Maps app          Firebase Auth      Razorpay      Cloudflare R2
  (nav deep-link)          (OTP + claims)     (pay/refund   (images public,
        ▲                        ▲             webhooks)     Rx private)
        └── FCM push ────────────┘
```

One API service. One database. Workers run inside the API process (pg-boss polls Postgres) — no separate worker dyno until load demands it (§11).

## 3.2 Request flow (read, e.g. product list)

`PWA → Vercel CDN (ISR cache hit? serve) → miss → Next server → GET api/v1/products → Fastify (rate-limit → Zod validate → handler) → Prisma → PG → JSON ← cache 60s at edge`

## 3.3 Order placement flow (prepaid)

```
Client POST /v1/orders (Idempotency-Key)
 └─ TX: validate cart/serviceability/store-open
        reserve stock (conditional UPDATE, §9.4)
        create Order(PENDING_PAYMENT) + items + event
        enqueue pg-boss job payment-timeout(15m)   ← same TX, atomic
        create Razorpay order
 └─ respond {orderId, rzpOrderId, key}
Client completes Razorpay checkout
Razorpay → POST /v1/webhooks/razorpay (signature verified)
 └─ TX: insert PaymentEvent(event_id UNIQUE)  ← idempotency gate
        Order → PLACED (or RX_REVIEW if Rx items)
        cancel timeout job; emit socket order:status; FCM to ops
```

## 3.4 Auth flow

```
App/PWA → Firebase SDK phone OTP → firebase ID token (JWT)
Every API call: Authorization: Bearer <idToken>
Fastify onRequest hook → firebase-admin verifyIdToken (cached certs)
 → attach {uid, role} from custom claims → RBAC guard per route
First login: POST /v1/auth/sync upserts User row, default role CUSTOMER.
Roles are ONLY changed server-side (admin action → set custom claim + DB).
```

Socket.io handshake carries the same ID token; middleware verifies before joining rooms.

## 3.5 Realtime flow (tracking)

```
Driver app (on active delivery): GPS every 5s → socket emit location:update
API: keep last-known in in-memory Map<driverId,{lat,lng,ts}>
     throttle → broadcast to room order:{id} every 3–5s
     persist to PG only on status transitions (NOT every ping)
Customer PWA: joins order:{id} → renders marker on MapLibre map
Fallback (socket down): GET /v1/orders/:id/track polling every 10s
```

## 3.6 Deployment flow

`git push main → GitHub Actions (lint+typecheck+test+build) → Railway auto-deploys api (pre-deploy: prisma migrate deploy) & Vercel auto-deploys both web apps. Driver app: EAS build → Play Console staged rollout; JS-only fixes via EAS Update OTA.`

---

# 4. Project & Folder Structure

```
medrush/
├── backend/                    # server-side (deployed to Railway)
│   └── api/                    # Fastify + Prisma + Socket.io + pg-boss
│       ├── prisma/
│       │   ├── schema.prisma
│       │   ├── migrations/
│       │   └── seed.ts
│       └── src/
│           ├── core/           # cross-cutting: db.ts, socket.ts, jobs.ts,
│           │                   # storage.ts(R2), maps.ts, fcm.ts, razorpay.ts,
│           │                   # config.ts(env-validated), logger.ts, errors.ts
│           ├── plugins/        # authGuard, rbac, rateLimit, requestId, swagger
│           ├── modules/        # one folder per bounded context
│           │   ├── auth/       #   each = routes.ts + service.ts + (queries.ts)
│           │   ├── catalog/
│           │   ├── cart/
│           │   ├── orders/     # + stateMachine.ts (pure, unit-tested)
│           │   ├── payments/   # + webhook.ts
│           │   ├── prescriptions/
│           │   ├── dispatch/   # offer waves, assignment
│           │   ├── drivers/
│           │   ├── wallet/     # ledger.ts (pure invariants)
│           │   ├── inventory/  # batches, FEFO, adjustments
│           │   ├── notifications/
│           │   └── admin/      # reports, settings, payouts
│           ├── jobs/           # handlers: paymentTimeout, offerExpiry,
│           │                   # noDriverAlert, nightlyBackup, expiryScan
│           └── server.ts
├── frontend/                   # every client app (deployed to Vercel / EAS)
│   ├── ops/                    # Ops + Admin (Next.js, role-gated) — Phase 3
│   │   └── src/app/ (routes: /orders, /orders/[id], /rx-queue, /packing,
│   │        /products, /batches, /stock, /admin/{dashboard,drivers,
│   │        payouts,coupons,users,reports,settings})
│   ├── web/                    # Customer PWA (Next.js App Router) — Phase 4
│   │   └── src/app/ (routes: /, /c/[category], /p/[slug], /cart,
│   │        /checkout, /orders, /orders/[id]/track, /account, /rx-upload)
│   └── driver/                 # Expo app (expo-router) — Phase 5
│       └── app/ (login, home[online-toggle], offer/[id], active/[id],
│            wallet, payouts, history, profile)
├── packages/                   # shared by backend + frontend
│   ├── contracts/              # ★ SINGLE SOURCE OF TRUTH
│   │   └── src/ (enums.ts, schemas/{auth,catalog,cart,order,driver,
│   │        wallet,inventory,admin}.ts, socket-events.ts, errors.ts)
│   ├── ui/                     # shared web components (shadcn-based)
│   └── config/                 # eslint, prettier, tsconfig, tailwind presets
├── docs/                       # THIS FILE, runbooks/, adr/, phase-briefs/
├── .github/workflows/ci.yml
├── docker-compose.dev.yml      # local Postgres 16
├── turbo.json  pnpm-workspace.yaml  .nvmrc(22)  .env.example
```

**Rule:** clients never hand-write API types. They import from `@medrush/contracts`. A breaking change there fails typecheck in every app — that is the contract-freeze workflow, enforced by the compiler.

---

# 5. Infrastructure

| Component | Provider | Plan / Config |
|---|---|---|
| API + workers | Railway service | 1 vCPU / 1–2 GB, health check `/healthz`, restart on failure, region: closest India-adjacent (currently Singapore) |
| PostgreSQL | Railway managed PG 16 | Private networking to API, daily snapshots, `connection_limit=10` in Prisma URL |
| Customer PWA | Vercel (free/pro) | `medrush.in`, ISR, image optimization |
| Ops/Admin | Vercel | `ops.medrush.in` |
| Driver app | Play Store + EAS | Internal testing track → production staged rollout |
| DNS/CDN + Edge WAF | Cloudflare (free, proxied) | `api`/`app`/`ops` proxied; WAF managed rules ON; Bot Fight Mode ON; edge rate rule `/v1/auth/*` 20 req/min/IP; `ops.medrush.in` geo-restricted to IN; WebSockets enabled (Socket.io passthrough); origin locked — Railway accepts Cloudflare IP ranges only |
| Object storage | Cloudflare R2 | Buckets: `medrush-public` (images, CDN), `medrush-private` (Rx, backups; no public access) |
| Secrets | Railway/Vercel/EAS env stores | Never in git; `.env.example` documents keys (§26) |

Environments: **production** + **local** (docker-compose PG). A dedicated staging service on Railway is optional; Vercel preview deploys + a `?preview` seed script cover 90% of staging needs for a solo dev. Feature flags are first-class: the `AppSetting` table (§6) + typed `getFlag<T>(key, default)` accessor (60s LRU, §12) + Admin ▸ Settings ▸ Flags UI; a client-safe subset ships in `GET /v1/store → flags`. Launch flags: `cod_enabled`, `rx_orders_enabled`, `dispatch_wave_size`, `new_account_cod_cap`, `maintenance_banner`. Rule: any risky behavior ships behind a flag defaulting OFF — **deploy ≠ release**.

Scale path (documented now, built later): move pg-boss workers to a second Railway service → add Redis + Socket.io redis-adapter when horizontal API scaling is needed → read replica at ~50k orders/month. None of this changes application code structure.

---

# 6. Database Architecture

## 6.1 Principles

1. **Postgres is the source of truth** for stock, money, and order state. Firebase holds only auth identity + role claims (mirrored from PG, PG wins).
2. **Money = integer paise. Quantity/stock = integers. Distance = meters.** No floats near a ledger.
3. **Append-only ledgers** for wallet transactions and order events — rows are never updated or deleted; balances are derived and cached with invariants (§9.6).
4. **Batch + expiry tracking** on medicines (pharmacy compliance: Schedule H1 register needs batch numbers; FEFO picking prevents expired dispatch).
5. Snapshots over joins for historical records: order items copy name/price/GST at purchase time; address is a JSON snapshot on the order.

## 6.2 Full Prisma schema (frozen contract)

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Role            { CUSTOMER DRIVER INVENTORY ADMIN }
enum ScheduleClass   { NONE OTC H H1 }        // Schedule X: never stocked
enum OrderStatus     { PENDING_PAYMENT PLACED RX_REVIEW PACKING READY
                       ASSIGNED PICKED_UP DELIVERED CANCELLED }
enum PaymentMethod   { PREPAID COD }
enum PaymentStatus   { PENDING PAID FAILED REFUND_INITIATED REFUNDED COD_DUE COD_COLLECTED }
enum RxStatus        { NA PENDING APPROVED REJECTED }
enum OfferStatus     { OFFERED ACCEPTED REJECTED EXPIRED }
enum TxnType         { CREDIT DEBIT PAYOUT ADJUSTMENT }
enum PayoutStatus    { REQUESTED APPROVED PAID REJECTED }
enum AdjustReason    { RECEIVED SALE CANCEL_RESTOCK RETURN DAMAGE EXPIRY CORRECTION }
enum ActorType       { SYSTEM CUSTOMER OPS DRIVER ADMIN }

model User {
  id          String   @id @default(cuid())
  firebaseUid String   @unique
  phone       String   @unique            // E.164
  name        String?
  email       String?
  role        Role     @default(CUSTOMER)
  isBlocked   Boolean  @default(false)
  codRefusalCount Int  @default(0)          // fraud signal (§10.3)
  riskFlag    String   @default("NONE")     // NONE|WATCH|COD_BLOCKED|BLOCKED
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  addresses   Address[]
  orders      Order[]
  driver      DriverProfile?
  cart        Cart?
  devices     DeviceToken[]
}

model Address {
  id        String  @id @default(cuid())
  userId    String
  user      User    @relation(fields: [userId], references: [id])
  label     String  @default("Home")
  line1     String
  line2     String?
  landmark  String?
  pincode   String
  lat       Float
  lng       Float
  isDefault Boolean @default(false)
  @@index([userId])
}

model Category {
  id        String    @id @default(cuid())
  name      String
  slug      String    @unique
  imageUrl  String?
  sortOrder Int       @default(0)
  isActive  Boolean   @default(true)
  products  Product[]
}

model Product {
  id                String        @id @default(cuid())
  name              String
  slug              String        @unique
  brand             String?
  description       String        @default("")
  categoryId        String
  category          Category      @relation(fields: [categoryId], references: [id])
  images            String[]      // R2 keys
  mrpPaise          Int
  pricePaise        Int           // selling price ≤ MRP (legal requirement)
  gstRatePct        Int           // 0 | 5 | 12 | 18
  hsnCode           String?
  packSize          String        // "Strip of 10", "200ml"
  composition       String        @default("")  // salt+strength "Paracetamol 650mg" (search + generics later)
  binLocation       String        @default("")  // shelf address "R2-S3" → packing speed
  barcode           String?       @unique       // EAN-13, captured at catalog entry (future scan flows)
  requiresRx        Boolean       @default(false)
  scheduleClass     ScheduleClass @default(NONE)
  isColdChain       Boolean       @default(false)
  stockQty          Int           @default(0)   // cached; batches are truth
  lowStockThreshold Int           @default(10)
  maxPerOrder       Int           @default(10)
  searchKeywords    String        @default("")  // generics/salt names
  isActive          Boolean       @default(true)
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt
  batches           Batch[]
  @@index([categoryId, isActive])
}

model Batch {
  id            String   @id @default(cuid())
  productId     String
  product       Product  @relation(fields: [productId], references: [id])
  batchNo       String
  expiryDate    DateTime @db.Date
  qtyReceived   Int
  qtyAvailable  Int
  costPaise     Int                      // purchase price/unit
  wholesaler    String
  invoiceNo     String                   // wholesaler bill (inspection-critical)
  receivedAt    DateTime @default(now())
  @@unique([productId, batchNo, invoiceNo])
  @@index([productId, expiryDate])       // FEFO picking
}

model StockAdjustment {
  id        String       @id @default(cuid())
  productId String
  batchId   String?
  delta     Int                          // signed
  reason    AdjustReason
  refOrderId String?
  actorId   String?
  note      String?
  createdAt DateTime     @default(now())
  @@index([productId, createdAt])
}

model Cart {
  id        String     @id @default(cuid())
  userId    String     @unique
  user      User       @relation(fields: [userId], references: [id])
  updatedAt DateTime   @updatedAt
  items     CartItem[]
}
model CartItem {
  id        String @id @default(cuid())
  cartId    String
  cart      Cart   @relation(fields: [cartId], references: [id], onDelete: Cascade)
  productId String
  qty       Int
  @@unique([cartId, productId])
}

model Order {
  id              String        @id @default(cuid())
  orderNo         String        @unique          // MR-250705-0042
  seq             Int           @default(autoincrement())
  userId          String
  user            User          @relation(fields: [userId], references: [id])
  status          OrderStatus
  paymentMethod   PaymentMethod
  paymentStatus   PaymentStatus
  addressSnapshot Json                            // {line1..lat,lng,phone,name}
  distanceM       Int                             // store→customer haversine
  itemsPaise      Int
  deliveryPaise   Int
  discountPaise   Int           @default(0)
  totalPaise      Int
  couponCode      String?
  requiresRx      Boolean       @default(false)
  rxStatus        RxStatus      @default(NA)
  deliveryOtp     String?                         // 4-digit, set at READY
  cancelReason    String?
  invoiceNo       String?       @unique           // MR/25-26/000123 (FY-sequential)
  invoiceKey      String?                         // R2 key of PDF
  placedAt        DateTime?
  packedAt        DateTime?
  readyAt         DateTime?
  deliveredAt     DateTime?
  cancelledAt     DateTime?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  items           OrderItem[]
  events          OrderEvent[]
  prescriptions   Prescription[]
  delivery        Delivery?
  payment         Payment?
  @@index([status, createdAt])
  @@index([userId, createdAt])
}

model OrderItem {
  id            String  @id @default(cuid())
  orderId       String
  order         Order   @relation(fields: [orderId], references: [id])
  productId     String
  nameSnap      String
  packSizeSnap  String
  pricePaise    Int
  mrpPaise      Int
  gstRatePct    Int
  hsnSnap       String?
  requiresRx    Boolean
  qty           Int
  allocations   ItemBatchAlloc[]
}

model ItemBatchAlloc {                             // set at packing (FEFO)
  id          String    @id @default(cuid())
  orderItemId String
  orderItem   OrderItem @relation(fields: [orderItemId], references: [id])
  batchId     String
  batchNoSnap String
  expirySnap  DateTime  @db.Date
  qty         Int
}

model OrderEvent {                                 // append-only audit trail
  id        String      @id @default(cuid())
  orderId   String
  order     Order       @relation(fields: [orderId], references: [id])
  from      OrderStatus?
  to        OrderStatus
  actorType ActorType
  actorId   String?
  note      String?
  createdAt DateTime    @default(now())
  @@index([orderId, createdAt])
}

model Prescription {
  id           String   @id @default(cuid())
  orderId      String
  order        Order    @relation(fields: [orderId], references: [id])
  fileKey      String                              // R2 private
  mimeType     String
  status       RxStatus @default(PENDING)
  patientName  String?                             // captured for H1 register
  doctorName   String?
  reviewerId   String?
  reviewNote   String?
  createdAt    DateTime @default(now())
  reviewedAt   DateTime?
}

model DriverProfile {
  id          String    @id @default(cuid())
  userId      String    @unique
  user        User      @relation(fields: [userId], references: [id])
  vehicleType String    @default("bike")
  vehicleNo   String?
  licenseNo   String?
  isVerified  Boolean   @default(false)
  isOnline    Boolean   @default(false)
  lastLat     Float?
  lastLng     Float?
  lastSeenAt  DateTime?
  wallet      Wallet?
  offers      DeliveryOffer[]
  deliveries  Delivery[]
}

model DeliveryOffer {
  id        String      @id @default(cuid())
  orderId   String
  driverId  String
  driver    DriverProfile @relation(fields: [driverId], references: [id])
  status    OfferStatus @default(OFFERED)
  wave      Int         @default(1)
  offeredAt DateTime    @default(now())
  respondedAt DateTime?
  @@unique([orderId, driverId])
  @@index([driverId, status])
}

model Delivery {                                   // the accepted assignment
  id             String   @id @default(cuid())
  orderId        String   @unique
  order          Order    @relation(fields: [orderId], references: [id])
  driverId       String
  driver         DriverProfile @relation(fields: [driverId], references: [id])
  acceptedAt     DateTime @default(now())
  pickedUpAt     DateTime?
  deliveredAt    DateTime?
  otpVerifiedAt  DateTime?
  distanceM      Int
  commissionPaise Int?                             // set on DELIVERED
  codCollectedPaise Int?                           // COD orders
}

model Wallet {
  id       String @id @default(cuid())
  driverId String @unique
  driver   DriverProfile @relation(fields: [driverId], references: [id])
  balancePaise Int @default(0)
  txns     WalletTxn[]
}
model WalletTxn {                                  // append-only ledger
  id           String   @id @default(cuid())
  walletId     String
  wallet       Wallet   @relation(fields: [walletId], references: [id])
  type         TxnType
  amountPaise  Int                                 // always positive
  balanceAfterPaise Int
  refType      String?                             // "ORDER" | "PAYOUT"
  refId        String?
  note         String?
  createdAt    DateTime @default(now())
  @@index([walletId, createdAt])
}

model Payout {
  id          String       @id @default(cuid())
  driverId    String
  amountPaise Int
  status      PayoutStatus @default(REQUESTED)
  method      String       @default("UPI")
  upiOrAcct   String
  utr         String?
  requestedAt DateTime     @default(now())
  processedAt DateTime?
  processedBy String?
  @@index([driverId, status])
}

model Payment {
  id            String   @id @default(cuid())
  orderId       String   @unique
  order         Order    @relation(fields: [orderId], references: [id])
  rzpOrderId    String   @unique
  rzpPaymentId  String?
  amountPaise   Int
  refundId      String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
model PaymentEvent {                               // webhook idempotency gate
  eventId    String   @id                          // razorpay event id
  type       String
  payload    Json
  processedAt DateTime @default(now())
}
model IdempotencyKey {                             // client POST /orders dedupe
  key       String   @id
  userId    String
  response  Json
  createdAt DateTime @default(now())
}

model Coupon {
  id           String   @id @default(cuid())
  code         String   @unique
  kind         String                               // FLAT | PERCENT
  valuePaiseOrPct Int
  minOrderPaise   Int    @default(0)
  maxDiscountPaise Int?
  usageLimit   Int?
  perUserLimit Int      @default(1)
  startsAt     DateTime
  endsAt       DateTime
  isActive     Boolean  @default(true)
  redemptions  CouponRedemption[]
}
model CouponRedemption {
  id       String @id @default(cuid())
  couponId String
  coupon   Coupon @relation(fields: [couponId], references: [id])
  userId   String
  orderId  String @unique
  createdAt DateTime @default(now())
  @@index([couponId, userId])
}

model StoreConfig {                                // single row (id="store")
  id                 String  @id @default("store")
  name               String
  address            String
  drugLicenseNo      String?                       // printed on invoices
  pharmacistName     String?
  pharmacistRegNo    String?
  gstin              String?
  fssaiNo            String?
  lat                Float
  lng                Float
  serviceRadiusM     Int     @default(5000)
  isOpen             Boolean @default(true)        // manual kill-switch
  openTime           String  @default("08:00")
  closeTime          String  @default("22:00")
  minOrderPaise      Int     @default(9900)
  deliveryBasePaise  Int     @default(2000)
  freeDeliveryAbovePaise Int @default(49900)
  codLimitPaise      Int     @default(150000)
  commissionBasePaise Int    @default(2500)
  commissionPerKmPaise Int   @default(500)
  minDriverAppVersion  String @default("1.0.0")   // 426 gate (§7.1, §22.2)
  minCustomerAppVersion String @default("1.0.0")
  supportPhone       String
}

model AppSetting {                                 // feature flags & tunables (§5, §10.3)
  key       String   @id                           // "cod_enabled"
  value     Json
  updatedBy String?
  updatedAt DateTime @updatedAt
}

model TempLog {                                    // fridge temperature register (compliance)
  id         String   @id @default(cuid())
  source     String   @default("MANUAL")           // MANUAL | SENSOR (probe = Growth)
  tempC      Float
  byUserId   String?
  recordedAt DateTime @default(now())
  @@index([recordedAt])
}

model DeviceToken {
  id       String @id @default(cuid())
  userId   String
  user     User   @relation(fields: [userId], references: [id])
  token    String @unique
  platform String                                   // web | android
  updatedAt DateTime @updatedAt
}

model Notification {
  id        String   @id @default(cuid())
  userId    String
  title     String
  body      String
  type      String
  data      Json?
  readAt    DateTime?
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
}

model AuditLog {                                    // sensitive admin/ops actions
  id        String   @id @default(cuid())
  actorId   String
  action    String                                  // "PRODUCT_PRICE_CHANGE" etc.
  entity    String
  entityId  String
  meta      Json?
  createdAt DateTime @default(now())
  @@index([entity, entityId])
}
```

## 6.3 Raw-SQL migrations (beyond Prisma)

```sql
-- Fuzzy product search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX product_search_trgm ON "Product"
  USING GIN ((name || ' ' || coalesce(brand,'') || ' ' || "composition" || ' ' || "searchKeywords") gin_trgm_ops);

-- Ledger safety nets
ALTER TABLE "Wallet"  ADD CONSTRAINT wallet_nonneg  CHECK ("balancePaise" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT stock_nonneg   CHECK ("stockQty" >= 0);
ALTER TABLE "Batch"   ADD CONSTRAINT batch_nonneg   CHECK ("qtyAvailable" >= 0);
```

## 6.4 Data integrity rules (enforced in service layer + tests)

| Rule | Mechanism |
|---|---|
| Stock never oversold | Conditional `UPDATE ... WHERE stockQty >= qty` inside the order TX (§9.4) |
| Wallet balance = Σ ledger | Every txn computes `balanceAfter` inside a `SELECT ... FOR UPDATE` on the wallet row; nightly job re-derives and alerts on drift |
| One delivery per order | `Delivery.orderId UNIQUE`; offer acceptance is an atomic conditional insert |
| Webhook processed once | `PaymentEvent.eventId` PK insert before processing; duplicate → 200 + skip |
| Invoice numbers sequential per FY | Generated inside TX from a counter row; never reused, even for cancelled orders (GST rule) |
| Status transitions legal | Pure `stateMachine.ts` allow-list; DB write rejected if transition invalid |

---

# 7. API Architecture

## 7.1 Conventions

* Base: `https://api.medrush.in/v1` — path-versioned; additive changes only within v1.
* **Envelope:** success → `{ "data": ..., "meta"?: {...} }`; error → `{ "error": { "code": "STOCK_INSUFFICIENT", "message": "...", "details"?: [...] } }`. Error codes are enum'd in `@medrush/contracts` — clients switch on `code`, never parse messages.
* HTTP codes: 200/201, 400 validation, 401 unauthenticated, 403 role, 404, 409 conflict (stock/state), 422 business rule, 429 rate-limited, 500.
* Pagination: `?cursor=<id>&limit=20` (cursor-based; stable under inserts). Response `meta: { nextCursor }`.
* All bodies/queries/params validated by Zod schemas from `contracts`; responses serialized through the same schemas (no accidental field leaks). `@fastify/swagger` publishes OpenAPI at `/docs` (non-prod only).
* Timestamps ISO-8601 UTC; client renders IST.
* Mutating POSTs that must not double-fire (`/orders`, `/payouts`) require an `Idempotency-Key` header (UUID); server replays stored response for 24h.
* Apps send `x-app-version`; `/v1/driver/*` returns `426 UPGRADE_REQUIRED` when below `minDriverAppVersion` (StoreConfig) → client shows a blocking update screen. EAS OTA covers JS-compatible fixes; this gate covers contract/native breaks — old clients can never speak a stale contract.

## 7.2 Endpoint catalog

**Public / Customer** (auth: CUSTOMER unless marked ⭘ public)

| Method & Path | Purpose |
|---|---|
| ⭘ GET `/v1/store` | Store status, hours, min order, fee rules, **client feature flags**, min app versions |
| ⭘ GET `/v1/categories` | Active categories |
| ⭘ GET `/v1/products?category&search&cursor` | List/search (trgm) |
| ⭘ GET `/v1/products/:slug` | Product detail |
| POST `/v1/auth/sync` | Upsert user after Firebase login |
| GET/PATCH `/v1/me` | Profile |
| GET/POST/PATCH/DELETE `/v1/addresses[/:id]` | Address book |
| POST `/v1/serviceability` | `{lat,lng}` → in-radius? fee? |
| GET `/v1/cart` · PUT `/v1/cart/items` · DELETE `/v1/cart/items/:productId` | Server-side cart (price integrity) |
| POST `/v1/cart/validate` | Re-check stock/price/Rx flags before checkout |
| POST `/v1/orders` (Idempotency-Key) | Create order (returns Razorpay order for PREPAID) |
| POST `/v1/orders/:id/prescriptions` (multipart) | Upload Rx (≤5MB, jpeg/png/pdf) |
| GET `/v1/orders` · GET `/v1/orders/:id` | History / detail |
| GET `/v1/orders/:id/track` | Polling fallback for live location |
| POST `/v1/orders/:id/cancel` | Per cancellation matrix (§18.3) |
| GET `/v1/orders/:id/invoice` | Presigned PDF URL |
| POST `/v1/devices` | Register FCM token |

**Driver** (role: DRIVER, verified)

| Method & Path | Purpose |
|---|---|
| PATCH `/v1/driver/status` | `{isOnline}` toggle |
| GET `/v1/driver/offers` | Open offers (socket is primary; this is refresh) |
| POST `/v1/driver/offers/:id/accept` \| `/reject` | Atomic first-accept-wins |
| GET `/v1/driver/active` | Current delivery + customer address |
| POST `/v1/driver/deliveries/:id/picked-up` | At store handover |
| POST `/v1/driver/deliveries/:id/deliver` | `{otp, codCollectedPaise?}` → completes + credits wallet |
| POST `/v1/driver/location` | HTTP batch fallback when socket is down |
| GET `/v1/driver/wallet` · GET `/v1/driver/wallet/txns` | Balance + ledger |
| POST `/v1/driver/payouts` (Idempotency-Key) · GET `/v1/driver/payouts` | Request withdrawal (min ₹500) |
| GET `/v1/driver/history?date` | Completed deliveries + earnings/day |

**Ops** (role: INVENTORY or ADMIN)

| Method & Path | Purpose |
|---|---|
| GET `/v1/ops/orders?status&cursor` | Live queue (socket-refreshed) |
| GET `/v1/ops/orders/:id` | Full detail incl. Rx files (presigned) |
| POST `/v1/ops/orders/:id/rx-review` | `{status: APPROVED\|REJECTED, note, patientName?, doctorName?}` |
| POST `/v1/ops/orders/:id/start-packing` | PLACED/RX_REVIEW→PACKING |
| POST `/v1/ops/orders/:id/ready` | `{allocations:[{orderItemId,batchId,qty}]}` — FEFO pre-filled |
| POST `/v1/ops/orders/:id/cancel` | With reason; triggers refund+restock |
| CRUD `/v1/ops/products[/:id]` · `/v1/ops/categories` | Catalog mgmt |
| POST `/v1/ops/products/:id/batches` | GRN — receive stock (auto `RECEIVED` adjustment) |
| POST `/v1/ops/stock/adjust` | Damage/expiry/correction |
| GET `/v1/ops/stock/low` · GET `/v1/ops/stock/near-expiry?days=60` | Alerts |

**Admin** (role: ADMIN)

| Method & Path | Purpose |
|---|---|
| GET `/v1/admin/dashboard?range` | KPIs: orders, revenue, AOV, on-time %, active drivers, low stock |
| GET `/v1/admin/orders?filters` | All orders, export CSV |
| GET `/v1/admin/drivers` · POST `/v1/admin/drivers/:id/verify` · `/block` | Fleet mgmt + last-known locations |
| GET `/v1/admin/payouts?status` · POST `/v1/admin/payouts/:id/approve` \| `/mark-paid {utr}` \| `/reject` | Payout processing |
| GET `/v1/admin/users` · POST `/v1/admin/users/:id/block` · POST `/v1/admin/users/:id/role` | User mgmt (role sets PG + Firebase claim) |
| CRUD `/v1/admin/coupons` | Promotions |
| GET/PUT `/v1/admin/settings` | StoreConfig (audited) |
| GET `/v1/admin/reports/sales?from&to` · `/gst` · `/h1-register` | CSV/PDF: GST summary; **Schedule H1 register** (drug, batch, qty, patient, doctor, date — 3-yr retention) |

**System**

| Method & Path | Purpose |
|---|---|
| POST `/v1/webhooks/razorpay` | Signature-verified; events: `payment.captured`, `payment.failed`, `refund.processed` |
| GET `/healthz` | Liveness (process up) |
| GET `/readyz` | Readiness: DB ping + migrations current + boss started — Railway deploy gate + shutdown drain (§11) |
| POST `/v1/internal/revalidate` (secret) | Triggers Next.js tag revalidation on catalog edits |

## 7.3 Socket.io contract (`contracts/socket-events.ts`)

| Room | Joined by | Server → Client events | Client → Server |
|---|---|---|---|
| `order:{id}` | Customer (own), Ops, Admin | `order:status {status,at}`, `driver:location {lat,lng,ts}` | — |
| `driver:{id}` | That driver | `offer:new {offerId,orderId,pickup,drop,distanceM,commissionPaise,expiresInSec}`, `offer:cancelled` | `location:update {lat,lng}` (only while ASSIGNED/PICKED_UP), `status:online/offline` |
| `ops` | Ops/Admin | `order:new`, `order:update`, `alert {kind,msg}` | — |

Handshake auth: `{ auth: { token: <firebaseIdToken> } }` → verified server-side; room joins are authorization-checked (customer can only join own orders).

---

# 8. Authentication & Authorization

## 8.1 Identity

Firebase Auth Phone OTP is the single identity provider for all roles (customers self-serve; drivers/ops/admin numbers are pre-registered then role-elevated by admin). Backend uses `firebase-admin.verifyIdToken()` in a global `onRequest` hook (public routes opt out via route config). Tokens auto-refresh client-side hourly; no server session store.

## 8.2 Roles & claims

* PG `User.role` is the source of truth; on change, API sets Firebase custom claim `{ role }` and revokes refresh tokens (forces re-login with new claim).
* Driver additionally requires `DriverProfile.isVerified = true` for driver routes (guard checks DB, cached 60s).

## 8.3 RBAC matrix

| Resource | CUSTOMER | DRIVER | INVENTORY | ADMIN |
|---|---|---|---|---|
| Catalog read | ✅ | ✅ | ✅ | ✅ |
| Own cart/orders/addresses | ✅ CRUD | — | — | read |
| Rx upload | ✅ own | — | read | read |
| Rx approve/reject | — | — | ✅ | ✅ |
| Order pack/ready/cancel | cancel per matrix | — | ✅ | ✅ |
| Offers/deliveries | — | ✅ own | read | read |
| Own wallet/payout request | — | ✅ | — | read |
| Catalog/batch/stock write | — | — | ✅ | ✅ |
| Payout approve/pay | — | — | — | ✅ |
| Users/roles/coupons/settings/reports | — | — | — | ✅ |

Implementation: `app.get(path, { config: { roles: ['ADMIN'] } }, handler)` → one `rbac` plugin reads route config. Ownership checks (customer↔order, driver↔delivery) live in services, not just guards.

## 8.4 Session hardening

Expo stores tokens in `expo-secure-store`; web relies on Firebase SDK (IndexedDB) + strict CORS. Admin/ops panel: same OTP login, plus IP-allowlist and TOTP 2FA are flagged as v1.1 hardening items. Blocked users (`isBlocked`) are rejected at the auth hook regardless of valid token.

---

# 9. Core Domain Logic

## 9.1 Order state machine (pure module, exhaustively unit-tested)

```
PENDING_PAYMENT ─paid──▶ PLACED ─(requiresRx)─▶ RX_REVIEW ─approve─▶ PACKING
      │                    │  └─(no Rx)────────────────────────────▶ PACKING
      │timeout 15m         │reject Rx ──▶ CANCELLED(+refund,+restock)
      ▼                    ▼
  CANCELLED           PACKING ─▶ READY ─▶ ASSIGNED ─▶ PICKED_UP ─▶ DELIVERED
                         │          │        │(driver cancels→re-dispatch)
                         └──────────┴─ ops/admin cancel ─▶ CANCELLED
```

Transition table (from → allowed to, actor): encoded once in `stateMachine.ts`; every mutation calls `assertTransition(from, to, actorType)`. Each transition writes an `OrderEvent` and emits the socket event **inside the same code path** (after TX commit).

Timestamps: COD orders skip PENDING_PAYMENT → created directly as PLACED (or RX_REVIEW), `paymentStatus=COD_DUE`.

## 9.2 Checkout validation (server, order of checks)

store open → address within `serviceRadiusM` (haversine) → each item active, `qty ≤ maxPerOrder`, stock available → totals recomputed server-side from PG prices (client totals ignored) → coupon valid (window, limits, minOrder) → COD only if `total ≤ codLimitPaise` → Rx flag set if any item `requiresRx` (order accepted, Rx gate applied post-payment).

**Pricing:** `items = Σ price×qty` · `delivery = total≥freeAbove ? 0 : base` · `discount = coupon` · `total = items + delivery − discount`. GST is **inclusive** in `pricePaise` (Indian retail norm); invoice back-computes: `taxable = round(line / (1+r/100))`, split CGST/SGST equally (intra-state always — single city).

## 9.3 Payment & refunds

Prepaid: Razorpay order created in checkout TX scope; webhook `payment.captured` (idempotent via `PaymentEvent`) flips to PLACED/RX_REVIEW. `payment.failed` or 15-min timeout job → CANCELLED + stock release. Refunds (cancel/Rx-reject): `POST razorpay refunds` → `paymentStatus=REFUND_INITIATED` → webhook `refund.processed` → `REFUNDED`. COD: `codCollectedPaise` recorded at delivery; reconciled in admin cash report.

## 9.4 Stock reservation & FEFO

* **Reserve at order creation** (both PREPAID pending and COD): for each item, `UPDATE "Product" SET "stockQty" = "stockQty" - $qty WHERE id=$id AND "stockQty" >= $qty` — affected-rows≠1 → rollback → `409 STOCK_INSUFFICIENT` with per-item detail. This closes the pay-while-sold-out race.
* **Release** (timeout/cancel pre-pickup): reverse update + `StockAdjustment(CANCEL_RESTOCK)`.
* **FEFO at packing:** server proposes allocations from batches ordered by `expiryDate ASC` where `expiryDate > today + 30d`; pharmacist confirms/edits; `Batch.qtyAvailable` decremented conditionally; `ItemBatchAlloc` rows created (traceability + H1 register). Batches expiring <30d are excluded from FEFO and surface in the near-expiry report for write-off (`EXPIRY` adjustment).
* Weekly job: near-expiry (60d) report → ops notification.

## 9.5 Dispatch algorithm

```
on READY:
  wave 1: offers to 3 nearest online+verified drivers (haversine from lastLat/lng),
          expiresInSec = 25, FCM + socket offer:new
  wave 2 (25s, none accepted): all online drivers in radius
  every offer expiry handled by pg-boss job → status EXPIRED
  5 min unassigned → alert ops room + admin FCM ("assign manually / call driver")

accept (atomic, first wins):
  TX: UPDATE DeliveryOffer SET status='ACCEPTED' WHERE id=$id AND status='OFFERED';
      rows=0 → 409 OFFER_TAKEN
      INSERT Delivery(orderId UNIQUE) → unique violation → 409
      Order → ASSIGNED; expire sibling offers; notify customer + ops
```

Driver-initiated cancel before pickup → Delivery voided (event logged), order back to READY, re-dispatch; repeated cancels flagged on driver profile.

## 9.6 Wallet ledger (money invariants)

On `deliver` (OTP match required):

```
TX:
  SELECT wallet FOR UPDATE
  commission = base + perKm × ceil(distanceM/1000)         // from StoreConfig
  INSERT WalletTxn(CREDIT, commission, balanceAfter = bal + commission, ref ORDER)
  UPDATE Wallet.balancePaise
  Delivery.deliveredAt/otpVerifiedAt; Order → DELIVERED (+COD_COLLECTED)
  enqueue invoice-pdf job + notification job                // same TX via pg-boss
```

Payout: request (min ₹500, ≤ balance) → REQUESTED; admin approve → `WalletTxn(PAYOUT, DEBIT)` immediately (funds locked); mark-paid records UTR; reject → compensating CREDIT. Invariant test + nightly drift check: `wallet.balance === Σ(credits) − Σ(debits)`.

## 9.7 Delivery OTP & invoice

4-digit OTP generated at READY, shown only in customer app; 5 attempts max then ops unlock. Invoice job (post-DELIVERED): FY-sequential number from counter row, pdfkit render — store name, address, **GSTIN, Drug License No, Pharmacist name + Reg No**, HSN per line, CGST/SGST split, batch numbers for Rx items — upload to R2 private, key on order.

---

# 10. Security Architecture

## 10.1 Threat → control map (OWASP-aligned)

| Threat | Control |
|---|---|
| Broken auth | Firebase-verified JWT on every request; blocked-user check; role claims set server-side only; refresh-token revoke on role change |
| Broken access control | Central RBAC plugin + ownership checks in services; ops/admin split; socket room authorization |
| Injection | Prisma parameterized queries only (no string SQL); Zod validation on every input incl. query/params |
| Payment tampering | Totals recomputed server-side; Razorpay signature HMAC verified; amount cross-checked against order on capture; webhook idempotency PK |
| Replay / double-submit | `Idempotency-Key` on order/payout creation; delivery OTP; offer atomic accept |
| SSRF/file abuse | Uploads via API only: 5MB cap, MIME+magic-byte allowlist (jpeg/png/pdf), images re-encoded via sharp (strips EXIF/GPS), stored under server-generated keys |
| XSS/clickjacking | No `dangerouslySetInnerHTML`; `@fastify/helmet` (CSP, frame-ancestors none on ops), React escaping |
| CSRF | Token-in-header auth (no cookies) makes classic CSRF moot; strict CORS allowlist = [web, ops origins]; native app exempt |
| Rate abuse | `@fastify/rate-limit`: global 100/min/IP; `/auth/sync` 10/min/IP; `/orders` 5/min/user; OTP-verify 5 attempts; webhook route excluded (signature-gated) |
| Secrets leakage | Env stores only; `.env` git-ignored; Prisma `DATABASE_URL` private-network; pino redacts `phone`, `token`, `addressSnapshot` |
| Fake delivery / wallet fraud | OTP completion, append-only ledger, nightly balance drift audit, driver cancel-count flagging |
| Insider changes | `AuditLog` on price/stock/settings/role/payout actions; Rx decisions record reviewer |

## 10.2 Data protection & compliance (India-specific)

* **Prescriptions = sensitive medical data**: private R2 bucket, presigned GET (10-min TTL) only to ops/owner; never logged; retained **3 years** (Schedule H1 register + drug-license record rules) then purge job.
* **DPDP Act 2023 basics**: consent checkbox at signup (privacy policy + T&C links), purpose-limited collection, user data-deletion request flow (soft-delete user; order/Rx records retained for the statutory 3-year window — stated in policy), grievance contact on site.
* Regulatory display: drug license no., pharmacist name/reg no., FSSAI no., GSTIN in app footer and on every invoice.
* TLS everywhere (Vercel/Railway/Cloudflare managed certs); Postgres encryption at rest (Railway default); backups encrypted (gpg) before R2 upload.
* Log hygiene: request-id, uid, route, latency — never full tokens, OTPs, or Rx URLs.

## 10.3 Fraud & Abuse Controls

Checkout-time static rules — all thresholds are `AppSetting` flags, tunable without deploys:
* **COD refusal** (undelivered at door) increments `User.codRefusalCount`; **≥2 → COD disabled** for that user (prepaid-only, politely notified).
* **Velocity:** >3 orders/hour per user or per address-hash → 429 + ops alert.
* **Coupons:** `perUserLimit` enforced per user **and** per delivery-address hash.
* **New-account guard:** first order COD capped at ₹500 (`new_account_cod_cap`).

Rule hits are recorded on `OrderEvent`/`AuditLog`; admin ▸ Users shows `riskFlag` + reason trail, manual overrides audited. Risk *scoring* and device fingerprinting are Addendum items (S2-Growth, S3) — trigger: first real fraud incident.

## 10.4 Secrets Lifecycle

Quarterly rotation calendar (runbook `docs/runbooks/key-rotation.md`, ~30 min): Razorpay webhook secret (**dual-secret window** — verify old‖new for 24h, then drop old) · R2 keys (create #2 → swap env → delete #1) · `REVALIDATE_SECRET` · `BACKUP_GPG_PASSPHRASE` (re-encrypt latest dump) · Firebase service account (key #2 → swap → revoke #1). **Immediate rotation triggers:** staff departure, laptop loss, any secret appearing in logs/Sentry. Every secret exists in exactly one runtime place (Railway/Vercel/EAS stores) + one encrypted password-manager export (§16). Scale path: encryption keys move to a managed KMS; env then holds only references.

## 10.5 Supply-Chain & Runtime Hardening

* **Dependencies:** CI `security` job (§22.1) — `pnpm audit --prod --audit-level=high` fails the build; `--frozen-lockfile` installs everywhere; Renovate app (weekly grouped PRs, majors manual); GitHub Actions pinned to commit SHAs; postinstall scripts whitelisted (prisma, sharp, esbuild); repo secret-scanning + push protection ON.
* **Runtime:** API container runs non-root (`USER node`) when a custom Dockerfile is used — no shell tooling in the image. `unhandledRejection`/`uncaughtException` → `Sentry.flush()` → `exit(1)` (Railway restarts; a restarted process beats a corrupted one). Node heap sized via `--max-old-space-size` to plan memory. Outbound egress limited to the §14 host list — any other host appearing in logs is treated as an incident.

---

# 11. Performance Optimization

**Targets:** API p95 — reads <150ms, order create <400ms · PWA LCP <2.5s on mid-range Android/4G · driver offer→phone latency <2s · tracking update cadence 3–5s.

**Backend**
* Indexes as declared (§6) + trgm for search; `EXPLAIN ANALYZE` gate on any query touching `Order`/`Product` lists.
* Prisma `connection_limit=10` (Railway PG headroom); one process = no pool contention.
* **Location pings never hit Postgres** — in-memory map + throttled socket broadcast; persisted only on status transitions. This is the single biggest load-saver at scale.
* Heavy work (PDF, FCM fanout, reports) always via pg-boss — request path stays thin.
* Fastify JSON schema serialization (≈2× faster responses than manual `JSON.stringify` paths).

**Zero-downtime deploys (graceful shutdown)** — on SIGTERM (every Railway deploy): (1) `/readyz` flips 503 so routing stops (2) `server.close()` drains in-flight HTTP (3) `io.emit('server:restarting')` then `io.close()` — clients auto-reconnect to the new instance (4) `boss.stop({graceful:true})` finishes in-flight jobs (5) `prisma.$disconnect()` → exit 0. Budget 25s. A deploy never kills an order TX or strands a live tracking session.

**Customer PWA**
* Catalog pages ISR (60s) → served from Vercel edge; product images via `next/image` + R2 (AVIF/WebP, exact sizes).
* Route-level code splitting (App Router default); MapLibre (~200KB) `dynamic import` **only** on `/orders/[id]/track`; Razorpay script loaded only on checkout.
* Bundle budget: first-load JS <170KB gzip on `/`; CI `next build` output checked manually each phase.
* Font: Inter subset via `next/font` (zero layout shift); skeletons for all lists (CLS ≈ 0); TanStack Query cache makes back-nav instant.
* Serwist precaches shell; runtime SWR cache for images.

**Driver app (Expo)**
* Hermes engine; FlatList virtualization; location task active only while online-with-delivery (battery); offer modal pre-rendered (no cold mount when FCM arrives).

---

# 12. Caching Strategy

| Layer | What | TTL / invalidation |
|---|---|---|
| Vercel edge (ISR) | Catalog pages, category lists | 60s revalidate **+ on-demand**: ops product edit → API calls `/v1/internal/revalidate` → `revalidateTag('catalog')` — edits visible in seconds, not TTL |
| HTTP `Cache-Control` | `GET /products*`, `/categories`, `/store` → `s-maxage=60, stale-while-revalidate=300` | Time-based |
| API in-memory LRU | `StoreConfig`, categories (hot, tiny) | 60s; explicit bust on settings save |
| TanStack Query | All client reads | `staleTime` 30s lists / 5min product detail; mutation-driven invalidation |
| Never cached | Cart, orders, stock counts, wallet, anything ops/admin | `no-store` |

No Redis in v1 — the cache hierarchy above covers this scale; Redis enters only with multi-instance Socket.io (§5 scale path).

---

# 13. File Storage

| Bucket | Contents | Access | Pipeline |
|---|---|---|---|
| `medrush-public` | Product/category images, static banners | Public via Cloudflare CDN | Ops upload → API (sharp: resize 1200px, AVIF/WebP variants, strip metadata) → R2 → CDN URL saved on product |
| `medrush-private` | Prescriptions, invoices, DB backups | Presigned URLs only (GET 10min; no public policy) | Rx: customer multipart → validate → re-encode → `rx/{orderId}/{cuid}.jpg` · Invoices: pdfkit job → `inv/{fy}/{invoiceNo}.pdf` · Backups: `backups/pg/{date}.sql.gz.gpg` |

Keys are server-generated (no user-controlled paths). Lifecycle: Rx + invoices retained 3 years (compliance) then purged by monthly job; backups per §16 retention.

---

# 14. Third-Party Integrations

| Provider | Purpose | Mode | Failure behavior |
|---|---|---|---|
| Firebase Auth | OTP identity, role claims | Client SDK + admin verify | Login unavailable → static status page; API rejects cleanly (401) |
| Razorpay | Prepaid payments, refunds | Checkout.js + Orders API + **webhooks** (signature, idempotent, retried by Razorpay) | Payment down → COD path still works; timeout job auto-cancels stuck orders |
| FCM | Push (offers, status) | Admin SDK, tokens per device | Push failure never blocks a TX (jobs retry ×3); socket + polling are functional fallbacks |
| Ola Maps | Address autocomplete, map tiles (MapLibre) | REST + tiles | Autocomplete down → manual pin-drop on map still works |
| Google Maps app | Driver turn-by-turn | Intent deep-link | Not installed → geo: URI chooser |
| Cloudflare R2 | Object storage | S3 SDK presign | Upload retry ×3; Rx upload failure blocks only Rx orders (clear client error) |
| Sentry / Better Stack | Errors / uptime | SDKs / HTTP ping | Observability loss never affects request path |
| Resend (optional) | Invoice emails | Job-based | Silent skip; invoice always in-app |
| WhatsApp Cloud API (v1.1) | Order updates via WhatsApp | Meta Cloud API (operator has prior GHD integration) | Deferred |

All external calls: 5s timeout, wrapped, retried only where idempotent, and **never inside a DB transaction** (enqueue → job calls out).

---

# 15. Monitoring & Logging

* **Structured logs (pino):** every request → `{reqId, uid, role, method, path, status, ms}`; domain events at info (`order.placed`, `dispatch.wave2`, `wallet.credit`); redaction list enforced. Railway retains stream; Better Stack log drain optional.
* **Sentry:** API (fastify plugin, release-tagged), both Next apps, Expo (`sentry-expo` + source maps via EAS). Alert on new issue + error-rate spike.
* **Health:** `/healthz` = liveness (process). `/readyz` = PG `SELECT 1` + migrations current + boss started — Railway deploy gate + shutdown drain (§11). Better Stack pings `/readyz` every 60s → WhatsApp/email alert.
* **Business watchdogs (pg-boss cron):** every 5 min flag orders stuck (PLACED>10m unpacked, READY>7m unassigned, PICKED_UP>40m) → ops socket alert + admin FCM. Nightly: wallet drift audit, stock-vs-batch reconciliation, failed-job report.
* **Admin dashboard = product analytics v1:** orders/day funnel (placed→delivered), cancellation reasons, avg pack/assign/ride times vs 40-min SLA, COD vs prepaid mix, top products, driver leaderboard. (GA4 on PWA optional.)

**Alert rules:** uptime down >2min · 5xx >2% over 5min · webhook signature failures >3/hr · payment-timeout spike · any wallet drift ≠ 0 · job dead-letter >0.

---

# 16. Backup & Disaster Recovery

| Asset | Method | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | Railway snapshots **+ pg-boss cron `pg_dump \| gzip \| gpg` → R2** (belt & suspenders, provider-independent) | Daily 02:30 IST | 30 daily + 12 weekly |
| R2 objects | Bucket versioning + monthly `rclone sync` to second bucket | Continuous/monthly | 90d versions |
| Config/secrets | Encrypted export of Railway/Vercel/EAS env sets in password manager | On change | Latest 3 |
| Code | GitHub (source of truth); tags per release | — | Forever |

**RPO ≤ 24h** (upgrade path: hourly WAL archiving when volume justifies) · **RTO ≤ 2h**, drilled.

**Runbook — total DB loss:** (1) `railway add postgresql` fresh instance → (2) download latest dump from R2, `gpg -d | gunzip | psql` → (3) point `DATABASE_URL`, redeploy API → (4) `/healthz` + smoke: place COD test order end-to-end → (5) reconcile Razorpay dashboard vs orders for the gap window → (6) announce downtime end. **Restore drill monthly** into a scratch Railway PG — an untested backup is a rumor. Runbooks live in `docs/runbooks/` (db-restore, razorpay-outage, rollback, key-rotation, store-close-switch).

---

# 17. Complete Feature List

Legend: ✅ v1 launch · 🔜 v1.1 (post-launch backlog, schema-ready)

**Customer PWA**
| Feature | v |
|---|---|
| Phone OTP login/signup, profile | ✅ |
| Home: search (fuzzy), categories, banners, store-open banner, reorder shortcut | ✅ |
| Product list/detail: images, MRP strikethrough, pack size, **Rx-required badge**, stock/out-of-stock, per-order qty cap | ✅ |
| Cart (server-synced), price re-validation, min-order nudge, free-delivery progress bar | ✅ |
| Address book, map pin + Ola autocomplete, serviceability check | ✅ |
| Checkout: coupon apply, Razorpay (UPI/cards/NB) or COD (limit), delivery fee logic | ✅ |
| Rx upload (camera/gallery/PDF) at checkout for flagged items; Rx status visibility | ✅ |
| Live order screen: status timeline, packing→riding, **driver on map**, ETA, delivery OTP display, call driver | ✅ |
| Orders history, detail, GST invoice download, cancel (per matrix), refund status | ✅ |
| Push + in-app notifications; PWA install prompt; offline fallback page | ✅ |
| Support: WhatsApp deep-link + call | ✅ |
| Ratings, referral program, refill reminders (meds repeat!), wishlists, substitutes suggestions | 🔜 |

**Driver app**
| Feature | v |
|---|---|
| OTP login (pre-verified numbers), profile + vehicle info | ✅ |
| Online/offline toggle; foreground location while on duty | ✅ |
| Offer modal: pickup/drop, distance, **commission shown upfront**, 25s countdown, sound+vibration | ✅ |
| Active delivery: customer address, call (tel:), **Navigate** (Google Maps deep-link), picked-up action, OTP entry to complete, COD amount collect prompt | ✅ |
| Wallet: balance, ledger, payout request (UPI), payout history | ✅ |
| Day/week earnings summary, delivery history | ✅ |
| Auto re-dispatch on cancel; offline-grace reconnect; EAS OTA updates | ✅ |
| Incentive schemes, heatmap, shift scheduling | 🔜 |

**Ops panel (pharmacist)**
| Feature | v |
|---|---|
| Live order board (New / Rx queue / Packing / Ready) with sound on new order | ✅ |
| **Rx review screen:** zoomable image/PDF, approve/reject + note, capture patient/doctor name (H1) | ✅ |
| Packing screen: item checklist, **bin locations ("R2-S3")**, **FEFO batch suggestions**, barcode-free batch confirm, mark Ready (prints OTP-less packing slip) | ✅ |
| Catalog CRUD, image upload, Rx/schedule flags, price/MRP/GST/HSN | ✅ |
| **GRN:** receive batches (batch no, expiry, qty, cost, wholesaler, invoice no) | ✅ |
| Stock adjustments (damage/expiry/correction), low-stock & near-expiry dashboards | ✅ |
| **Fridge temperature register**: 2×/day manual log widget, missed-log reminders (10am/6pm), 2–8°C breach → admin alert + cold-chain batch review, monthly PDF export (inspection-ready) | ✅ |
| Order cancel w/ reason (auto refund+restock) | ✅ |
| Purchase-order suggestions from velocity, barcode scanning | 🔜 |

**Admin panel**
| Feature | v |
|---|---|
| KPI dashboard (today/7d/30d): orders, revenue, AOV, on-time %, cancellations, COD cash due | ✅ |
| Orders explorer + CSV export; manual order intervention | ✅ |
| Driver mgmt: onboard/verify/block, docs, live last-known map, per-driver stats | ✅ |
| Payout queue: approve → mark paid (UTR) with ledger automation | ✅ |
| User mgmt: block, role assignment (sets Firebase claim) | ✅ |
| Coupons CRUD with limits/windows | ✅ |
| Settings: store hours/kill-switch, radius, fees, commission, COD limit — audited | ✅ |
| **Reports: GST summary, sales register, Schedule H1 register export, COD reconciliation** | ✅ |
| Multi-store, staff sub-roles, RazorpayX auto-payouts, WhatsApp campaign hooks | 🔜 |

---

# 18. User Flows

**18.1 Prepaid order (with Rx branch)**
1 Browse → add to cart (server sync) → 2 Checkout: address ✓ serviceable, coupon, PREPAID → 3 If any Rx item: upload prescription (blocking) → 4 POST /orders → stock reserved, Razorpay sheet → 5 Pay (UPI etc.) → webhook → PLACED or **RX_REVIEW** → 6 Pharmacist approves → PACKING → READY (OTP generated, shown to customer) → 7 Dispatch waves → driver accepts → ASSIGNED (driver name/photo visible) → 8 PICKED_UP → live map + status timeline → 9 Doorstep: customer tells OTP → driver enters → DELIVERED → commission credited → 10 Invoice PDF ready in order detail. *(Rx rejected at step 6 → auto CANCELLED, refund initiated, stock restored, reason notified.)*

**18.2 COD order** — same, minus payment sheet; order lands PLACED/RX_REVIEW instantly with `COD_DUE`; driver collects exact `totalPaise`, marks collected at OTP step.

**18.3 Cancellation & refund matrix**
| Status at cancel | Customer | Ops/Admin | Effect |
|---|---|---|---|
| PENDING_PAYMENT | ✅ (or auto 15m) | ✅ | release stock; no charge |
| PLACED / RX_REVIEW | ✅ one-tap | ✅ | restock + full refund (prepaid) |
| PACKING / READY | request → ops approves | ✅ | restock + full refund |
| ASSIGNED / PICKED_UP | ❌ (call support) | ✅ exceptional | driver returns items → ops restock via CANCEL_RESTOCK; full refund; delivery attempt logged |
| DELIVERED | — | refund-only path (admin), no auto restock | manual return handling |

**18.4 Driver day** — go online → offer ping (sound) → 25s decide (commission visible) → accept → navigate to store → show order no → picked-up → navigate to customer → OTP (+ collect COD) → delivered → wallet credited instantly → next offer. Payout: wallet → request ≥₹500 → admin pays UPI → UTR visible.

**18.5 Restock (GRN)** — pharmacist: wholesaler bill in hand → Ops ▸ product ▸ Add Batch (batch no, expiry, qty, cost, invoice no) → stock cache += qty → bill filed physically (inspection).

---

# 19. Ops & Admin Workflows

**Pharmacist daily SOP:** open store toggle ▸ **log fridge temp (AM)** ▸ clear overnight alerts ▸ work Rx queue first (SLA <5 min/review) ▸ pack in READY-order (target ≤10 min from PLACED) ▸ afternoon: GRN entries + near-expiry check ▸ close: **log fridge temp (PM)**, toggle store off, verify no stuck orders, cash-COD tally with drivers.
**Admin weekly:** Mon payout run (approve→pay→UTR) ▸ COD reconciliation vs `codCollected` report ▸ review cancellations & stuck-order log ▸ price/margin spot-check (audit log) ▸ backup-restore drill (monthly) ▸ export H1 register (monthly, file for 3y).
**Driver onboarding:** admin creates number+role → driver installs APK/Play → OTP login → docs (license, vehicle) → verify toggle → test delivery → live.
**Incident:** store kill-switch (StoreConfig.isOpen=false) instantly blocks checkout with friendly banner — first lever for pharmacist absence, stock chaos, or weather.

---

# 20. UI/UX Design System

## 20.1 Principles
Trust-first (medical), thumb-first (one-hand mobile), speed-perceived (skeletons everywhere, optimistic cart), bilingual-ready (EN + Hindi strings via i18n keys from day one; Devanagari-safe fonts).

## 20.2 Tokens

```css
/* color */
--primary-600:#0D9488; --primary-700:#0F766E;      /* pharmacy teal */
--ink-900:#0F172A; --ink-600:#475569; --ink-400:#94A3B8;
--surface:#FFFFFF; --surface-2:#F8FAFC; --line:#E2E8F0;
--success:#16A34A; --warning:#D97706; --danger:#DC2626; --info:#2563EB;
--rx:#7C3AED;                                      /* Rx badge violet */
--accent:#F59E0B;                                  /* offers/free-delivery */
/* type: Inter + "Noto Sans Devanagari" fallback */
--fs-12/-14/-16(-base)/-18/-20/-24/-30; weights 400/500/600/700; lh 1.5 body, 1.25 headings
/* space 4pt: 4 8 12 16 20 24 32 40 48 64  · radius: 8 input, 12 card, 16 sheet, 999 pill
   shadow: sm(0 1px 2px/.06) md(0 4px 12px/.08) lg(0 12px 32px/.12)
   motion: 150ms ease-out micro · 250ms cubic-bezier(.2,.8,.2,1) sheets · respect prefers-reduced-motion */
```

Customer app: light theme only (v1). **Driver app: dark, high-contrast theme** — sunlight + night riding, 56px min buttons, haptic + sound on offers. Ops: light, dense tables, keyboard-friendly.

## 20.3 Component inventory (`packages/ui`)
Button(primary/secondary/ghost/destructive, loading), Input+PhoneInput+OTPInput, SearchBar(debounced), Select, QuantityStepper, Chip/Badge(incl. RxBadge, StockBadge), ProductCard, CartBar(sticky), PriceRow, BottomSheet, Modal, Toast, Skeleton set, EmptyState, ErrorState(retry), StatusTimeline, MapView(MapLibre wrapper), StatCard, DataTable(sort/filter/csv), Tabs, SideNav(ops), ConfirmDialog, FileDropzone(Rx), CountdownRing(driver offer).

## 20.4 Screen states — every list/detail ships all four: loading skeleton · empty (illustration + CTA) · error (message + retry) · offline (banner + cached view). Order tracking additionally: socket-reconnecting indicator, "driver arriving" state.

## 20.5 Responsive & mobile experience
Breakpoints 640/768/1024/1280. **Customer:** app-shell pattern — mobile-first column, max-w-md centered with subtle backdrop on desktop (Blinkit-style), bottom tab nav (Home/Orders/Cart/Account), sticky checkout CTA in thumb zone, safe-area insets, 44px min targets. **Ops/Admin:** desktop-first, sidebar → drawer <1024px, tables → card lists <768px (tablet-at-counter works). **PWA specifics:** install prompt after first delivered order, offline page, app icons/splash, `display: standalone`. **Driver:** portrait-locked, mega-buttons, offer modal renders over lockscreen-adjacent state via high-priority FCM.

## 20.6 Accessibility (WCAG 2.1 AA)
Contrast ≥4.5:1 (teal-on-white verified), visible focus rings, labeled inputs, `aria-live=polite` on order status changes, alt text on product images, RN `accessibilityLabel`/`Role` throughout, no color-only meaning (icons+text on statuses), full keyboard nav on ops tables.

---

# 21. Development Workflow

## 21.1 Local setup (target: clone → running in <10 min)
```bash
git clone … && cd medrush
nvm use && corepack enable && pnpm i
docker compose -f docker-compose.dev.yml up -d      # postgres:16
cp .env.example backend/api/.env                     # fill Firebase/Razorpay TEST keys
pnpm db:migrate && pnpm db:seed                      # demo catalog, store cfg, admin/driver users
pnpm dev                                             # turbo: api :4000, web :3000, ops :3001
pnpm dev:driver                                      # expo start (Expo Go / dev build)
```
Seed script creates: 2 categories, 12 products (mix of supplement/OTC/Rx), 3 batches each, store config, one user per role, a delivered demo order. Razorpay test-mode + webhook via `ngrok`/Razorpay test events.

## 21.2 Git workflow
* **Trunk-based:** `main` protected (CI must pass); short-lived `feat/*`, `fix/*` branches; squash-merge; Conventional Commits (`feat(orders): …`) → readable history + easy changelogs.
* **Solo + AI review ritual (non-negotiable):** every PR gets (1) self-review of the diff, (2) a Claude Code review pass with a fixed prompt checking: state-machine legality, TX boundaries around stock/wallet, Zod coverage on new routes, authz on new endpoints, migration safety. Codex-generated code never merges without this pass.
* PR template checklist: contracts updated? migration expand-safe? tests for domain logic? audit-log for sensitive action? docs/BLUEPRINT drift?

## 21.3 Testing strategy
| Layer | Tool | Scope (what actually gets tested) | Bar |
|---|---|---|---|
| Unit | Vitest | `stateMachine`, pricing/GST math, commission, FEFO allocator, ledger invariants, coupon rules — pure functions | 90%+ on `modules/**/(stateMachine|ledger|pricing|fefo)` |
| Integration | Vitest + `app.inject()` + docker PG | Order create (happy, stock-race with `Promise.all` ×5 parallel buyers, idempotency replay), webhook idempotency, offer race (two accepts), deliver+wallet TX, RBAC 403s | All money/stock paths |
| E2E | Playwright | Web: browse→COD checkout→(ops app) Rx approve→pack→ready; API-simulated driver completes; invoice appears | 1 golden path, runs in CI |
| Mobile | Manual checklist + Maestro (optional later) | Offer receive w/ app backgrounded, OTP flow, location while riding, OTA update | Pre-release checklist in docs/ |

`pnpm test` (unit+int) < 3 min locally. Playwright nightly + pre-release.

## 21.4 Environment management
| Env | API | Web/Ops | DB | Keys |
|---|---|---|---|---|
| local | :4000 | :3000/:3001 | docker | Firebase dev project, Razorpay TEST |
| preview | prod API (read-mostly) or local | Vercel preview per PR | — | TEST keys |
| production | Railway | Vercel prod | Railway PG | LIVE keys, webhook secret |
Env access via a single validated `config.ts` (Zod-parsed `process.env` — boot fails loudly on missing keys).

---

# 22. CI/CD & Deployment Pipeline

## 22.1 GitHub Actions (`ci.yml`)
```
on: [pull_request, push→main]
jobs:
  quality:   pnpm i → turbo lint typecheck → prisma validate + migrate diff (warn on destructive)
  security:  pnpm audit --prod --audit-level=high (fail) · frozen-lockfile · Renovate weekly PRs ·
             Actions pinned to SHAs · postinstall whitelist (prisma, sharp, esbuild) · secret-scanning ON
  test:      services: postgres:16 → pnpm test (unit+integration)
  build:     turbo build (api, web, ops)         # driver app built by EAS, not CI
  e2e(main): playwright golden path (non-blocking first month)
```
Merge to `main` requires quality+test+build green.

## 22.2 Deploy & release
* **API (Railway):** auto-deploy on main; pre-deploy cmd `pnpm --filter api prisma migrate deploy`; health-check gated; **migration policy: expand → deploy → contract** (destructive column changes ship one release after code stops using them) so rollbacks never fight the schema.
* **Web/Ops (Vercel):** auto prod deploy on main; preview per PR.
* **Driver (EAS):** channels `preview` (internal APK, WhatsApp-shareable) and `production` (AAB → Play staged rollout 20%→100% over 48h). JS-only fixes: `eas update` OTA, minutes not days. `runtimeVersion` policy pinned so OTA never hits an incompatible native shell. Contract-breaking driver releases bump `minDriverAppVersion` (StoreConfig) → stale clients get `426 UPGRADE_REQUIRED` + blocking update screen (§7.1).
* Version tags `v1.x.y` on main after driver-app releases; CHANGELOG from conventional commits.

## 22.3 Rollback matrix
| Surface | Action | Time |
|---|---|---|
| API | Railway → redeploy previous build (schema safe by expand/contract) | <2 min |
| Web/Ops | Vercel "Instant Rollback" | <1 min |
| Driver | Halt Play rollout + `eas update --branch production` revert for JS | mins (JS) / hrs (native) |
| DB | Point-in-time snapshot / R2 dump restore (runbook) | ≤2 h |

---

# 23. Development Roadmap

Solo dev + Claude Code (architecture/security/review) + Codex (specced CRUD/UI). Each phase = one work package: brief in `docs/phase-briefs/`, contracts frozen first, agents implement, human+Claude review, DoD gate. **Total: ~11 weeks to launch.**

**Phase 0 — Foundations (3 days)**
Goal: repo that enforces the rules. Deliverables: monorepo scaffold, `contracts` pkg with ALL enums/schemas from §6–§7, config-validated env, CI green, docker PG, seed, Fastify skeleton (health, auth hook stub, swagger), Prisma schema migrated. Depends: —. Verify: fresh clone→`pnpm dev` works; CI passes; `/healthz` 200. **DoD: another agent can implement a module using only contracts + this doc.**

**Phase 1 — Core API: auth, catalog, cart, orders (COD-first) (1.5 wk)**
Deliverables: auth/sync + RBAC plugin; catalog read + trgm search; server cart; serviceability; checkout with stock reservation + state machine + events; COD path E2E at API level; idempotency keys; ops order endpoints (list/detail/pack/ready minimal); stuck-order watchdog job. Verify: parallel stock-race test green; illegal transitions rejected; Postman/GoldenPath collection passes. **DoD: a COD order can be driven PLACED→DELIVERED via API calls alone (driver simulated), stock+events correct.**

**Phase 2 — Payments & Rx (1 wk)**
Deliverables: Razorpay order/checkout/webhook (idempotent), payment-timeout job, refunds; Rx upload→R2 private→review endpoints; RX_REVIEW gate; invoice job (pdfkit, FY counter, license fields). Depends: P1. Verify: webhook replay = no double-processing; Rx-reject auto-refunds+restocks; invoice PDF fields complete. **DoD: prepaid + Rx orders fully functional with money-safe tests green.**

**Phase 3 — Ops/Admin panel (1.5 wk)**
Deliverables: `ops` app: login, live board (socket), Rx review UI (zoom viewer), packing w/ FEFO allocations, catalog CRUD + image pipeline, GRN, adjustments, low-stock/near-expiry views; admin: dashboard KPIs, settings, users/roles, coupons, drivers CRUD (verify), payout queue, reports (sales/GST/H1 CSV). Depends: P1–2. Verify: pharmacist can process a real order start-to-finish on a tablet without touching DB; audit logs written. **DoD: store is operable by non-developer using only this panel.**

**Phase 4 — Customer PWA (2 wk)**
Deliverables: full customer app per §17/§20 — home/search/PLP/PDP, cart, address (Ola autocomplete + pin), checkout (Razorpay+COD), Rx upload, orders+detail+cancel+invoice, notifications, Serwist PWA, ISR + revalidate hook, i18n scaffold. Depends: P1–2. Verify: Lighthouse ≥90 perf/95 a11y on mid-tier throttle; golden E2E green; real order on real phone. **DoD: a stranger can order without help; LCP <2.5s.**

**Phase 5 — Driver app + dispatch + wallet (2 wk)**
Deliverables: dispatch waves + offers + atomic accept + expiry jobs; Expo app: login, online toggle, offer modal (FCM data-msg + sound), active-delivery flow, Maps deep-link, OTP delivery + COD collect, wallet/ledger/payout screens; location→socket pipeline + in-memory broadcast; admin payout ops wired to ledger. Depends: P1–3. Verify: two test phones — offer race resolves single winner; wallet credited exactly once (kill-app retry test); background location works on Android 14. **DoD: real 3-device demo (customer/ops/driver) completes a live 40-min delivery.**

**Phase 6 — Live tracking + notification polish (1 wk)**
Deliverables: customer tracking screen (MapLibre marker, timeline, ETA heuristic), socket auth+rooms hardened, polling fallback, FCM topics per role, notification center, WhatsApp deep-links. Depends: P5. Verify: tracking survives socket drop (fallback), no cross-order room leaks (authz test). **DoD: end-to-end UX matches §18.1 exactly.**

**Phase 7 — Hardening & launch (1 wk)**
Deliverables: rate limits tuned, helmet/CSP, Sentry all surfaces, Better Stack, backup cron + first restore drill, load sanity (k6: 50 concurrent checkouts), security pass (Claude Code adversarial review of authz/money paths), legal pages (privacy/DPDP, T&C, license display), Play Store listing + internal→prod track, seed real catalog with pharmacist, driver onboarding, **Production Checklist §24 fully ticked**. **DoD: soft launch — 10 friendly-user orders delivered, zero Sev-1.**

Post-launch backlog (v1.1, priority order): WhatsApp notifications → refill reminders → ratings → referral → RazorpayX auto-payouts → barcode GRN → 2FA/IP-allowlist admin. Beyond that, Addendum items ship **by trigger, not by calendar** (see `BLUEPRINT-ADDENDUM-v1.1.md`).

---

# 24. Production Launch Checklist

**Infra/Env** ☐ Railway prod service + PG, `/readyz` deploy gating ☐ custom domains + TLS (api/app/ops) ☐ Cloudflare proxy + WAF ON, origin locked ☐ all env vars set & validated boot ☐ Prisma `migrate deploy` clean ☐ pg-boss crons registered (timeout, watchdog, backup, expiry-scan, drift-audit) ☐ feature-flag defaults reviewed (risky = OFF)
**Payments** ☐ Razorpay LIVE keys ☐ webhook URL + secret configured, test event verified ☐ refund tested LIVE small amount ☐ COD limit set
**Security** ☐ CORS allowlist prod-only ☐ rate limits on ☐ helmet/CSP verified ☐ webhook sig test ☐ presigned Rx URLs expire ☐ admin accounts limited & audited ☐ CI security job green (audit + lockfile + pinned actions) ☐ fraud rules active (COD refusal, velocity, new-account cap) ☐ 426 app-version gate test-fired
**Data** ☐ nightly backup ran + **restore drill passed** ☐ R2 versioning on ☐ seed removed / real catalog loaded (prices, GST, HSN, Rx flags reviewed by pharmacist)
**Compliance** ☐ Drug License no. + Pharmacist name/RegNo + FSSAI + GSTIN in StoreConfig → footer & invoice render ☐ privacy policy (DPDP) + T&C live ☐ Rx-gate tested (cannot pack unapproved) ☐ H1 register export verified ☐ invoice numbering FY counter correct ☐ fridge temperature register live (≥2 logs recorded)
**Apps** ☐ Play listing (screenshots, data-safety form incl. location) ☐ staged rollout plan ☐ EAS OTA channel sane ☐ PWA installability (manifest/icons/offline) passes
**Observability** ☐ Sentry DSNs all surfaces, release tags ☐ uptime monitor + alert channel (WhatsApp) ☐ stuck-order watchdog alert test-fired
**Ops readiness** ☐ pharmacist trained on panel SOP (dry run ×3) ☐ ≥3 drivers verified, test paid ☐ store kill-switch drill ☐ support number live ☐ runbooks printed/linked
**Day-1** ☐ soft-launch radius 3km ☐ founder monitors ops room live ☐ first-10-orders manual QA ☐ retro after 48h

---

# 25. Cost Summary

| Item | Monthly | Notes |
|---|---|---|
| Railway (API + PG) | ₹850–1,500 | usage-based; set resource caps |
| Vercel ×2 apps | ₹0 | hobby tier sufficient at launch |
| Cloudflare R2 + DNS | ₹0–200 | 10GB free; egress ₹0 |
| Firebase Auth SMS | ~₹0.5–1/login | Blaze pay-per-OTP; budget ₹300–800 |
| Ola Maps | ₹0–500 | free tier covers autocomplete+tiles initially |
| Sentry / Better Stack / FCM | ₹0 | free tiers |
| Domain | ~₹100 | amortized |
| **Run-rate total** | **~₹1,500–3,000/mo** | pre-scale |
| One-time | Play Console ₹2,100 · (licensing/setup per business plan ~₹30–50k, outside tech budget) | |
| Per-transaction | Razorpay ~2% on prepaid | COD ₹0 |

---

# 26. Appendix A — Environment Variables

**backend/api** `DATABASE_URL` · `PORT` · `NODE_ENV` · `FIREBASE_PROJECT_ID` · `FIREBASE_CLIENT_EMAIL` · `FIREBASE_PRIVATE_KEY` · `RAZORPAY_KEY_ID` · `RAZORPAY_KEY_SECRET` · `RAZORPAY_WEBHOOK_SECRET` · `R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_PUBLIC_BUCKET` · `R2_PRIVATE_BUCKET` · `R2_PUBLIC_CDN_URL` · `OLA_MAPS_API_KEY` · `SENTRY_DSN` · `REVALIDATE_SECRET` · `BACKUP_GPG_PASSPHRASE` · `WEB_ORIGIN` · `OPS_ORIGIN` · `RESEND_API_KEY?`

**frontend/web & frontend/ops** `NEXT_PUBLIC_API_URL` · `NEXT_PUBLIC_FIREBASE_*` (apiKey, authDomain, projectId, appId, messagingSenderId) · `NEXT_PUBLIC_RAZORPAY_KEY_ID` (web only) · `NEXT_PUBLIC_OLA_MAPS_KEY` · `NEXT_PUBLIC_SENTRY_DSN` · `REVALIDATE_SECRET` (web server-side)

**frontend/driver (EAS secrets)** `EXPO_PUBLIC_API_URL` · `EXPO_PUBLIC_FIREBASE_*` · `SENTRY_DSN` · `GOOGLE_SERVICES_JSON` (FCM)

---

*End of Blueprint v1.1 — treat §6–§9 as frozen contracts; amend this document first, code second. Growth/Scale additions staged in `BLUEPRINT-ADDENDUM-v1.1.md`, shipped by trigger.*
