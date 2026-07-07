# Phase 4 — Customer PWA

Binding brief for Phase 4. Extends phase-0-conventions + the phase-3 frontend patterns (the ops app is
the reference implementation). Blueprint sections: §5 (structure), §7.2 (Customer endpoints), §9.2–§9.3
(checkout/payments), §13 (Rx), §17 (customer flows), §20 (UI/UX — mobile app-shell). Depends: P1–P2
(all customer APIs already shipped + tested — NO backend changes this phase).

**DoD (§23):** a stranger can place an order without help — browse → cart → checkout (COD) →
order placed → track → invoice — end-to-end, locally, with no real credentials. Prepaid + Rx flows
also work locally via stubs. `next build` + `tsc` + `eslint` clean; live smoke against the API green.

## App

`frontend/web` — Next.js 15 App Router, React 19, TypeScript strict, Tailwind (shared preset), TanStack
Query, `@medrush/contracts` for all types, socket.io-client for live order tracking. Package `@medrush/web`,
dev port 3000. **Mobile-first app-shell (§20.2):** a centered `max-w-md` column on a subtle backdrop
(Blinkit-style), a sticky top bar, and a bottom tab nav (Home · Orders · Cart · Account); 44px min
targets, safe-area insets, light theme only. Reuse the ops app's lib/api pattern (typed envelope client +
ApiError) and lib/auth pattern (dev-login + Firebase) — copy, then adapt to mobile.

## Overriding principle (carried from P2/P3): everything third-party has a LOCAL STUB MODE

- **Auth**: dev-login form mints the backend dev token `dev:<firebaseUid>:<phone>` (seeded
  `seed-firebase-customer`, phone `+919876543210`); Firebase phone-OTP swaps in when
  `NEXT_PUBLIC_FIREBASE_*` is set. New customers self-serve via `POST /v1/auth/sync` after OTP; in dev the
  seeded customer just works, and a dev "sign up" can call `/v1/auth/sync` with a fresh dev uid.
- **Payments (checkout)**: COD is the primary, fully-local path. PREPAID: `POST /v1/orders`
  `{paymentMethod:"PREPAID"}` returns `{ order(PENDING_PAYMENT), razorpay:{rzpOrderId,rzpKeyId,amountPaise} }`.
  When `NEXT_PUBLIC_RAZORPAY_KEY_ID` is set → open real Razorpay Checkout.js. Otherwise (stub) → show a
  dev "Simulate payment" control that HMAC-signs a `payment.captured` webhook body (Web Crypto, secret
  `"dev-webhook-secret"`) and POSTs it to `/v1/webhooks/razorpay` — exactly what the P2 tests do — so the
  full prepaid capture → PLACED flow is exercisable locally. Put that in `lib/devPayment.ts`, dev-only.
- **Rx**: for a cart with `requiresRx`, after order create the order is RX_REVIEW; the customer uploads
  via `POST /v1/orders/:id/prescriptions` (multipart, single `file`) — a FileDropzone on the order/checkout.
- **Maps (Ola autocomplete)**: NOT wired this phase — address entry is a manual form + a "use my location"
  (browser geolocation → lat/lng) + the `POST /v1/serviceability` check. Ola autocomplete is a later item.

## Customer API surface (all exist; §7.2) — implement EXACTLY to these contracts

- Store/serviceability (`schemas/catalog.ts`): `GET /v1/store` → StoreInfo; `POST /v1/serviceability` {lat,lng} → ServiceabilityResult.
- Catalog (`schemas/catalog.ts`): `GET /v1/categories` → Category[]; `GET /v1/products?category&search&cursor&limit` → ProductSummary[]+meta; `GET /v1/products/:slug` → Product.
- Cart (`schemas/cart.ts`): `GET /v1/cart`; `PUT /v1/cart/items` {productId,qty} (upsert, sets exact qty); `DELETE /v1/cart/items/:productId`; `POST /v1/cart/validate` → ValidateCartResult {valid,issues[],cart,totals}.
- Addresses (`schemas/*`): `GET/POST /v1/addresses`, `PATCH/DELETE /v1/addresses/:id`.
- Auth (`schemas/auth.ts`): `POST /v1/auth/sync`, `GET/PATCH /v1/me`.
- Orders (`schemas/order.ts`): `POST /v1/orders` (Idempotency-Key header; COD or PREPAID); `GET /v1/orders?cursor&status` → OrderSummary[]+meta; `GET /v1/orders/:id` → OrderDetail; `GET /v1/orders/:id/track` → TrackOrderResult; `POST /v1/orders/:id/cancel` {reason}; `POST /v1/orders/:id/prescriptions` (multipart); `GET /v1/orders/:id/invoice` → {url,expiresInSec}.
- Devices: `POST /v1/devices` (FCM token — optional this phase).

## Routes / screens (§5, §17)

- `/` Home — store banner, category chips, search entry, product sections (by category).
- `/search` (or query on Home) — debounced product search (trgm) grid.
- `/c/[category]` PLP — products in a category, cursor "load more".
- `/p/[slug]` PDP — images, price/MRP, composition, Rx badge, cold-chain, quantity stepper, add-to-cart, sticky add bar.
- `/cart` — line items + steppers + itemsPaise; "Proceed to checkout".
- `/checkout` — address picker (+ add address + serviceability), COD/PREPAID toggle (COD gated by codLimit + store flags), coupon code, `cart/validate` pre-check + issue resolution, place order (Idempotency-Key), then Razorpay/dev-simulate for prepaid, Rx upload prompt for Rx carts.
- `/orders` — history list (status, total, date).
- `/orders/[id]` — status timeline, items, address, totals; invoice download when DELIVERED; cancel (per §18.3 matrix); Rx upload when RX_REVIEW/rejected; driver card when assigned.
- `/orders/[id]/track` — live status via socket `order:{id}` room (order:status) + polling fallback (`/track`).
- `/account` — profile (name/email via PATCH /v1/me), saved addresses CRUD, sign out, regulatory footer (store license/pharmacist/GSTIN from /v1/store).

## PWA

`app/manifest.ts` (name, icons, `display: standalone`, theme color = primary-600), apple-touch/icons, an
offline fallback page, and a minimal service worker (Serwist or a hand-rolled SW caching the app shell +
static assets — network-first for API). Install prompt after first order is a nice-to-have. i18n: scaffold
EN copy behind a tiny `t()` indirection (Noto Devanagari already in the preset) — no full HI translation.

## Foundation (integrator-owned; scaffold FIRST, then agents build screens)

`frontend/web`: package.json, next.config, tsconfig, tailwind.config, postcss, globals.css, eslint.config
(mirror `frontend/ops`); `src/lib/{api,env,auth,query,cn,format,socket,devPayment}.ts(x)`;
`src/app/{layout,providers}.tsx`; `src/components/` mobile UI kit (Button, Input, Card, Badge/RxBadge,
QtyStepper, PriceRow, ProductCard, BottomNav app-shell, Sheet/Modal, Toast, EmptyState, Skeleton);
a `CartProvider`/`useCart` (React Query around /v1/cart with optimistic qty) and `StoreProvider` (/v1/store).

## Screen file ownership (disjoint — one writer per route dir; integrator wires nav)

| Agent | Routes / files |
|---|---|
| **home** | `/` , `/search`, `/c/[category]` (browse + search + PLP) |
| **pdp-cart** | `/p/[slug]`, `/cart` |
| **checkout** | `/checkout` (+ address picker, serviceability, coupon, COD/PREPAID, Rx upload, dev-simulate) |
| **orders** | `/orders`, `/orders/[id]` (detail + cancel + invoice + Rx upload) |
| **track-account** | `/orders/[id]/track`, `/account` (profile + addresses) |

## Conventions (carried from P3 frontend)

Every page `"use client"`; data via TanStack Query; mutations invalidate + toast; ALL types from
`@medrush/contracts` (never hand-typed); money via `formatPaise`; `Idempotency-Key` (uuid) on POST /orders;
guard array access (noUncheckedIndexedAccess); auth guard redirects to `/login` for account/checkout/orders;
browse/PDP are public (no auth). Do NOT edit shared foundation files or `packages/contracts`. `next build`
+ `tsc` + `eslint .` must stay clean.

## Verify

Build/lint/typecheck clean; live smoke: dev-login → `/v1/store` + `/v1/products` render; add to cart →
`/v1/cart`; place a COD order → PLACED → appears in `/orders`; prepaid dev-simulate → PLACED; Rx cart →
upload → RX_REVIEW. (Lighthouse/real-phone are the human DoD, not gated here.)
