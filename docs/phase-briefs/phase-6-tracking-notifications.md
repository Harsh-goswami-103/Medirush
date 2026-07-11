# Phase 6 — Live tracking + notification polish

Binding brief. Blueprint: §23 Phase 6, §18.1 (customer flow — the DoD), §3.5 (realtime flow),
§7.2 (endpoints), §7.3 (socket contract), §11 (in-memory location, pg-boss fanout), §20.4 (screen
states). Depends: P1–P5 (all backend + web + driver already built and device-verified).

**DoD:** end-to-end customer UX matches §18.1 exactly — a customer watching an order sees a live map
(driver marker moving), a status timeline, an ETA, and the assigned driver's name/vehicle/call; tracking
**survives a socket drop** via polling fallback; there are **no cross-order room leaks** (a customer
cannot receive another order's `driver:location`), proven by a test; the customer has a **notification
center** (durable, persisted notifications with unread badge + mark-read) fed by real order-lifecycle
events; a **WhatsApp support deep-link** is reachable. Push send infra exists behind a config-selected
stub (offline no-op in dev, real FCM when creds present), mirroring the Razorpay/R2 stub pattern.

## What already exists (verified 2026-07-12 — do NOT rebuild)

- **Socket layer is solid** (`core/socket.ts`): handshake auth (`verifySocketToken`, dev + Firebase),
  auto-join `ops`/`driver:{id}`, on-demand `join` gated by `canJoinRoom` with a real per-order ownership
  DB check (`socket.ts:80-100,154-167`). `location:update` handler is guarded to ASSIGNED/PICKED_UP and
  broadcasts `driver:location` excluding sender (`socket.ts:171-191`). Emit helpers in `core/realtime.ts`
  fire post-commit for every lifecycle transition. **Keep all of this**; only harden as listed below.
- **`GET /v1/orders/:id/track`** exists (`orders/service.ts:906-921`) with ownership check, returns
  `{orderId, status, driverLocation}` from `core/locationStore.ts`. **Extend the payload** (below).
- **`DeviceToken`** model + `POST /v1/devices` register (`modules/devices/routes.ts`) — tokens stored but
  never read. **`Notification`** model exists (`schema.prisma:498-508`, index `[userId, createdAt]`) but
  is **never written**. No push send code, no notification-fanout job, no notification-center endpoints,
  no WhatsApp helper — all net-new.
- **Web track screen** (`frontend/web/src/app/orders/[id]/track/page.tsx`) has an inline stepper +
  `LiveIndicator` (reconnect) + a text driver-location block ("Live map coming soon") + a naive
  always-on 5s poll. **Socket client** `lib/socket.ts` (`useOrderLive`) listens `order:status` +
  `driver:location`, invalidates queries. No map lib installed. No notification UI, no bell.
- **Driver app** already emits `location:update` at ≤5s/20m during active deliveries — the customer
  tracking screen consumes this. **No driver-app changes in this phase** (see Deferred).

## Contracts (frozen FIRST by the lead, additive — no §6-§9 drift)

All in `packages/contracts`. Additive extensions only (same posture as P1 `ValidateCartResult.totals`).

1. `schemas/order.ts` — extend `TrackOrderResultSchema` (additive fields; `driverLocation` unchanged):
   - `store: { lat, lng }` — pickup origin (StoreConfig) for the map.
   - `destination: { lat, lng }` — drop (order Address) for the map.
   - `driver: OrderDriverSchema.nullable()` — name/phone/vehicleType/vehicleNo (null pre-ASSIGNED).
   - `timeline: z.array(OrderStatusEventSchema)` — `{ status, at }` transitions for the stepper
     (derive from OrderEvent `to`/`createdAt`, dedup to the happy path).
   - `etaMinutes: z.number().int().nonnegative().nullable()` — heuristic; null when not computable.
2. New `schemas/notification.ts`:
   - `NotificationSchema = { id, type, title, body, data: unknown|null, readAt: IsoDateTime|null, createdAt }`.
   - `NotificationListQuerySchema = { cursor?, limit(1..50 def 20), unreadOnly? }`.
   - `ListNotificationsResponse` = paginated envelope of `NotificationSchema`.
   - `UnreadCountSchema = { count }` + response envelope.
   - `MarkReadResponse` = envelope of `{ ok: true }` (reuse `OkSchema`/`AckResponse` if present).
   - Export from `index.ts`.
3. Do NOT change `socket-events.ts` (the §7.3 contract is met).

## Backend work

### Notifications module (new — `modules/notifications/`)
- `service.ts`:
  - `notifyUser({ userId, type, title, body, data? })` — persists a `Notification` row (its own small
    write, NOT inside a caller TX), then **best-effort** enqueues a push-fanout job. Safe to call after a
    transition commits (co-locate with the existing `emit*` calls). Never throws into the caller path.
  - `listNotifications(userId, { cursor, limit, unreadOnly })` — cursor pagination on `[userId, createdAt]`.
  - `unreadCount(userId)` — `count({ userId, readAt: null })`.
  - `markRead(userId, id)` (ownership-checked, idempotent) + `markAllRead(userId)`.
- `routes.ts` (customer + any authed role — own rows only): `GET /v1/notifications`,
  `GET /v1/notifications/unread-count`, `POST /v1/notifications/:id/read`,
  `POST /v1/notifications/read-all`. Register in `modules/v1.ts`.
- `core/push.ts` — FCM sender with **stub mode** (mirror Razorpay/R2): if `FIREBASE_PROJECT_ID` set →
  `firebase-admin/messaging` `sendEachForMulticast` to the user's `DeviceToken.token`s; else → structured
  log no-op. Reads tokens by `userId`; prunes nothing yet (invalid-token cleanup = follow-up). No new
  required prod env (reuses existing Firebase Admin creds).
- `jobs/notificationFanout.ts` — pg-boss queue `notification-fanout`; `enqueuePush({ userId, title, body,
  data })`; worker calls `core/push.ts`. Register in `core/jobs.ts` (like `invoicePdf`). `notifyUser`
  persists the row inline and enqueues ONLY the push (row must be durable even if push is stubbed).

### `/track` enhancement (`orders/service.ts` `trackOrder`)
- Load order with its Address (destination), StoreConfig (store), events, and driver (via Delivery →
  DriverProfile → User) when ASSIGNED+. Build `timeline` from OrderEvents. Compute `etaMinutes`:
  if `driverLocation` present → `ceil(haversineMeters(driverLoc → destination) / (AVG_SPEED_MPS) / 60)`
  with a floor; else null (or a coarse status-based estimate). Keep the ownership check. Update the stale
  docstring. Add a `core/geo.ts` haversine helper if none exists (check `dispatch/service.ts` first —
  reuse its distance fn).

### Lifecycle notification wiring (co-locate with existing post-commit `emitOrderStatus` sites)
Persist a **customer** `Notification` for: PLACED (order confirmed), RX_REVIEW→APPROVED, Rx REJECTED
(→ cancel + refund), READY ("packed — arriving soon"), ASSIGNED ("{driver} is on the way to the store"),
PICKED_UP ("on the way to you"), DELIVERED, CANCELLED (with reason). Persist a **driver** `Notification`
for payout APPROVED and MARK-PAID (currently fully silent — `admin/payoutService.ts`). Keep offer delivery
socket-only (ephemeral; do not spam the center). Each `notifyUser` call goes AFTER the same TX commit as
the socket emit, never inside it.

### Socket / location hardening
- Call `clearDriverLocation(orderId)` on terminal transitions (DELIVERED, CANCELLED) so stale positions
  don't linger (`locationStore.ts` defines it but nothing calls it).
- Zod-validate the `location:update` payload in the socket handler (`LocationUpdateEventSchema`) before use.
- (Skip `status:online/offline` socket handlers — HTTP `PATCH /v1/driver/status` is the source of truth;
  note the dead contract surface, don't build it.)

### Tests (`modules/**/__tests__` / `test/`)
- **Room authz (headline):** `canJoinRoom` / socket join — customer A cannot join `order:{B}` (returns
  false / no `driver:location` leak); staff can; driver only own room.
- `/track` returns timeline + etaMinutes + driver + store + destination; ownership 404 for a non-owner;
  driverLocation drives ETA.
- Notifications: create via `notifyUser` → list (paginated) → unreadCount → markRead decrements →
  markAllRead; a user cannot read/mark another user's rows (RBAC/ownership).
- Lifecycle: an order driven to DELIVERED yields a customer notification; a payout approve yields a
  driver notification; `clearDriverLocation` invoked on terminal.
- All prior tests stay green (164 baseline).

## Customer web (`frontend/web`)

### Live tracking screen
- Add `maplibre-gl`. New `components/TrackMap.tsx` — dynamic import (`ssr:false`), only mounted on the
  track route (§11 code-split). Render store, destination, and driver markers + a route line; recenter on
  driver moves; free OSM raster style by default, swap to Ola tiles when `NEXT_PUBLIC_OLA_MAPS_KEY` set.
  Ships loading/empty/error states (§20.4).
- Rework `track/page.tsx`: map on top → ETA banner ("Arriving in ~N min" / "Driver arriving" when ETA≤2 or
  PICKED_UP+near) → timeline (reuse the stepper) → driver card (name/vehicle/**Call** `tel:`) →
  order-details link. Keep `LiveIndicator`. Consume the extended `TrackOrderResult`.
- **Fix polling fallback:** gate `refetchInterval` on socket state — poll ~4s when `!connected`, back off
  (or stop) when live; also give the order-detail query a modest fallback interval.

### Notification center
- Bell in `AppShell`/`TopBar` with an unread badge (poll `unread-count` ~30s + invalidate on socket
  `order:status`). New `/notifications` route: list, relative times, tap → mark-read, "mark all read".
  Add `api` methods. Loading/empty/error states.

### WhatsApp deep-link
- A "Chat with us on WhatsApp" `wa.me/<supportPhone>?text=...` link on the account/help surface and an
  order "Need help?" affordance. Support number from a public config value (env
  `NEXT_PUBLIC_SUPPORT_PHONE`) or an existing store endpoint — do not hardcode.

## Deferred (documented, NOT in this phase)
- Driver-app FCM offer push + background location (needs `expo-notifications` + native rebuild via EAS;
  app is already device-verified — follow-up, already noted in `frontend/driver/README.md`).
- Browser web-push service worker / real FCM web delivery (needs VAPID/Firebase-web keys unavailable
  locally). The notification center works via persisted rows + polling now; SW push is a config-gated
  follow-up. Backend `core/push.ts` is ready for real tokens.

## Verify (DoD gate)
- `pnpm --filter @medrush/contracts build`; turbo `typecheck` + `lint` + `build` (api, web) clean.
- `pnpm --filter @medrush/api test` green (new tests incl. the room-leak authz test).
- LIVE smoke over real HTTP (portable PG :5433, api :4000, web :3001): drive an order to PICKED_UP with a
  driver location ping → `GET /track` returns map coords + timeline + ETA + driver; kill the socket →
  polling keeps the screen fresh; a lifecycle event writes a notification the center lists + marks read;
  WhatsApp link resolves. Adversarial review pass on the diff before commit.
