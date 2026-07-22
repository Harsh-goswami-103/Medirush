import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApiErrorSchema,
  ApplyReferralBodySchema,
  ReferralSummaryResponseSchema,
  Role,
} from "@medrush/contracts";
import { requireSyncedAuth } from "../../plugins/auth";
import { applyReferral, getReferralSummary } from "./service";

/**
 * Referral programme (§17 v1.1 — CUSTOMER only, own rows only):
 * - GET  /v1/referrals       (summary; generates the caller's code on first read)
 * - POST /v1/referrals/apply (attribute the caller to a referrer's code)
 */

const customerOnly = { roles: [Role.CUSTOMER] };

export const referralRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Personal data — never cache (§12).
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get(
    "/referrals",
    {
      config: customerOnly,
      schema: {
        tags: ["referrals"],
        summary: "Own referral code, counts and earned reward coupons",
        response: { 200: ReferralSummaryResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await getReferralSummary(userId) };
    },
  );

  app.post(
    "/referrals/apply",
    {
      config: customerOnly,
      schema: {
        tags: ["referrals"],
        summary: "Apply a friend's referral code (new accounts only) and get the welcome coupon",
        body: ApplyReferralBodySchema,
        response: {
          200: ReferralSummaryResponseSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          422: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      return { data: await applyReferral(userId, request.body.code) };
    },
  );
};
