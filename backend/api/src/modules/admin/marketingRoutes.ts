import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CouponListQuerySchema,
  CreateCouponBodySchema,
  CreateCouponResponseSchema,
  DeleteCouponResponseSchema,
  GetSettingsResponseSchema,
  IdParamsSchema,
  ListCouponsResponseSchema,
  Role,
  UpdateCouponBodySchema,
  UpdateCouponResponseSchema,
  UpdateSettingsBodySchema,
  UpdateSettingsResponseSchema,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import {
  createCoupon,
  deactivateCoupon,
  listCoupons,
  updateCoupon,
  type AdminActor,
} from "./couponService";
import { getSettings, updateSettings } from "./settingsService";

/**
 * Admin marketing surfaces — coupons CRUD + store/flags settings (BLUEPRINT
 * §7.2 admin rows; RBAC §8: ADMIN only). Registered under the /v1 prefix by
 * modules/v1.ts. Every action here is audit-logged inside its service tx.
 */

const ADMIN_ROLES: Role[] = [Role.ADMIN];

/** Narrow the (ADMIN-gated) request auth to the AuditLog actor. */
function requireActor(request: FastifyRequest): AdminActor {
  return { userId: requireSyncedAuth(request).userId };
}

export const adminMarketingRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: coupons/settings are live config surfaces — never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  /* ------------------------------------------------------------- coupons */

  typed.get(
    "/admin/coupons",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "List coupons (cursor-paginated, optional active filter)",
        querystring: CouponListQuerySchema,
        response: { 200: ListCouponsResponseSchema },
      },
    },
    async (request) => {
      const { coupons, nextCursor } = await listCoupons(request.query);
      return { data: coupons, meta: { nextCursor } };
    },
  );

  typed.post(
    "/admin/coupons",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Create a coupon (code stored uppercase & unique → 409 on dup)",
        body: CreateCouponBodySchema,
        response: { 201: CreateCouponResponseSchema },
      },
    },
    async (request, reply) => {
      const data = await createCoupon(request.body, requireActor(request));
      void reply.code(201);
      return { data };
    },
  );

  typed.patch(
    "/admin/coupons/:id",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Update a coupon",
        params: IdParamsSchema,
        body: UpdateCouponBodySchema,
        response: { 200: UpdateCouponResponseSchema },
      },
    },
    async (request) => ({
      data: await updateCoupon(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.delete(
    "/admin/coupons/:id",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Deactivate a coupon (redemption history survives)",
        params: IdParamsSchema,
        response: { 200: DeleteCouponResponseSchema },
      },
    },
    async (request) => {
      await deactivateCoupon(request.params.id, requireActor(request));
      return { data: { ok: true as const } };
    },
  );

  /* ------------------------------------------------------------ settings */

  typed.get(
    "/admin/settings",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Get store settings + feature flags",
        response: { 200: GetSettingsResponseSchema },
      },
    },
    async () => ({ data: await getSettings() }),
  );

  typed.put(
    "/admin/settings",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Partially update store fields and/or flags (busts config caches)",
        body: UpdateSettingsBodySchema,
        response: { 200: UpdateSettingsResponseSchema },
      },
    },
    async (request) => ({
      data: await updateSettings(request.body, requireActor(request)),
    }),
  );
};
