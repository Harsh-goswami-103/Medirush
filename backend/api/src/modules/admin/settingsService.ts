import { Prisma } from "@prisma/client";
import type { StoreConfig } from "@prisma/client";
import type { AdminSettings, AppFlags, StoreSettings, UpdateSettingsBody } from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { bustFlagCache } from "../../core/flags";
import { bustStoreConfigCache } from "../../core/storeInfo";

/**
 * Admin store/flags settings (BLUEPRINT §7.2 admin rows, §12 config caches;
 * ADMIN only). GET projects the singleton StoreConfig row + the AppSetting
 * flags; PUT partially updates either half in one $transaction, audit-logs each
 * change, then busts the in-process StoreConfig + flag caches so the edit is
 * visible within the same request cycle. Route role gating lives in the plugin.
 */

/** Minimal admin identity threaded from the route for AuditLog attribution. */
export interface AdminActor {
  userId: string;
}

/** The StoreConfig id — single row (§6.2). */
const STORE_ID = "store";

/** Project the StoreConfig row onto the editable StoreSettings contract shape. */
function toStoreSettings(config: StoreConfig): StoreSettings {
  return {
    name: config.name,
    address: config.address,
    drugLicenseNo: config.drugLicenseNo,
    pharmacistName: config.pharmacistName,
    pharmacistRegNo: config.pharmacistRegNo,
    gstin: config.gstin,
    fssaiNo: config.fssaiNo,
    lat: config.lat,
    lng: config.lng,
    serviceRadiusM: config.serviceRadiusM,
    isOpen: config.isOpen,
    openTime: config.openTime,
    closeTime: config.closeTime,
    minOrderPaise: config.minOrderPaise,
    deliveryBasePaise: config.deliveryBasePaise,
    freeDeliveryAbovePaise: config.freeDeliveryAbovePaise,
    codLimitPaise: config.codLimitPaise,
    commissionBasePaise: config.commissionBasePaise,
    commissionPerKmPaise: config.commissionPerKmPaise,
    minDriverAppVersion: config.minDriverAppVersion,
    minCustomerAppVersion: config.minCustomerAppVersion,
    supportPhone: config.supportPhone,
  };
}

/**
 * AppSetting rows → the flat AppFlags record. Only scalar (boolean|number|
 * string) values are surfaced — that is exactly what AppFlagsSchema admits, so
 * a stray object/array/null flag can never break response serialization.
 */
function toAppFlags(rows: { key: string; value: Prisma.JsonValue }[]): AppFlags {
  const flags: AppFlags = {};
  for (const row of rows) {
    const value = row.value;
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      flags[row.key] = value;
    }
  }
  return flags;
}

/* --------------------------------------------------------------- queries */

/** Current settings: store config + feature flags. */
export async function getSettings(): Promise<AdminSettings> {
  const prisma = getPrisma();
  const [config, settingRows] = await Promise.all([
    prisma.storeConfig.findUnique({ where: { id: STORE_ID } }),
    prisma.appSetting.findMany(),
  ]);
  if (!config) {
    throw new AppError("STORE_CONFIG_MISSING", "StoreConfig row is missing — seed the database", 500);
  }
  return { store: toStoreSettings(config), flags: toAppFlags(settingRows) };
}

/* --------------------------------------------------------------- actions */

/**
 * Partial update of store fields and/or feature flags. Store fields patch the
 * singleton StoreConfig; each flag upserts its AppSetting row. One AuditLog row
 * is written per changed half (store) / per flag key. Caches are busted AFTER
 * the tx commits so a concurrent read never repopulates them pre-commit (§12).
 */
export async function updateSettings(
  body: UpdateSettingsBody,
  actor: AdminActor,
): Promise<AdminSettings> {
  const prisma = getPrisma();

  const storeData: Partial<StoreSettings> = body.store ?? {};
  const storeKeys = Object.keys(storeData);
  const flags: AppFlags = body.flags ?? {};
  const flagKeys = Object.keys(flags);

  await prisma.$transaction(async (tx) => {
    if (storeKeys.length > 0) {
      // Conditional guard: 0 rows means StoreConfig was never seeded.
      const updated = await tx.storeConfig.updateMany({
        where: { id: STORE_ID },
        data: storeData as Prisma.StoreConfigUpdateManyMutationInput,
      });
      if (updated.count !== 1) {
        throw new AppError(
          "STORE_CONFIG_MISSING",
          "StoreConfig row is missing — seed the database",
          500,
        );
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "SETTINGS_STORE_UPDATE",
          entity: "StoreConfig",
          entityId: STORE_ID,
          meta: { changed: storeKeys },
        },
      });
    }

    for (const key of flagKeys) {
      const value = flags[key] as Prisma.InputJsonValue;
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value, updatedBy: actor.userId },
        update: { value, updatedBy: actor.userId },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          action: "SETTINGS_FLAG_UPDATE",
          entity: "AppSetting",
          entityId: key,
          meta: { key, value },
        },
      });
    }
  });

  bustStoreConfigCache();
  bustFlagCache();

  return getSettings();
}
