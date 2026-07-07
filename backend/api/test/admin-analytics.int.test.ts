import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  RxStatus,
} from "@medrush/contracts";

/**
 * Admin analytics (Module B, §7.2 — role ADMIN). Real Postgres. Analytics is a
 * read-only surface, so orders are seeded straight into the DB (deterministic
 * timestamps) rather than driven through the fulfillment pipeline.
 *
 * Coverage: dashboard KPIs on a seeded day (orders/revenue/AOV/onTime/lowStock/
 * codDue), order filter + `format=csv`, sales per-day rollup + totals, GST
 * back-compute (CGST=SGST, taxable+cgst+sgst=total), H1 register for a DELIVERED
 * Rx order, and RBAC (non-admin → 403).
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { buildApp } = await import("../src/app");
const { disconnectPrisma, getPrisma } = await import("../src/core/db");
const { bustFlagCache } = await import("../src/core/flags");
const { bustStoreConfigCache } = await import("../src/core/storeInfo");
const { clearAuthCaches } = await import("../src/plugins/auth");
const { setupTestDb } = await import("./helpers/db");
const { appSettings, product, storeConfig, user } = await import("./helpers/factories");
const { authHeaders } = await import("./helpers/auth");
const { getDashboard } = await import("../src/modules/admin/dashboardService");

type App = Awaited<ReturnType<typeof buildApp>>;

const prisma = getPrisma();
let app: App;
let seq = 0;

/** Fixed instant at a wall-clock IST time on a calendar day. */
function istInstant(date: string, time = "12:00"): Date {
  return new Date(`${date}T${time}:00.000+05:30`);
}

interface SeedItem {
  nameSnap: string;
  hsnSnap?: string | null;
  gstRatePct?: number;
  pricePaise: number;
  mrpPaise?: number;
  qty: number;
  requiresRx?: boolean;
  allocations?: Array<{ batchNoSnap: string; qty: number }>;
}

interface SeedOrder {
  status: OrderStatus;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  placedAt?: Date | null;
  deliveredAt?: Date | null;
  cancelledAt?: Date | null;
  itemsPaise?: number;
  deliveryPaise?: number;
  discountPaise?: number;
  totalPaise: number;
  requiresRx?: boolean;
  rxStatus?: RxStatus;
  invoiceNo?: string | null;
  items?: SeedItem[];
  prescription?: { status: RxStatus; patientName: string; doctorName: string };
}

/** Insert an Order (+ nested items/allocations/prescription) for `userId`. */
async function seedOrder(userId: string, o: SeedOrder) {
  const n = (seq += 1);
  return prisma.order.create({
    data: {
      orderNo: `MR-TEST-${n}`,
      userId,
      status: o.status,
      paymentMethod: o.paymentMethod ?? PaymentMethod.COD,
      paymentStatus: o.paymentStatus ?? PaymentStatus.PENDING,
      addressSnapshot: {
        name: "Test Customer",
        line1: "1 Test Street",
        pincode: "560001",
        lat: 12.9716,
        lng: 77.5946,
        phone: "+919999999999",
      },
      distanceM: 1000,
      itemsPaise: o.itemsPaise ?? o.totalPaise,
      deliveryPaise: o.deliveryPaise ?? 0,
      discountPaise: o.discountPaise ?? 0,
      totalPaise: o.totalPaise,
      requiresRx: o.requiresRx ?? false,
      rxStatus: o.rxStatus ?? RxStatus.NA,
      invoiceNo: o.invoiceNo ?? null,
      placedAt: o.placedAt ?? null,
      deliveredAt: o.deliveredAt ?? null,
      cancelledAt: o.cancelledAt ?? null,
      items: o.items
        ? {
            create: o.items.map((it) => ({
              productId: `prod-${(seq += 1)}`,
              nameSnap: it.nameSnap,
              packSizeSnap: "Strip of 10",
              pricePaise: it.pricePaise,
              mrpPaise: it.mrpPaise ?? it.pricePaise,
              gstRatePct: it.gstRatePct ?? 12,
              hsnSnap: it.hsnSnap ?? null,
              requiresRx: it.requiresRx ?? false,
              qty: it.qty,
              allocations: it.allocations
                ? {
                    create: it.allocations.map((a) => ({
                      batchId: `batch-${(seq += 1)}`,
                      batchNoSnap: a.batchNoSnap,
                      expirySnap: new Date("2027-01-01T00:00:00.000Z"),
                      qty: a.qty,
                    })),
                  }
                : undefined,
            })),
          }
        : undefined,
      prescriptions: o.prescription
        ? {
            create: [
              {
                fileKey: `rx/test/${n}.jpg`,
                mimeType: "image/jpeg",
                status: o.prescription.status,
                patientName: o.prescription.patientName,
                doctorName: o.prescription.doctorName,
                reviewedAt: new Date(),
              },
            ],
          }
        : undefined,
    },
  });
}

async function adminHeaders(): Promise<Record<string, string>> {
  return authHeaders(await user("ADMIN"));
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
});

beforeEach(async () => {
  await setupTestDb();
  clearAuthCaches();
  bustStoreConfigCache();
  bustFlagCache();
  await storeConfig();
  await appSettings();
});

describe("GET /v1/admin/dashboard", () => {
  it("computes KPIs over today's IST range", async () => {
    const customer = await user("CUSTOMER");
    // Fixed 'now' + direct service call → fully deterministic (no wall-clock /
    // IST-midnight-boundary flake); the HTTP route + envelope are covered by the
    // empty-range case and the report tests.
    const now = istInstant("2026-06-15", "18:00");
    const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

    // Two DELIVERED today: one on-time (5m), one late (45m > 40m SLA).
    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.COD,
      paymentStatus: PaymentStatus.COD_DUE, // cash owed to the store
      placedAt: minsAgo(5),
      deliveredAt: now,
      totalPaise: 20_000,
    });
    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.PREPAID,
      paymentStatus: PaymentStatus.PAID,
      placedAt: minsAgo(45),
      deliveredAt: now,
      totalPaise: 40_000,
    });
    // One CANCELLED today, one still PLACED today.
    await seedOrder(customer.id, {
      status: OrderStatus.CANCELLED,
      placedAt: minsAgo(30),
      cancelledAt: now,
      totalPaise: 15_000,
    });
    await seedOrder(customer.id, {
      status: OrderStatus.PLACED,
      placedAt: now,
      totalPaise: 10_000,
    });

    // One low-stock product (stock ≤ threshold) and one online driver.
    await product({ stock: 2, lowStockThreshold: 10 });
    const driverUser = await user("DRIVER");
    await prisma.driverProfile.create({
      data: { userId: driverUser.id, isVerified: true, isOnline: true },
    });

    const kpis = await getDashboard("today", now);

    expect(kpis.range).toBe("today");
    expect(kpis.ordersPlaced).toBe(4);
    expect(kpis.ordersDelivered).toBe(2);
    expect(kpis.ordersCancelled).toBe(1);
    expect(kpis.revenuePaise).toBe(60_000);
    expect(kpis.aovPaise).toBe(30_000);
    expect(kpis.onTimePct).toBe(50);
    expect(kpis.activeDrivers).toBe(1);
    expect(kpis.lowStockCount).toBe(1);
    expect(kpis.codDuePaise).toBe(20_000);
  });

  it("returns zeroed KPIs (no divide-by-zero) on an empty range", async () => {
    const headers = await adminHeaders();
    const res = await app.inject({ method: "GET", url: "/v1/admin/dashboard?range=7d", headers });
    expect(res.statusCode, res.body).toBe(200);
    const kpis = res.json().data;
    expect(kpis.range).toBe("7d");
    expect(kpis.ordersDelivered).toBe(0);
    expect(kpis.revenuePaise).toBe(0);
    expect(kpis.aovPaise).toBe(0);
    expect(kpis.onTimePct).toBe(0);
  });
});

describe("GET /v1/admin/orders", () => {
  it("lists with filters and joins customer phone/userId", async () => {
    const headers = await adminHeaders();
    const customer = await user("CUSTOMER");
    await seedOrder(customer.id, { status: OrderStatus.DELIVERED, deliveredAt: new Date(), totalPaise: 12_000 });
    await seedOrder(customer.id, { status: OrderStatus.DELIVERED, deliveredAt: new Date(), totalPaise: 8_000 });
    await seedOrder(customer.id, { status: OrderStatus.PLACED, placedAt: new Date(), totalPaise: 5_000 });

    const all = await app.inject({ method: "GET", url: "/v1/admin/orders", headers });
    expect(all.statusCode, all.body).toBe(200);
    const body = all.json();
    expect(body.data).toHaveLength(3);
    expect(body.meta.nextCursor).toBeNull();
    expect(body.data[0].userId).toBe(customer.id);
    expect(body.data[0].customerPhone).toBe(customer.phone);

    const delivered = await app.inject({
      method: "GET",
      url: "/v1/admin/orders?status=DELIVERED",
      headers,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(delivered.json().data).toHaveLength(2);
    expect(delivered.json().data.every((o: { status: string }) => o.status === "DELIVERED")).toBe(true);
  });

  it("format=csv returns a text/csv attachment", async () => {
    const headers = await adminHeaders();
    const customer = await user("CUSTOMER");
    const order = await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      deliveredAt: new Date(),
      totalPaise: 12_000,
    });

    const res = await app.inject({ method: "GET", url: "/v1/admin/orders?format=csv", headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");

    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "orderNo,status,paymentMethod,paymentStatus,totalPaise,customerPhone,createdAt",
    );
    expect(lines[1]).toContain(order.orderNo);
    expect(lines[1]).toContain(customer.phone);
  });
});

describe("GET /v1/admin/reports/sales", () => {
  it("rolls DELIVERED orders up per IST day with COD/prepaid split + totals", async () => {
    const headers = await adminHeaders();
    const customer = await user("CUSTOMER");

    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.COD,
      deliveredAt: istInstant("2026-06-01", "10:00"),
      itemsPaise: 10_000,
      deliveryPaise: 2_000,
      discountPaise: 0,
      totalPaise: 12_000,
    });
    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.PREPAID,
      deliveredAt: istInstant("2026-06-01", "15:00"),
      itemsPaise: 20_000,
      deliveryPaise: 0,
      discountPaise: 1_000,
      totalPaise: 19_000,
    });
    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.COD,
      deliveredAt: istInstant("2026-06-02", "09:00"),
      itemsPaise: 5_000,
      deliveryPaise: 2_000,
      discountPaise: 0,
      totalPaise: 7_000,
    });
    // Excluded: not delivered (in range) + delivered (out of range).
    await seedOrder(customer.id, {
      status: OrderStatus.PLACED,
      placedAt: istInstant("2026-06-01"),
      totalPaise: 99_999,
    });
    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      deliveredAt: istInstant("2026-05-30"),
      totalPaise: 99_999,
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/reports/sales?from=2026-06-01&to=2026-06-02",
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json().data;

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({
      date: "2026-06-01",
      orders: 2,
      itemsPaise: 30_000,
      deliveryPaise: 2_000,
      discountPaise: 1_000,
      totalPaise: 31_000,
      codPaise: 12_000,
      prepaidPaise: 19_000,
    });
    expect(report.rows[1]).toMatchObject({
      date: "2026-06-02",
      orders: 1,
      totalPaise: 7_000,
      codPaise: 7_000,
      prepaidPaise: 0,
    });
    expect(report.totals).toMatchObject({
      orders: 3,
      itemsPaise: 35_000,
      deliveryPaise: 4_000,
      discountPaise: 1_000,
      totalPaise: 38_000,
      codPaise: 19_000,
      prepaidPaise: 19_000,
    });

    const csv = await app.inject({
      method: "GET",
      url: "/v1/admin/reports/sales?from=2026-06-01&to=2026-06-02&format=csv",
      headers,
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "date,orders,itemsPaise,deliveryPaise,discountPaise,totalPaise,codPaise,prepaidPaise",
    );
    expect(lines[lines.length - 1]).toBe("TOTAL,3,35000,4000,1000,38000,19000,19000");
  });
});

describe("GET /v1/admin/reports/gst", () => {
  it("groups by (hsn, rate) with CGST=SGST and taxable+cgst+sgst=total", async () => {
    const headers = await adminHeaders();
    const customer = await user("CUSTOMER");

    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      deliveredAt: istInstant("2026-06-10", "10:00"),
      itemsPaise: 33_600,
      totalPaise: 33_600,
      items: [
        { nameSnap: "Item A", hsnSnap: "3004", gstRatePct: 12, pricePaise: 11_200, qty: 1 },
        { nameSnap: "Item A", hsnSnap: "3004", gstRatePct: 12, pricePaise: 11_200, qty: 2 },
      ],
    });
    await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      deliveredAt: istInstant("2026-06-10", "14:00"),
      itemsPaise: 10_500,
      totalPaise: 10_500,
      items: [{ nameSnap: "Item B", hsnSnap: "3005", gstRatePct: 5, pricePaise: 10_500, qty: 1 }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/reports/gst?from=2026-06-10&to=2026-06-10",
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json().data;

    expect(report.rows).toHaveLength(2);
    // Sorted by rate ascending: 5% (HSN 3005) then 12% (HSN 3004).
    expect(report.rows[0]).toMatchObject({
      hsnCode: "3005",
      gstRatePct: 5,
      taxablePaise: 10_000,
      cgstPaise: 250,
      sgstPaise: 250,
      totalPaise: 10_500,
    });
    expect(report.rows[1]).toMatchObject({
      hsnCode: "3004",
      gstRatePct: 12,
      taxablePaise: 30_000,
      cgstPaise: 1_800,
      sgstPaise: 1_800,
      totalPaise: 33_600,
    });
    for (const row of report.rows) {
      expect(row.cgstPaise).toBe(row.sgstPaise);
      expect(row.taxablePaise + row.cgstPaise + row.sgstPaise).toBe(row.totalPaise);
    }
    expect(report.totals).toMatchObject({
      taxablePaise: 40_000,
      cgstPaise: 2_050,
      sgstPaise: 2_050,
      totalPaise: 44_100,
    });
  });
});

describe("GET /v1/admin/reports/h1-register", () => {
  it("lists Rx lines × dispensed batch with patient/doctor from the APPROVED Rx", async () => {
    const headers = await adminHeaders();
    const customer = await user("CUSTOMER");

    const order = await seedOrder(customer.id, {
      status: OrderStatus.DELIVERED,
      deliveredAt: istInstant("2026-06-15", "11:00"),
      requiresRx: true,
      rxStatus: RxStatus.APPROVED,
      invoiceNo: "MR/26-27/000042",
      totalPaise: 13_000,
      items: [
        {
          nameSnap: "Alprazolam 0.5mg",
          requiresRx: true,
          pricePaise: 5_000,
          qty: 2,
          allocations: [{ batchNoSnap: "ALP-B1", qty: 2 }],
        },
        {
          nameSnap: "Vitamin C",
          requiresRx: false,
          pricePaise: 3_000,
          qty: 1,
          allocations: [{ batchNoSnap: "VC-B1", qty: 1 }],
        },
      ],
      prescription: { status: RxStatus.APPROVED, patientName: "John Doe", doctorName: "Dr. Smith" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/reports/h1-register?from=2026-06-15&to=2026-06-15",
      headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json().data;

    // Only the Rx item's allocation is registered; the OTC item is excluded.
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toEqual({
      date: "2026-06-15",
      orderNo: order.orderNo,
      invoiceNo: "MR/26-27/000042",
      productName: "Alprazolam 0.5mg",
      batchNo: "ALP-B1",
      qty: 2,
      patientName: "John Doe",
      doctorName: "Dr. Smith",
    });
  });
});

describe("admin analytics RBAC", () => {
  it("rejects a CUSTOMER token with 403", async () => {
    const headers = authHeaders(await user("CUSTOMER"));
    const res = await app.inject({ method: "GET", url: "/v1/admin/dashboard", headers });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects an INVENTORY token with 403", async () => {
    const headers = authHeaders(await user("INVENTORY"));
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/reports/gst?from=2026-06-01&to=2026-06-02",
      headers,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
