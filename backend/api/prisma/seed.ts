/**
 * MedRush idempotent dev seed (docs/BLUEPRINT.md §21.1).
 *
 * Creates: StoreConfig ("store"), AppSetting launch flags, 2 categories,
 * 12 products (supplements / OTC / 4 requiresRx H+H1), 3 batches per product
 * (+ RECEIVED StockAdjustment each), one user per role, verified driver profile
 * + wallet, a customer address, and ONE fully DELIVERED COD demo order with a
 * complete event trail, FEFO batch allocations, SALE adjustments, delivery
 * commission and a matching wallet CREDIT.
 *
 * Re-runnable: volatile rows (orders, batches, adjustments, txns) are
 * deleteMany'd then recreated; stable entities are upserted.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── helpers ────────────────────────────────────────────────────────────────

/** First day of the month, `months` from now, at UTC midnight (Prisma @db.Date). */
function monthsFromNow(months: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));
}

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

// ── seed data ──────────────────────────────────────────────────────────────

const CATEGORIES = [
  { slug: "medicines", name: "Medicines", sortOrder: 1 },
  { slug: "vitamins-supplements", name: "Vitamins & Supplements", sortOrder: 2 },
] as const;

type ScheduleClassValue = "NONE" | "OTC" | "H" | "H1";

interface SeedProduct {
  slug: string;
  name: string;
  brand: string;
  categorySlug: (typeof CATEGORIES)[number]["slug"];
  description: string;
  mrpPaise: number;
  pricePaise: number; // must be <= mrpPaise (legal requirement)
  gstRatePct: 5 | 12 | 18;
  hsnCode: string;
  packSize: string;
  composition: string;
  binLocation: string;
  searchKeywords: string;
  requiresRx: boolean;
  scheduleClass: ScheduleClassValue;
  maxPerOrder?: number;
}

/**
 * Health concerns power the "shop by concern" browse. `products` lists the
 * product slugs tagged with each concern.
 */
const HEALTH_CONCERNS = [
  { slug: "fever-pain", name: "Fever & Pain", sortOrder: 1, products: ["dolo-650-tablet", "crocin-advance-500-tablet", "volini-pain-relief-gel-75g"] },
  { slug: "cold-cough", name: "Cold & Cough", sortOrder: 2, products: ["vicks-vaporub-50ml"] },
  { slug: "digestive-care", name: "Digestive Care", sortOrder: 3, products: ["electral-powder-sachet"] },
  { slug: "bone-joint", name: "Bone & Joint", sortOrder: 4, products: ["shelcal-500-tablet", "volini-pain-relief-gel-75g"] },
  { slug: "daily-wellness", name: "Daily Wellness", sortOrder: 5, products: ["zincovit-tablet", "revital-h-men-30-capsules"] },
  { slug: "heart-bp", name: "Heart & BP", sortOrder: 6, products: ["telma-40-tablet"] },
] as const;

const PRODUCTS: SeedProduct[] = [
  {
    slug: "dolo-650-tablet",
    name: "Dolo 650 Tablet",
    brand: "Micro Labs",
    categorySlug: "medicines",
    description: "Paracetamol tablet for fever and mild to moderate pain relief.",
    mrpPaise: 3360,
    pricePaise: 3100,
    gstRatePct: 12,
    hsnCode: "30049099",
    packSize: "Strip of 15",
    composition: "Paracetamol 650mg",
    binLocation: "R1-S1",
    searchKeywords: "paracetamol acetaminophen fever headache bukhar",
    requiresRx: false,
    scheduleClass: "OTC",
  },
  {
    slug: "crocin-advance-500-tablet",
    name: "Crocin Advance 500mg Tablet",
    brand: "GSK",
    categorySlug: "medicines",
    description: "Fast-dissolving paracetamol for fever and body ache.",
    mrpPaise: 2150,
    pricePaise: 2000,
    gstRatePct: 12,
    hsnCode: "30049099",
    packSize: "Strip of 20",
    composition: "Paracetamol 500mg",
    binLocation: "R1-S2",
    searchKeywords: "paracetamol fever pain crocin",
    requiresRx: false,
    scheduleClass: "OTC",
  },
  {
    slug: "vicks-vaporub-50ml",
    name: "Vicks VapoRub 50ml",
    brand: "Procter & Gamble",
    categorySlug: "medicines",
    description: "Topical balm for relief from cold, cough and blocked nose.",
    mrpPaise: 15500,
    pricePaise: 14800,
    gstRatePct: 12,
    hsnCode: "30049011",
    packSize: "Jar of 50ml",
    composition: "Menthol, Camphor, Eucalyptus Oil",
    binLocation: "R1-S4",
    searchKeywords: "cold cough balm congestion vicks",
    requiresRx: false,
    scheduleClass: "OTC",
  },
  {
    slug: "volini-pain-relief-gel-75g",
    name: "Volini Pain Relief Gel 75g",
    brand: "Sun Pharma",
    categorySlug: "medicines",
    description: "Topical analgesic gel for muscle, joint and back pain.",
    mrpPaise: 26500,
    pricePaise: 24900,
    gstRatePct: 12,
    hsnCode: "30049090",
    packSize: "Tube of 75g",
    composition: "Diclofenac Diethylamine 1.16% w/w",
    binLocation: "R1-S5",
    searchKeywords: "pain relief gel sprain back pain diclofenac",
    requiresRx: false,
    scheduleClass: "OTC",
  },
  {
    slug: "electral-powder-sachet",
    name: "Electral Powder 21.8g",
    brand: "FDC",
    categorySlug: "medicines",
    description: "WHO-formula oral rehydration salts for dehydration.",
    mrpPaise: 2200,
    pricePaise: 2200,
    gstRatePct: 5,
    hsnCode: "30045020",
    packSize: "Sachet of 21.8g",
    composition: "Oral Rehydration Salts (WHO ORS formula)",
    binLocation: "R2-S1",
    searchKeywords: "ors rehydration electrolyte dehydration loose motion",
    requiresRx: false,
    scheduleClass: "NONE",
  },
  {
    slug: "zincovit-tablet",
    name: "Zincovit Tablet",
    brand: "Apex Laboratories",
    categorySlug: "vitamins-supplements",
    description: "Daily multivitamin and multimineral supplement with zinc.",
    mrpPaise: 11500,
    pricePaise: 10500,
    gstRatePct: 18,
    hsnCode: "21069099",
    packSize: "Strip of 15",
    composition: "Multivitamin, Multimineral & Zinc",
    binLocation: "R3-S2",
    searchKeywords: "multivitamin zinc immunity supplement",
    requiresRx: false,
    scheduleClass: "NONE",
  },
  {
    slug: "revital-h-men-30-capsules",
    name: "Revital H Men 30 Capsules",
    brand: "Sun Pharma",
    categorySlug: "vitamins-supplements",
    description: "Daily health supplement with ginseng, vitamins and minerals.",
    mrpPaise: 33500,
    pricePaise: 31500,
    gstRatePct: 18,
    hsnCode: "21069099",
    packSize: "Bottle of 30 capsules",
    composition: "Multivitamin, Ginseng, Zinc & Minerals",
    binLocation: "R3-S1",
    searchKeywords: "revital energy ginseng multivitamin men",
    requiresRx: false,
    scheduleClass: "NONE",
  },
  {
    slug: "shelcal-500-tablet",
    name: "Shelcal 500 Tablet",
    brand: "Torrent Pharma",
    categorySlug: "vitamins-supplements",
    description: "Calcium and vitamin D3 supplement for bone health.",
    mrpPaise: 12900,
    pricePaise: 11900,
    gstRatePct: 12,
    hsnCode: "30045010",
    packSize: "Strip of 15",
    composition: "Calcium Carbonate 500mg + Vitamin D3 250 IU",
    binLocation: "R3-S3",
    searchKeywords: "calcium vitamin d3 bones shelcal",
    requiresRx: false,
    scheduleClass: "NONE",
  },
  {
    slug: "azithral-500-tablet",
    name: "Azithral 500 Tablet",
    brand: "Alembic Pharmaceuticals",
    categorySlug: "medicines",
    description: "Macrolide antibiotic for bacterial infections. Prescription required.",
    mrpPaise: 13200,
    pricePaise: 11900,
    gstRatePct: 12,
    hsnCode: "30042039",
    packSize: "Strip of 5",
    composition: "Azithromycin 500mg",
    binLocation: "R4-S1",
    searchKeywords: "azithromycin antibiotic infection azithral",
    requiresRx: true,
    scheduleClass: "H",
    maxPerOrder: 3,
  },
  {
    slug: "moxikind-cv-625-tablet",
    name: "Moxikind-CV 625 Tablet",
    brand: "Mankind Pharma",
    categorySlug: "medicines",
    description: "Amoxicillin-clavulanate antibiotic. Prescription required.",
    mrpPaise: 22400,
    pricePaise: 20200,
    gstRatePct: 12,
    hsnCode: "30041070",
    packSize: "Strip of 10",
    composition: "Amoxicillin 500mg + Clavulanic Acid 125mg",
    binLocation: "R4-S2",
    searchKeywords: "amoxicillin clavulanate augmentin antibiotic",
    requiresRx: true,
    scheduleClass: "H",
    maxPerOrder: 3,
  },
  {
    slug: "telma-40-tablet",
    name: "Telma 40 Tablet",
    brand: "Glenmark",
    categorySlug: "medicines",
    description: "Telmisartan for hypertension management. Prescription required.",
    mrpPaise: 24800,
    pricePaise: 22300,
    gstRatePct: 5,
    hsnCode: "30049079",
    packSize: "Strip of 30",
    composition: "Telmisartan 40mg",
    binLocation: "R4-S3",
    searchKeywords: "telmisartan blood pressure hypertension bp telma",
    requiresRx: true,
    scheduleClass: "H",
    maxPerOrder: 5,
  },
  {
    slug: "alprax-0-5-tablet",
    name: "Alprax 0.5mg Tablet",
    brand: "Torrent Pharma",
    categorySlug: "medicines",
    description: "Alprazolam for anxiety disorders. Schedule H1 — register entry mandatory.",
    mrpPaise: 4200,
    pricePaise: 3900,
    gstRatePct: 12,
    hsnCode: "30049099",
    packSize: "Strip of 15",
    composition: "Alprazolam 0.5mg",
    binLocation: "R5-S1",
    searchKeywords: "alprazolam anxiety sleep alprax",
    requiresRx: true,
    scheduleClass: "H1",
    maxPerOrder: 2,
  },
];

const WHOLESALERS = [
  { name: "Karnataka Pharma Distributors", invoicePrefix: "KPD/25-26" },
  { name: "Bengaluru Medisales Agencies", invoicePrefix: "BMA/25-26" },
  { name: "Sagar Pharma & Surgicals", invoicePrefix: "SPS/25-26" },
] as const;

const BATCH_QTYS = [40, 60, 80] as const;
const BATCH_EXPIRY_MONTHS = [9, 15, 21] as const; // staggered future expiries

const USERS = {
  customer: {
    firebaseUid: "seed-firebase-customer",
    phone: "+919876543210",
    name: "Ananya Sharma",
    email: "ananya.sharma@example.com",
    role: "CUSTOMER",
  },
  driver: {
    firebaseUid: "seed-firebase-driver",
    phone: "+919876543211",
    name: "Ravi Kumar",
    email: "ravi.kumar@example.com",
    role: "DRIVER",
  },
  inventory: {
    firebaseUid: "seed-firebase-inventory",
    phone: "+919876543212",
    name: "Priya Patel",
    email: "priya.patel@example.com",
    role: "INVENTORY",
  },
  admin: {
    firebaseUid: "seed-firebase-admin",
    phone: "+919876543213",
    name: "Vikram Rao",
    email: "vikram.rao@example.com",
    role: "ADMIN",
  },
} as const;

const APP_SETTINGS: Array<{ key: string; value: boolean | number }> = [
  { key: "cod_enabled", value: true },
  { key: "rx_orders_enabled", value: true },
  { key: "dispatch_wave_size", value: 3 },
  { key: "new_account_cod_cap", value: 50000 }, // paise (₹500)
  { key: "maintenance_banner", value: false },
];

// ── demo order constants (paise math kept consistent) ─────────────────────

const ORDER_NO = "MR-250705-0001";
const ORDER_ITEMS: Array<{ slug: string; qty: number }> = [
  { slug: "dolo-650-tablet", qty: 2 }, //  2 × 3100 =  6200
  { slug: "electral-powder-sachet", qty: 1 }, //  1 × 2200 =  2200
  { slug: "revital-h-men-30-capsules", qty: 1 }, //  1 × 31500 = 31500
];
const DELIVERY_PAISE = 2000; // base fee (itemsPaise < freeDeliveryAbovePaise 49900)
const DISCOUNT_PAISE = 0;
const DISTANCE_M = 2400;
// §9.6: commission = base + perKm × ceil(distanceM/1000) → 2500 + 500 × ceil(2.4) = 4000
const COMMISSION_PAISE = 2500 + 500 * Math.ceil(DISTANCE_M / 1000);

/**
 * Destructive-seed guard. This seed deleteMany()s every order, payment,
 * prescription and wallet txn — it must never touch a real database.
 * Allowed only when the DATABASE_URL host is local (localhost/127.0.0.1) or
 * SEED_FORCE_DESTRUCTIVE=yes is set explicitly; NODE_ENV=production always
 * refuses. Dependency-free on purpose.
 */
function assertSafeSeedTarget(): void {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "Seed refused: NODE_ENV=production — this seed wipes orders/payments/prescriptions/wallet txns and must never run in production.",
    );
    process.exit(1);
  }
  let host = "";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    // Unparseable/missing DATABASE_URL → host stays "" → refused below.
  }
  const isLocalHost = host === "localhost" || host === "127.0.0.1";
  if (!isLocalHost && process.env.SEED_FORCE_DESTRUCTIVE !== "yes") {
    console.error(
      `Seed refused: DATABASE_URL host "${host || "(unparseable)"}" is not localhost/127.0.0.1 — set SEED_FORCE_DESTRUCTIVE=yes only if you really mean to wipe that database.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  assertSafeSeedTarget();
  console.log("Seeding MedRush dev database…");

  // 1 ── wipe volatile rows (FK-safe order) so re-seeding never crashes ─────
  await prisma.walletTxn.deleteMany();
  await prisma.itemBatchAlloc.deleteMany();
  await prisma.orderEvent.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.deliveryOffer.deleteMany();
  await prisma.prescription.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.couponRedemption.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.stockAdjustment.deleteMany();
  await prisma.batch.deleteMany();

  // 1b ── demo coupons (upsert by code; public ones feed GET /v1/coupons) ────
  const year = new Date().getFullYear();
  const couponWindow = {
    startsAt: new Date(`${year}-01-01T00:00:00+05:30`),
    endsAt: new Date(`${year + 1}-01-01T00:00:00+05:30`),
  };
  const DEMO_COUPONS = [
    {
      code: "WELCOME50",
      kind: "FLAT",
      valuePaiseOrPct: 5000,
      minOrderPaise: 29900,
      description: "Flat ₹50 off your order above ₹299",
      isPublic: true,
    },
    {
      code: "SAVE20",
      kind: "PERCENT",
      valuePaiseOrPct: 20,
      maxDiscountPaise: 10000,
      minOrderPaise: 9900,
      description: "20% off up to ₹100 on all orders",
      isPublic: true,
    },
  ] as const;
  for (const c of DEMO_COUPONS) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      create: { ...c, ...couponWindow, perUserLimit: 5, isActive: true },
      update: { ...c, ...couponWindow, isActive: true },
    });
  }

  // 2 ── store config (single row id="store") ───────────────────────────────
  const storeConfig = {
    name: "MedRush Pharmacy",
    address: "12, 80 Feet Road, Koramangala 6th Block, Bengaluru, Karnataka 560095",
    drugLicenseNo: "KA-B04-20B/21B-123456",
    pharmacistName: "Dr. Meera Nair",
    pharmacistRegNo: "KPC-45678",
    gstin: "29ABCDE1234F1Z5",
    fssaiNo: "11223344556677",
    lat: 12.9345,
    lng: 77.6187,
    serviceRadiusM: 5000,
    isOpen: true,
    openTime: "08:00",
    closeTime: "22:00",
    minOrderPaise: 9900,
    deliveryBasePaise: 2000,
    freeDeliveryAbovePaise: 49900,
    codLimitPaise: 150000,
    commissionBasePaise: 2500,
    commissionPerKmPaise: 500,
    supportPhone: "+918041234567",
  };
  await prisma.storeConfig.upsert({
    where: { id: "store" },
    create: { id: "store", ...storeConfig },
    update: storeConfig,
  });

  // 3 ── launch flags ────────────────────────────────────────────────────────
  for (const setting of APP_SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      create: { key: setting.key, value: setting.value, updatedBy: "seed" },
      update: { value: setting.value, updatedBy: "seed" },
    });
  }

  // 4 ── categories ─────────────────────────────────────────────────────────
  const categoryIdBySlug = new Map<string, string>();
  for (const category of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      create: { slug: category.slug, name: category.name, sortOrder: category.sortOrder },
      update: { name: category.name, sortOrder: category.sortOrder, isActive: true },
    });
    categoryIdBySlug.set(category.slug, row.id);
  }

  // 5 ── products ───────────────────────────────────────────────────────────
  const productIdBySlug = new Map<string, string>();
  for (const p of PRODUCTS) {
    if (p.pricePaise > p.mrpPaise) {
      throw new Error(`Seed bug: ${p.slug} pricePaise > mrpPaise`);
    }
    const categoryId = categoryIdBySlug.get(p.categorySlug);
    if (!categoryId) throw new Error(`Seed bug: unknown category ${p.categorySlug}`);
    const data = {
      name: p.name,
      brand: p.brand,
      description: p.description,
      categoryId,
      images: [],
      mrpPaise: p.mrpPaise,
      pricePaise: p.pricePaise,
      gstRatePct: p.gstRatePct,
      hsnCode: p.hsnCode,
      packSize: p.packSize,
      composition: p.composition,
      binLocation: p.binLocation,
      searchKeywords: p.searchKeywords,
      requiresRx: p.requiresRx,
      scheduleClass: p.scheduleClass,
      maxPerOrder: p.maxPerOrder ?? 10,
      isActive: true,
      stockQty: 0, // recomputed from batches at the end
    };
    const row = await prisma.product.upsert({
      where: { slug: p.slug },
      create: { slug: p.slug, ...data },
      update: data,
    });
    productIdBySlug.set(p.slug, row.id);
  }

  // 5b ── health concerns + their product tags (shop-by-concern browse) ──────
  for (const c of HEALTH_CONCERNS) {
    const concern = await prisma.healthConcern.upsert({
      where: { slug: c.slug },
      create: { slug: c.slug, name: c.name, sortOrder: c.sortOrder, isActive: true },
      update: { name: c.name, sortOrder: c.sortOrder, isActive: true },
    });
    for (const productSlug of c.products) {
      const productId = productIdBySlug.get(productSlug);
      if (!productId) throw new Error(`Seed bug: unknown product ${productSlug} in ${c.slug}`);
      await prisma.productHealthConcern.upsert({
        where: { productId_concernId: { productId, concernId: concern.id } },
        create: { productId, concernId: concern.id },
        update: {},
      });
    }
  }

  // 6 ── batches (3 per product, staggered future expiries) + RECEIVED adj ──
  // batchIdByProductSlug[slug][0] is the earliest-expiry batch (FEFO pick).
  const batchesByProductSlug = new Map<
    string,
    Array<{ id: string; batchNo: string; expiryDate: Date; qtyAvailable: number }>
  >();
  for (const [index, p] of PRODUCTS.entries()) {
    const productId = productIdBySlug.get(p.slug);
    if (!productId) throw new Error(`Seed bug: missing product ${p.slug}`);
    const rows: Array<{ id: string; batchNo: string; expiryDate: Date; qtyAvailable: number }> =
      [];
    for (let b = 0; b < 3; b += 1) {
      const wholesaler = WHOLESALERS[(index + b) % WHOLESALERS.length]!;
      const qty = BATCH_QTYS[b]!;
      const expiryDate = monthsFromNow(BATCH_EXPIRY_MONTHS[b]! + (index % 3));
      const batchNo = `B${String(index + 1).padStart(2, "0")}${String(b + 1)}${expiryDate
        .toISOString()
        .slice(2, 7)
        .replace("-", "")}`;
      const batch = await prisma.batch.create({
        data: {
          productId,
          batchNo,
          expiryDate,
          qtyReceived: qty,
          qtyAvailable: qty,
          costPaise: Math.round(p.pricePaise * 0.6),
          wholesaler: wholesaler.name,
          invoiceNo: `${wholesaler.invoicePrefix}/${String(1000 + index * 3 + b)}`,
        },
      });
      await prisma.stockAdjustment.create({
        data: {
          productId,
          batchId: batch.id,
          delta: qty,
          reason: "RECEIVED",
          note: `GRN ${batch.invoiceNo} (${wholesaler.name})`,
        },
      });
      rows.push({ id: batch.id, batchNo, expiryDate, qtyAvailable: qty });
    }
    batchesByProductSlug.set(p.slug, rows);
  }

  // 7 ── users (one per role) ───────────────────────────────────────────────
  const userIdByKey = new Map<string, string>();
  for (const [key, u] of Object.entries(USERS)) {
    const row = await prisma.user.upsert({
      where: { firebaseUid: u.firebaseUid },
      create: {
        firebaseUid: u.firebaseUid,
        phone: u.phone,
        name: u.name,
        email: u.email,
        role: u.role,
      },
      update: { phone: u.phone, name: u.name, email: u.email, role: u.role, isBlocked: false },
    });
    userIdByKey.set(key, row.id);
  }
  const customerId = userIdByKey.get("customer")!;
  const driverUserId = userIdByKey.get("driver")!;
  const inventoryUserId = userIdByKey.get("inventory")!;

  // 8 ── driver profile (verified) + wallet ─────────────────────────────────
  const driverProfile = await prisma.driverProfile.upsert({
    where: { userId: driverUserId },
    create: {
      userId: driverUserId,
      vehicleType: "bike",
      vehicleNo: "KA-01-AB-1234",
      licenseNo: "KA0120230012345",
      isVerified: true,
      isOnline: false,
    },
    update: { isVerified: true, vehicleNo: "KA-01-AB-1234", licenseNo: "KA0120230012345" },
  });
  const wallet = await prisma.wallet.upsert({
    where: { driverId: driverProfile.id },
    create: { driverId: driverProfile.id, balancePaise: 0 },
    update: { balancePaise: 0 }, // reset; the demo credit below re-establishes the balance
  });

  // 9 ── customer address ───────────────────────────────────────────────────
  await prisma.address.deleteMany({ where: { userId: customerId } });
  const address = await prisma.address.create({
    data: {
      userId: customerId,
      label: "Home",
      line1: "42, 5th Cross, Koramangala 4th Block",
      line2: "Opp. BDA Complex",
      landmark: "Near Sony World Signal",
      pincode: "560034",
      lat: 12.9316,
      lng: 77.6221,
      isDefault: true,
    },
  });

  // 10 ── ONE fully DELIVERED COD demo order ────────────────────────────────
  const orderItems = ORDER_ITEMS.map((line) => {
    const product = PRODUCTS.find((p) => p.slug === line.slug);
    if (!product) throw new Error(`Seed bug: unknown order item ${line.slug}`);
    return { product, qty: line.qty };
  });
  const itemsPaise = orderItems.reduce((sum, l) => sum + l.product.pricePaise * l.qty, 0);
  const totalPaise = itemsPaise + DELIVERY_PAISE - DISCOUNT_PAISE;

  const placedAt = minutesAfter(new Date(), -180); // ~3h ago
  const packingAt = minutesAfter(placedAt, 8);
  const packedAt = minutesAfter(placedAt, 14);
  const readyAt = minutesAfter(placedAt, 16);
  const assignedAt = minutesAfter(placedAt, 19);
  const pickedUpAt = minutesAfter(placedAt, 25);
  const deliveredAt = minutesAfter(placedAt, 37);

  const customer = USERS.customer;
  const order = await prisma.order.create({
    data: {
      orderNo: ORDER_NO,
      userId: customerId,
      status: "DELIVERED",
      paymentMethod: "COD",
      paymentStatus: "COD_COLLECTED",
      addressSnapshot: {
        name: customer.name,
        phone: customer.phone,
        line1: address.line1,
        line2: address.line2,
        landmark: address.landmark,
        pincode: address.pincode,
        lat: address.lat,
        lng: address.lng,
      },
      distanceM: DISTANCE_M,
      itemsPaise,
      deliveryPaise: DELIVERY_PAISE,
      discountPaise: DISCOUNT_PAISE,
      totalPaise,
      requiresRx: false,
      rxStatus: "NA",
      deliveryOtp: "4821",
      invoiceNo: "MR/26-27/000001",
      placedAt,
      packedAt,
      readyAt,
      deliveredAt,
      createdAt: placedAt,
    },
  });

  // order items (snapshots) + FEFO allocations from the earliest-expiry batch
  for (const line of orderItems) {
    const productId = productIdBySlug.get(line.product.slug)!;
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        nameSnap: line.product.name,
        packSizeSnap: line.product.packSize,
        pricePaise: line.product.pricePaise,
        mrpPaise: line.product.mrpPaise,
        gstRatePct: line.product.gstRatePct,
        hsnSnap: line.product.hsnCode,
        requiresRx: line.product.requiresRx,
        qty: line.qty,
      },
    });
    const fefoBatch = batchesByProductSlug.get(line.product.slug)![0]!;
    await prisma.itemBatchAlloc.create({
      data: {
        orderItemId: item.id,
        batchId: fefoBatch.id,
        batchNoSnap: fefoBatch.batchNo,
        expirySnap: fefoBatch.expiryDate,
        qty: line.qty,
      },
    });
    // consume stock from the allocated batch + SALE adjustment (ledger-consistent)
    await prisma.batch.update({
      where: { id: fefoBatch.id },
      data: { qtyAvailable: { decrement: line.qty } },
    });
    fefoBatch.qtyAvailable -= line.qty;
    await prisma.stockAdjustment.create({
      data: {
        productId,
        batchId: fefoBatch.id,
        delta: -line.qty,
        reason: "SALE",
        refOrderId: order.id,
      },
    });
  }

  // event trail PLACED → PACKING → READY → ASSIGNED → PICKED_UP → DELIVERED
  const events = [
    {
      from: null,
      to: "PLACED",
      actorType: "CUSTOMER",
      actorId: customerId,
      note: "Order placed (COD)",
      createdAt: placedAt,
    },
    {
      from: "PLACED",
      to: "PACKING",
      actorType: "OPS",
      actorId: inventoryUserId,
      note: "Packing started",
      createdAt: packingAt,
    },
    {
      from: "PACKING",
      to: "READY",
      actorType: "OPS",
      actorId: inventoryUserId,
      note: "Packed & ready — delivery OTP generated",
      createdAt: readyAt,
    },
    {
      from: "READY",
      to: "ASSIGNED",
      actorType: "SYSTEM",
      actorId: null,
      note: "Driver accepted offer (wave 1)",
      createdAt: assignedAt,
    },
    {
      from: "ASSIGNED",
      to: "PICKED_UP",
      actorType: "DRIVER",
      actorId: driverUserId,
      note: "Picked up at store",
      createdAt: pickedUpAt,
    },
    {
      from: "PICKED_UP",
      to: "DELIVERED",
      actorType: "DRIVER",
      actorId: driverUserId,
      note: "OTP verified, COD collected",
      createdAt: deliveredAt,
    },
  ] as const;
  for (const event of events) {
    await prisma.orderEvent.create({ data: { orderId: order.id, ...event } });
  }

  // delivery (accepted assignment) with timestamps + commission + COD
  await prisma.delivery.create({
    data: {
      orderId: order.id,
      driverId: driverProfile.id,
      acceptedAt: assignedAt,
      pickedUpAt,
      deliveredAt,
      otpVerifiedAt: deliveredAt,
      distanceM: DISTANCE_M,
      commissionPaise: COMMISSION_PAISE,
      codCollectedPaise: totalPaise,
    },
  });

  // wallet CREDIT — balanceAfter matches the wallet's cached balance
  await prisma.walletTxn.create({
    data: {
      walletId: wallet.id,
      type: "CREDIT",
      amountPaise: COMMISSION_PAISE,
      balanceAfterPaise: COMMISSION_PAISE,
      refType: "ORDER",
      refId: order.id,
      note: `Delivery commission for ${ORDER_NO}`,
      createdAt: deliveredAt,
    },
  });
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balancePaise: COMMISSION_PAISE },
  });

  // 11 ── product.stockQty = sum of its batches' qtyAvailable ───────────────
  for (const p of PRODUCTS) {
    const productId = productIdBySlug.get(p.slug)!;
    const stockQty = batchesByProductSlug
      .get(p.slug)!
      .reduce((sum, b) => sum + b.qtyAvailable, 0);
    await prisma.product.update({ where: { id: productId }, data: { stockQty } });
  }

  console.log(
    [
      "Seed complete:",
      `  store config        1 (id "store")`,
      `  app settings        ${APP_SETTINGS.length}`,
      `  categories          ${CATEGORIES.length}`,
      `  products            ${PRODUCTS.length} (${PRODUCTS.filter((p) => p.requiresRx).length} require Rx)`,
      `  batches             ${PRODUCTS.length * 3} (+ RECEIVED adjustments)`,
      `  users               4 (one per role)`,
      `  demo order          ${ORDER_NO} — DELIVERED, COD ₹${(totalPaise / 100).toFixed(2)}`,
      `  driver commission   ₹${(COMMISSION_PAISE / 100).toFixed(2)} credited to wallet`,
    ].join("\n"),
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
