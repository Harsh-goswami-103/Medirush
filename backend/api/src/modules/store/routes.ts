import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  GetStoreResponseSchema,
  ServiceabilityBodySchema,
  ServiceabilityResponseSchema,
} from "@medrush/contracts";
import { getFlag } from "../../core/flags";
import { getStoreConfig, haversineM } from "../../core/storeInfo";

/**
 * Store endpoints (§7.2):
 * - GET  /v1/store — ⭘ public; StoreConfig public fields + client-safe flags
 *   subset + min app versions. Edge-cacheable (§12).
 * - POST /v1/serviceability — authed; `{lat,lng}` → in-radius? distance? fee?
 */

/** §12: public catalog-ish payloads ride the CDN for 60s. */
const STORE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export const storeRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/store",
    {
      config: { public: true },
      schema: {
        tags: ["store"],
        summary: "Store status, hours, fee rules, client feature flags, min app versions",
        response: { 200: GetStoreResponseSchema },
      },
    },
    async (_request, reply) => {
      const config = await getStoreConfig();

      // Client-safe flags subset (§5): cod_enabled, rx_orders_enabled,
      // maintenance_banner — camelCased to match the pinned `codEnabled` key.
      const [codEnabled, rxOrdersEnabled, maintenanceBanner] = await Promise.all([
        getFlag<boolean>("cod_enabled", true),
        getFlag<boolean>("rx_orders_enabled", false),
        getFlag<boolean | string>("maintenance_banner", false),
      ]);

      void reply.header("cache-control", STORE_CACHE_CONTROL);
      return {
        data: {
          name: config.name,
          address: config.address,
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
          supportPhone: config.supportPhone,
          minCustomerAppVersion: config.minCustomerAppVersion,
          minDriverAppVersion: config.minDriverAppVersion,
          featureFlags: { codEnabled, rxOrdersEnabled, maintenanceBanner },
          drugLicenseNo: config.drugLicenseNo,
          pharmacistName: config.pharmacistName,
          pharmacistRegNo: config.pharmacistRegNo,
          gstin: config.gstin,
          fssaiNo: config.fssaiNo,
        },
      };
    },
  );

  app.post(
    "/serviceability",
    {
      schema: {
        tags: ["store"],
        summary: "Is a point inside the delivery radius, and at what base fee?",
        body: ServiceabilityBodySchema,
        response: { 200: ServiceabilityResponseSchema },
      },
    },
    async (request, reply) => {
      const config = await getStoreConfig();
      const distanceM = haversineM({ lat: config.lat, lng: config.lng }, request.body);
      const serviceable = distanceM <= config.serviceRadiusM;

      void reply.header("cache-control", "no-store");
      return {
        data: {
          serviceable,
          distanceM,
          // Base fee only — the free-delivery threshold applies at checkout.
          deliveryPaise: serviceable ? config.deliveryBasePaise : null,
        },
      };
    },
  );
};
