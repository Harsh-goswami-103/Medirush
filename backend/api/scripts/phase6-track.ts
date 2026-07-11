/**
 * Phase 6 live smoke — drives a COD order to PICKED_UP over real HTTP (:4000),
 * then verifies the enriched /track payload (map anchors + driver + timeline +
 * ETA) and the notification center (lifecycle rows + unread + mark-read).
 *
 * The /track HTTP payload IS the socket-drop fallback, so a green run here proves
 * "tracking survives a socket drop". Run: server up on :4000 + fresh `db:seed`,
 * then `tsx scripts/phase6-track.ts` (dev DB, portable PG :5433).
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.GOLDEN_BASE ?? "http://localhost:4000";
const prisma = new PrismaClient();

const CUSTOMER = "dev:seed-firebase-customer:+919876543210";
const OPS = "dev:seed-firebase-inventory:+919876543212";
const DRIVER = "dev:seed-firebase-driver:+919876543211";
const DRIVER_APP = "9.9.9";

let step = 0;
const ok = (m: string) => console.log(`  ✓ [${++step}] ${m}`);
const fail = (m: string): never => {
  console.error(`  ✗ FAILED: ${m}`);
  throw new Error(m);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  token?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}
async function api(path: string, opts: Opts = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Move ~`m` metres north of a point (rough, fine for a smoke ETA). */
function north(lat: number, m: number): number {
  return lat + m / 111_320;
}

async function main(): Promise<void> {
  console.log("MedRush Phase 6 — live tracking + notifications smoke\n");

  if ((await api("/healthz")).status !== 200) fail("/healthz not 200");
  ok("server live (/healthz 200)");

  // driver online so dispatch can offer to them
  const online = await api("/v1/driver/status", {
    token: DRIVER,
    method: "PATCH",
    headers: { "x-app-version": DRIVER_APP },
    body: { isOnline: true },
  });
  if (online.status !== 200) fail(`driver status online → ${online.status}: ${JSON.stringify(online.json)}`);
  ok("driver online");

  // customer: catalog → address → cart → COD order
  const products = await api("/v1/products?limit=50", { token: CUSTOMER });
  const nonRx = products.json.data.filter((p: any) => !p.requiresRx && p.inStock);
  if (nonRx.length < 2) fail("need 2 in-stock non-Rx products (run db:seed)");
  const [p1, p2] = nonRx;
  const address = (await api("/v1/addresses", { token: CUSTOMER })).json.data[0];
  if (!address) fail("customer has no seeded address");

  await api("/v1/cart/items", { token: CUSTOMER, method: "PUT", body: { productId: p1.id, qty: 3 } });
  await api("/v1/cart/items", { token: CUSTOMER, method: "PUT", body: { productId: p2.id, qty: 2 } });
  const create = await api("/v1/orders", {
    token: CUSTOMER,
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: { addressId: address.id, paymentMethod: "COD" },
  });
  const order = create.json.data?.order;
  if (!order || order.status !== "PLACED") fail(`create order → ${create.status}: ${JSON.stringify(create.json)}`);
  ok(`order ${order.orderNo} → PLACED`);

  // ops: pack → ready (auto-dispatch fires offers)
  await api(`/v1/ops/orders/${order.id}/start-packing`, { token: OPS, method: "POST" });
  const detail = await api(`/v1/ops/orders/${order.id}`, { token: OPS });
  const allocations = detail.json.data.items.flatMap((it: any) =>
    it.fefoSuggestions.map((s: any) => ({ orderItemId: it.id, batchId: s.batchId, qty: s.qty })),
  );
  const ready = await api(`/v1/ops/orders/${order.id}/ready`, { token: OPS, method: "POST", body: { allocations } });
  if (ready.json.data?.status !== "READY") fail(`ready → ${JSON.stringify(ready.json)}`);
  ok("ops ready → READY (dispatch offered)");

  // driver: find the offer for this order, accept → ASSIGNED
  let offerId: string | null = null;
  for (let i = 0; i < 8 && !offerId; i++) {
    const offers = await api("/v1/driver/offers", { token: DRIVER, headers: { "x-app-version": DRIVER_APP } });
    offerId = offers.json.data?.find((o: any) => o.orderId === order.id)?.offerId ?? null;
    if (!offerId) await sleep(400);
  }
  if (!offerId) fail("no dispatch offer surfaced for the seeded driver");
  const accept = await api(`/v1/driver/offers/${offerId}/accept`, {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
  });
  const deliveryId = accept.json.data?.deliveryId;
  if (!deliveryId) fail(`accept → ${accept.status}: ${JSON.stringify(accept.json)}`);
  ok("driver accepted offer → ASSIGNED");

  // driver: picked-up → PICKED_UP
  const picked = await api(`/v1/driver/deliveries/${deliveryId}/picked-up`, {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
  });
  if (picked.json.data?.status !== "PICKED_UP") fail(`picked-up → ${JSON.stringify(picked.json)}`);
  ok("driver picked-up → PICKED_UP");

  // driver: push a live location ~350m from the doorstep so ETA computes
  const ping = { lat: north(address.lat, -350), lng: address.lng, ts: new Date().toISOString() };
  const loc = await api("/v1/driver/location", {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
    body: { points: [ping] },
  });
  if (loc.status !== 200) fail(`driver location → ${loc.status}: ${JSON.stringify(loc.json)}`);
  ok("driver location ping accepted");

  // ── customer: enriched /track (this is the socket-drop fallback payload) ──
  const track = await api(`/v1/orders/${order.id}/track`, { token: CUSTOMER });
  if (track.status !== 200) fail(`/track → ${track.status}: ${JSON.stringify(track.json)}`);
  const t = track.json.data;
  if (t.status !== "PICKED_UP") fail(`track.status ${t.status}`);
  if (typeof t.store?.lat !== "number" || typeof t.store?.lng !== "number") fail("track.store missing");
  if (typeof t.destination?.lat !== "number") fail("track.destination missing");
  if (Math.abs(t.destination.lat - address.lat) > 1e-6) fail("track.destination != order address");
  if (!t.driver || !t.driver.phone) fail(`track.driver missing: ${JSON.stringify(t.driver)}`);
  if (!t.driverLocation || typeof t.driverLocation.lat !== "number") fail("track.driverLocation missing");
  const chain = (t.timeline ?? []).map((e: any) => e.status).join("→");
  for (const s of ["PLACED", "READY", "ASSIGNED", "PICKED_UP"]) {
    if (!chain.includes(s)) fail(`track.timeline missing ${s} (got ${chain})`);
  }
  if (typeof t.etaMinutes !== "number" || t.etaMinutes < 1) fail(`track.etaMinutes not a positive int: ${t.etaMinutes}`);
  ok(`/track OK — store+destination+driver(${t.driver.vehicleType})+ping, timeline ${chain}, ETA ~${t.etaMinutes}m`);

  // ── customer: notification center ──
  const list = await api("/v1/notifications?limit=50", { token: CUSTOMER });
  if (list.status !== 200) fail(`/notifications → ${list.status}: ${JSON.stringify(list.json)}`);
  const notifs = list.json.data as any[];
  const types = notifs.map((n) => n.type);
  for (const want of ["ORDER_PLACED", "ORDER_READY", "ORDER_ASSIGNED", "ORDER_PICKED_UP"]) {
    if (!types.includes(want)) fail(`notification ${want} not found (got ${types.join(",")})`);
  }
  ok(`notifications listed lifecycle events: ${types.join(", ")}`);

  const count0 = (await api("/v1/notifications/unread-count", { token: CUSTOMER })).json.data.count;
  if (count0 < 4) fail(`unread-count ${count0} < 4`);
  const first = notifs.find((n) => !n.readAt);
  const read = await api(`/v1/notifications/${first.id}/read`, { token: CUSTOMER, method: "POST" });
  if (read.status !== 200) fail(`mark read → ${read.status}`);
  const count1 = (await api("/v1/notifications/unread-count", { token: CUSTOMER })).json.data.count;
  if (count1 !== count0 - 1) fail(`unread-count did not decrement: ${count0} → ${count1}`);
  await api("/v1/notifications/read-all", { token: CUSTOMER, method: "POST" });
  const count2 = (await api("/v1/notifications/unread-count", { token: CUSTOMER })).json.data.count;
  if (count2 !== 0) fail(`read-all left ${count2} unread`);
  ok(`notification center OK — unread ${count0} → read one → ${count1} → read-all → 0`);

  // cleanup: deliver the order (frees the driver for re-runs; verifies DELIVERED
  // notification + that /track goes terminal — etaMinutes null, location cleared).
  const otp = (await api(`/v1/orders/${order.id}`, { token: CUSTOMER })).json.data.deliveryOtp;
  const deliver = await api(`/v1/driver/deliveries/${deliveryId}/deliver`, {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
    body: { otp, codCollectedPaise: order.totalPaise },
  });
  if (deliver.status !== 200) fail(`deliver → ${deliver.status}: ${JSON.stringify(deliver.json)}`);
  const term = (await api(`/v1/orders/${order.id}/track`, { token: CUSTOMER })).json.data;
  if (term.status !== "DELIVERED" || term.etaMinutes !== null || term.driverLocation !== null) {
    fail(`terminal /track wrong: ${JSON.stringify({ s: term.status, eta: term.etaMinutes, loc: term.driverLocation })}`);
  }
  const delivered = (await api("/v1/notifications?limit=50", { token: CUSTOMER })).json.data;
  if (!delivered.some((n: any) => n.type === "ORDER_DELIVERED")) fail("no ORDER_DELIVERED notification");
  ok("delivered → DELIVERED notification + terminal /track (ETA null, location cleared)");

  console.log(`\n✅ PHASE 6 SMOKE PASSED — ${order.orderNo} tracked PLACED→PICKED_UP→DELIVERED over live HTTP, ${step} checks.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
