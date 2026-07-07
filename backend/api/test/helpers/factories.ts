import type { Prisma } from "@prisma/client";
import type { Role } from "@medrush/contracts";
import { getPrisma } from "../../src/core/db";
import { bustFlagCache } from "../../src/core/flags";
import { bustStoreConfigCache } from "../../src/core/storeInfo";

/**
 * Minimal fixture builders for integration tests (phase-1 brief). Every builder
 * generates unique keys (monotonic counter) so the 60s auth/user caches never
 * return stale rows between truncations. `storeConfig`/`appSettings` bust the
 * in-process caches after writing so callers observe fresh values immediately.
 */

let counter = 0;
const next = (): number => (counter += 1);

/* ------------------------------------------------------------------- store */

/** The default store position all fixtures sit near (Bengaluru). */
export const STORE_LAT = 12.9716;
export const STORE_LNG = 77.5946;

export type StoreConfigOverrides = Partial<Prisma.StoreConfigUncheckedCreateInput>;

/**
 * Upsert the singleton StoreConfig (id="store"). Defaults to ALWAYS OPEN
 * (openTime === closeTime) so checkout tests are independent of wall-clock IST.
 */
export async function storeConfig(overrides: StoreConfigOverrides = {}) {
  const prisma = getPrisma();
  const data: Prisma.StoreConfigUncheckedCreateInput = {
    id: "store",
    name: "MedRush Test Store",
    address: "1 Test Street, Bengaluru",
    lat: STORE_LAT,
    lng: STORE_LNG,
    supportPhone: "+919999999999",
    serviceRadiusM: 5000,
    isOpen: true,
    openTime: "00:00",
    closeTime: "00:00", // open === close ⇒ always open (isStoreOpenNow)
    minOrderPaise: 9900,
    deliveryBasePaise: 2000,
    freeDeliveryAbovePaise: 49900,
    codLimitPaise: 150000,
    commissionBasePaise: 2500,
    commissionPerKmPaise: 500,
    minDriverAppVersion: "1.0.0",
    minCustomerAppVersion: "1.0.0",
    ...overrides,
  };
  const row = await prisma.storeConfig.upsert({
    where: { id: "store" },
    create: data,
    update: data,
  });
  bustStoreConfigCache();
  return row;
}

/* ------------------------------------------------------------ app settings */

/** Default launch flags (§5, §10.3). Overrides win; the flag cache is busted. */
export async function appSettings(overrides: Record<string, unknown> = {}) {
  const prisma = getPrisma();
  const values: Record<string, unknown> = {
    cod_enabled: true,
    rx_orders_enabled: true,
    maintenance_banner: false,
    new_account_cod_cap: 50000,
    dispatch_wave_size: 3,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    const json = value as Prisma.InputJsonValue;
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json },
    });
  }
  bustFlagCache();
}

/* -------------------------------------------------------------------- user */

/** Create a user with a unique firebaseUid + E.164 phone for the given role. */
export async function user(role: Role = "CUSTOMER", overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const n = next();
  return getPrisma().user.create({
    data: {
      firebaseUid: `dev-uid-${role.toLowerCase()}-${n}`,
      phone: `+91${7000000000 + n}`,
      name: `Test ${role} ${n}`,
      role,
      ...overrides,
    },
  });
}

/* ----------------------------------------------------------------- address */

export interface AddressOverrides {
  label?: string;
  line1?: string;
  line2?: string | null;
  landmark?: string | null;
  pincode?: string;
  lat?: number;
  lng?: number;
  isDefault?: boolean;
}

/** Create an address for `userId`. Defaults to the store position (in-radius). */
export async function address(userId: string, overrides: AddressOverrides = {}) {
  const n = next();
  return getPrisma().address.create({
    data: {
      userId,
      label: overrides.label ?? "Home",
      line1: overrides.line1 ?? `${n} Test Road`,
      line2: overrides.line2 ?? null,
      landmark: overrides.landmark ?? null,
      pincode: overrides.pincode ?? "560001",
      lat: overrides.lat ?? STORE_LAT,
      lng: overrides.lng ?? STORE_LNG,
      isDefault: overrides.isDefault ?? false,
    },
  });
}

/* ----------------------------------------------------------------- product */

export interface ProductOverrides {
  /** Alias for `stockQty`. */
  stock?: number;
  requiresRx?: boolean;
  pricePaise?: number;
  mrpPaise?: number;
  gstRatePct?: number;
  maxPerOrder?: number;
  isActive?: boolean;
  name?: string;
  packSize?: string;
  categoryId?: string;
  scheduleClass?: "NONE" | "OTC" | "H" | "H1";
  lowStockThreshold?: number;
}

/** Create a product (auto-creating a category unless `categoryId` is given). */
export async function product(overrides: ProductOverrides = {}) {
  const prisma = getPrisma();
  const n = next();

  let categoryId = overrides.categoryId;
  if (!categoryId) {
    const category = await prisma.category.create({
      data: { name: `Test Category ${n}`, slug: `test-category-${n}` },
    });
    categoryId = category.id;
  }

  return prisma.product.create({
    data: {
      name: overrides.name ?? `Test Product ${n}`,
      slug: `test-product-${n}`,
      categoryId,
      mrpPaise: overrides.mrpPaise ?? 12000,
      pricePaise: overrides.pricePaise ?? 10000,
      gstRatePct: overrides.gstRatePct ?? 12,
      packSize: overrides.packSize ?? "Strip of 10",
      stockQty: overrides.stock ?? 100,
      maxPerOrder: overrides.maxPerOrder ?? 10,
      requiresRx: overrides.requiresRx ?? false,
      isActive: overrides.isActive ?? true,
      ...(overrides.scheduleClass ? { scheduleClass: overrides.scheduleClass } : {}),
      ...(overrides.lowStockThreshold !== undefined
        ? { lowStockThreshold: overrides.lowStockThreshold }
        : {}),
    },
  });
}

/* ------------------------------------------------------------------- batch */

const DAY_MS = 86_400_000;

export interface BatchOverrides {
  batchNo?: string;
  /** Days from now until expiry (default 365 → well beyond the FEFO 30d cutoff). */
  expiryInDays?: number;
  expiryDate?: Date;
  /** Sets both qtyReceived and qtyAvailable unless the specific fields are given. */
  qty?: number;
  qtyReceived?: number;
  qtyAvailable?: number;
  costPaise?: number;
  wholesaler?: string;
  invoiceNo?: string;
}

/** Create a stock batch for `productId`. */
export async function batch(productId: string, overrides: BatchOverrides = {}) {
  const n = next();
  const qty = overrides.qty ?? 100;
  const expiryDate =
    overrides.expiryDate ?? new Date(Date.now() + (overrides.expiryInDays ?? 365) * DAY_MS);

  return getPrisma().batch.create({
    data: {
      productId,
      batchNo: overrides.batchNo ?? `BATCH-${n}`,
      expiryDate,
      qtyReceived: overrides.qtyReceived ?? qty,
      qtyAvailable: overrides.qtyAvailable ?? qty,
      costPaise: overrides.costPaise ?? 4000,
      wholesaler: overrides.wholesaler ?? "Test Wholesale Co",
      invoiceNo: overrides.invoiceNo ?? `INV-${n}`,
    },
  });
}
