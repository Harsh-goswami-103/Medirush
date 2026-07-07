/**
 * Phase 1 live golden path — drives a COD order PLACED→DELIVERED against a
 * REAL running server over HTTP (fetch → :4000), not app.inject(). The one
 * non-HTTP step is dispatch (assignDriver has no HTTP surface in Phase 1, per
 * the phase-1 brief scope decision #3), which we invoke directly against the
 * shared DB. Run: server up on :4000 + fresh seed, then `tsx scripts/golden-path.ts`.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assignDriver } from "../src/modules/dispatch/service";

const BASE = process.env.GOLDEN_BASE ?? "http://localhost:4000";
const prisma = new PrismaClient();

const CUSTOMER = "dev:seed-firebase-customer:+919876543210";
const OPS = "dev:seed-firebase-inventory:+919876543212";
const DRIVER = "dev:seed-firebase-driver:+919876543211";
const DRIVER_APP = "9.9.9";

let step = 0;
function ok(msg: string): void {
  step += 1;
  console.log(`  ✓ [${step}] ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ✗ FAILED: ${msg}`);
  throw new Error(msg);
}

interface Opts {
  token?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}
async function api(path: string, opts: Opts = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...opts.headers };
  // Only advertise a JSON body when we actually send one — Fastify 400s on an
  // empty body with content-type application/json (no-body POSTs like validate).
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

async function main(): Promise<void> {
  console.log("MedRush Phase 1 — live COD golden path\n");

  // ── health ────────────────────────────────────────────────────────────
  const health = await api("/healthz");
  if (health.status !== 200) fail(`/healthz ${health.status}`);
  ok("server is live (/healthz 200)");

  // ── customer: catalog + address ─────────────────────────────────────────
  const store = await api("/v1/store");
  if (store.status !== 200 || store.json.data.isOpen !== true) fail("store not open");
  ok(`store open, min order ₹${(store.json.data.minOrderPaise / 100).toFixed(0)}`);

  const products = await api("/v1/products?limit=50", { token: CUSTOMER });
  const nonRx = products.json.data.filter((p: any) => !p.requiresRx && p.inStock);
  if (nonRx.length < 2) fail("need 2 in-stock non-Rx products");
  const [p1, p2] = nonRx;
  ok(`picked 2 non-Rx products: ${p1.name}, ${p2.name}`);

  const addresses = await api("/v1/addresses", { token: CUSTOMER });
  const address = addresses.json.data[0];
  if (!address) fail("customer has no seeded address");
  const serv = await api("/v1/serviceability", {
    token: CUSTOMER,
    method: "POST",
    body: { lat: address.lat, lng: address.lng },
  });
  if (serv.json.data.serviceable !== true) fail("seeded address not serviceable");
  ok(`address serviceable, distance ${serv.json.data.distanceM}m`);

  // ── customer: cart ──────────────────────────────────────────────────────
  // Quantities chosen to clear the ₹99 min order (validate.valid is about
  // stock/Rx issues, not min-order — that gate lives at order create, §9.2).
  const put1 = await api("/v1/cart/items", { token: CUSTOMER, method: "PUT", body: { productId: p1.id, qty: 3 } });
  if (put1.status !== 200) fail(`PUT cart item 1 → ${put1.status}: ${JSON.stringify(put1.json)}`);
  const put2 = await api("/v1/cart/items", { token: CUSTOMER, method: "PUT", body: { productId: p2.id, qty: 2 } });
  if (put2.status !== 200) fail(`PUT cart item 2 → ${put2.status}: ${JSON.stringify(put2.json)}`);
  const validate = await api("/v1/cart/validate", { token: CUSTOMER, method: "POST" });
  if (validate.status !== 200) fail(`POST cart/validate → ${validate.status}: ${JSON.stringify(validate.json)}`);
  if (validate.json.data.valid !== true) fail(`cart invalid: ${JSON.stringify(validate.json.data.issues)}`);
  ok(`cart valid, items ₹${(validate.json.data.totals.itemsPaise / 100).toFixed(2)}, total ₹${(validate.json.data.totals.totalPaise / 100).toFixed(2)}`);

  // ── customer: create COD order ─────────────────────────────────────────
  const idemKey = randomUUID();
  const create = await api("/v1/orders", {
    token: CUSTOMER,
    method: "POST",
    headers: { "idempotency-key": idemKey },
    body: { addressId: address.id, paymentMethod: "COD" },
  });
  if (create.status !== 201 && create.status !== 200) fail(`create order ${create.status}: ${JSON.stringify(create.json)}`);
  const order = create.json.data.order;
  if (order.status !== "PLACED") fail(`expected PLACED, got ${order.status}`);
  ok(`order ${order.orderNo} created → PLACED, total ₹${(order.totalPaise / 100).toFixed(2)}, COD_DUE`);

  // idempotency replay
  const replay = await api("/v1/orders", {
    token: CUSTOMER,
    method: "POST",
    headers: { "idempotency-key": idemKey },
    body: { addressId: address.id, paymentMethod: "COD" },
  });
  if (replay.json.data.order.orderNo !== order.orderNo) fail("idempotency replay returned a different order");
  ok(`idempotency replay → same order ${order.orderNo}`);

  // ── ops: pack + ready (FEFO) ────────────────────────────────────────────
  const pack = await api(`/v1/ops/orders/${order.id}/start-packing`, { token: OPS, method: "POST" });
  if (pack.json.data.status !== "PACKING") fail(`start-packing → ${pack.json.data.status}`);
  ok("ops start-packing → PACKING");

  const detail = await api(`/v1/ops/orders/${order.id}`, { token: OPS });
  const allocations = detail.json.data.items.flatMap((it: any) =>
    it.fefoSuggestions.map((s: any) => ({ orderItemId: it.id, batchId: s.batchId, qty: s.qty })),
  );
  if (allocations.length === 0) fail("no FEFO suggestions proposed");
  ok(`FEFO proposed ${allocations.length} allocation(s) across ${detail.json.data.items.length} item(s)`);

  const ready = await api(`/v1/ops/orders/${order.id}/ready`, { token: OPS, method: "POST", body: { allocations } });
  if (ready.json.data.status !== "READY") fail(`ready → ${ready.json.data.status}: ${JSON.stringify(ready.json)}`);
  ok("ops ready (FEFO committed) → READY, OTP generated");

  // ── customer reads the delivery OTP (owner-only) ────────────────────────
  const owned = await api(`/v1/orders/${order.id}`, { token: CUSTOMER });
  const otp = owned.json.data.deliveryOtp;
  if (!otp || !/^\d{4}$/.test(otp)) fail(`expected 4-digit OTP, got ${otp}`);
  ok(`customer sees delivery OTP ${otp}`);

  // ── dispatch (no HTTP surface in Phase 1) ───────────────────────────────
  const driverProfile = await prisma.driverProfile.findFirst({
    where: { user: { firebaseUid: "seed-firebase-driver" } },
  });
  if (!driverProfile) fail("no seeded driver profile");
  await assignDriver(order.id, driverProfile.id);
  ok("dispatch: assignDriver → ASSIGNED (Delivery created)");

  const delivery = await prisma.delivery.findUnique({ where: { orderId: order.id } });
  if (!delivery) fail("no Delivery row after assign");

  // ── driver: pickup + deliver (OTP + COD) ────────────────────────────────
  const active = await api("/v1/driver/active", { token: DRIVER, headers: { "x-app-version": DRIVER_APP } });
  if (active.status !== 200 || active.json.data?.orderId !== order.id) {
    fail(`driver active → ${active.status}: ${JSON.stringify(active.json)}`);
  }
  ok(`driver sees active delivery (COD due ₹${((active.json.data.codDuePaise ?? 0) / 100).toFixed(2)})`);

  const picked = await api(`/v1/driver/deliveries/${delivery.id}/picked-up`, {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
  });
  if (picked.json.data.status !== "PICKED_UP") fail(`picked-up → ${picked.json.data.status}`);
  ok("driver picked-up → PICKED_UP");

  // wrong OTP is rejected
  const wrong = await api(`/v1/driver/deliveries/${delivery.id}/deliver`, {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
    body: { otp: otp === "0000" ? "1111" : "0000", codCollectedPaise: order.totalPaise },
  });
  if (wrong.status !== 422) fail(`wrong OTP should be 422, got ${wrong.status}`);
  ok(`wrong OTP rejected (${wrong.json.error.code})`);

  const walletBefore = await prisma.wallet.findFirst({ where: { driverId: driverProfile.id } });
  const balBefore = walletBefore?.balancePaise ?? 0;

  const deliver = await api(`/v1/driver/deliveries/${delivery.id}/deliver`, {
    token: DRIVER,
    method: "POST",
    headers: { "x-app-version": DRIVER_APP },
    body: { otp, codCollectedPaise: order.totalPaise },
  });
  if (deliver.status !== 200 || !deliver.json.data?.deliveredAt) {
    fail(`deliver → ${deliver.status}: ${JSON.stringify(deliver.json)}`);
  }
  ok(`driver deliver (correct OTP + exact COD) → wallet ₹${(deliver.json.data.walletBalancePaise / 100).toFixed(2)}`);

  // ── verify final state ──────────────────────────────────────────────────
  const finalOrder = await prisma.order.findUnique({
    where: { id: order.id },
    include: { events: { orderBy: { createdAt: "asc" } }, delivery: true },
  });
  const walletAfter = await prisma.wallet.findFirst({ where: { driverId: driverProfile.id }, include: { txns: true } });
  const cfg = await prisma.storeConfig.findUniqueOrThrow({ where: { id: "store" } });
  const expectedCommission = cfg.commissionBasePaise + cfg.commissionPerKmPaise * Math.ceil(delivery.distanceM / 1000);

  if (finalOrder?.status !== "DELIVERED") fail("order not DELIVERED");
  if (finalOrder.paymentStatus !== "COD_COLLECTED") fail(`paymentStatus ${finalOrder.paymentStatus}`);
  const chain = finalOrder.events.map((e) => e.to).join("→");
  const expectedChain = "PLACED→PACKING→READY→ASSIGNED→PICKED_UP→DELIVERED";
  if (chain !== expectedChain) fail(`event chain ${chain} != ${expectedChain}`);
  ok(`event chain intact: ${chain}`);

  const credited = (walletAfter?.balancePaise ?? 0) - balBefore;
  if (credited !== expectedCommission) fail(`commission credited ${credited} != expected ${expectedCommission}`);
  const drift = (walletAfter?.balancePaise ?? 0) - (walletAfter?.txns ?? []).reduce((s, t) => s + (t.type === "CREDIT" ? t.amountPaise : -t.amountPaise), 0);
  if (drift !== 0) fail(`wallet ledger drift ${drift}`);
  ok(`wallet credited ₹${(credited / 100).toFixed(2)} (base+perKm×ceil(${delivery.distanceM}m)), ledger drift 0`);

  const allocRows = await prisma.itemBatchAlloc.count({ where: { orderItem: { orderId: order.id } } });
  if (allocRows === 0) fail("no ItemBatchAlloc rows");
  ok(`${allocRows} batch allocation snapshot(s) recorded (FEFO traceability)`);

  console.log(`\n✅ GOLDEN PATH PASSED — ${order.orderNo} driven PLACED→DELIVERED over live HTTP, ${step} checks.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
