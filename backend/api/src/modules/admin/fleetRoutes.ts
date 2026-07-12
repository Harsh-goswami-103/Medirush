import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AdminListDriversResponseSchema,
  AdminListPayoutsResponseSchema,
  AdminListUsersResponseSchema,
  AdminPayoutListQuerySchema,
  AdminUserListQuerySchema,
  AnonymizeUserResponseSchema,
  ApprovePayoutResponseSchema,
  BlockBodySchema,
  BlockDriverResponseSchema,
  BlockUserResponseSchema,
  IdParamsSchema,
  MarkPayoutPaidBodySchema,
  MarkPayoutPaidResponseSchema,
  RejectPayoutBodySchema,
  RejectPayoutResponseSchema,
  Role,
  SetUserRoleBodySchema,
  SetUserRoleResponseSchema,
  VerifyDriverResponseSchema,
} from "@medrush/contracts";
import { AppError } from "../../core/errors";
import { blockDriver, listDrivers, verifyDriver, type AdminActor } from "./driverService";
import { approvePayout, listPayouts, markPayoutPaid, rejectPayout } from "./payoutService";
import { anonymizeUser, blockUser, listUsers, setUserRole } from "./userService";

/**
 * Admin fleet + users (BLUEPRINT §7.2 — role ADMIN only). Driver verify/block,
 * payout approve/mark-paid/reject, and user list/block/role. Registered under
 * the /v1 prefix by modules/v1.ts.
 */

const ADMIN_ROLES: Role[] = [Role.ADMIN];

function requireActor(request: FastifyRequest): AdminActor {
  const auth = request.auth;
  if (!auth?.userId || !auth.role) {
    throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return { userId: auth.userId, role: auth.role };
}

export const adminFleetRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: admin fleet/user/payout responses (money + PII) are never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  /* --------------------------------------------------------------- drivers */

  typed.get(
    "/admin/drivers",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Fleet roster (all drivers with wallet + delivery/cancel counts)",
        response: { 200: AdminListDriversResponseSchema },
      },
    },
    async () => ({ data: await listDrivers() }),
  );

  typed.post(
    "/admin/drivers/:id/verify",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Mark a driver profile verified",
        params: IdParamsSchema,
        response: { 200: VerifyDriverResponseSchema },
      },
    },
    async (request) => ({ data: await verifyDriver(request.params.id, requireActor(request)) }),
  );

  typed.post(
    "/admin/drivers/:id/block",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Block/unblock a driver (sets the driver's User.isBlocked)",
        params: IdParamsSchema,
        body: BlockBodySchema,
        response: { 200: BlockDriverResponseSchema },
      },
    },
    async (request) => ({
      data: await blockDriver(request.params.id, request.body, requireActor(request)),
    }),
  );

  /* ----------------------------------------------------------------- users */

  typed.get(
    "/admin/users",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "User directory (cursor-paginated; search phone/name, role/blocked filters)",
        querystring: AdminUserListQuerySchema,
        response: { 200: AdminListUsersResponseSchema },
      },
    },
    async (request) => {
      const { users, nextCursor } = await listUsers(request.query);
      return { data: users, meta: { nextCursor } };
    },
  );

  typed.post(
    "/admin/users/:id/block",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Block/unblock a user account",
        params: IdParamsSchema,
        body: BlockBodySchema,
        response: { 200: BlockUserResponseSchema },
      },
    },
    async (request) => ({
      data: await blockUser(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.post(
    "/admin/users/:id/role",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Set a user's role (PG source of truth + Firebase claim when configured)",
        params: IdParamsSchema,
        body: SetUserRoleBodySchema,
        response: { 200: SetUserRoleResponseSchema },
      },
    },
    async (request) => ({
      data: await setUserRole(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.post(
    "/admin/users/:id/anonymize",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary:
          "DPDP erasure — scrub PII + delete addresses/devices/cart/notifications; statutory records kept (see docs/runbooks/data-erasure.md)",
        params: IdParamsSchema,
        response: { 200: AnonymizeUserResponseSchema },
      },
    },
    async (request) => ({
      data: await anonymizeUser(request.params.id, requireActor(request)),
    }),
  );

  /* --------------------------------------------------------------- payouts */

  typed.get(
    "/admin/payouts",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Payout queue (cursor-paginated; optional status filter; driver joined)",
        querystring: AdminPayoutListQuerySchema,
        response: { 200: AdminListPayoutsResponseSchema },
      },
    },
    async (request) => {
      const { payouts, nextCursor } = await listPayouts(request.query);
      return { data: payouts, meta: { nextCursor } };
    },
  );

  typed.post(
    "/admin/payouts/:id/approve",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Approve a payout — debits the driver wallet immediately (§9.6)",
        params: IdParamsSchema,
        response: { 200: ApprovePayoutResponseSchema },
      },
    },
    async (request) => ({ data: await approvePayout(request.params.id, requireActor(request)) }),
  );

  typed.post(
    "/admin/payouts/:id/mark-paid",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Record the bank UTR of a completed transfer (APPROVED → PAID)",
        params: IdParamsSchema,
        body: MarkPayoutPaidBodySchema,
        response: { 200: MarkPayoutPaidResponseSchema },
      },
    },
    async (request) => ({
      data: await markPayoutPaid(request.params.id, request.body, requireActor(request)),
    }),
  );

  typed.post(
    "/admin/payouts/:id/reject",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Reject a payout (compensating wallet CREDIT if it was APPROVED, §9.6)",
        params: IdParamsSchema,
        body: RejectPayoutBodySchema,
        response: { 200: RejectPayoutResponseSchema },
      },
    },
    async (request) => ({
      data: await rejectPayout(request.params.id, request.body, requireActor(request)),
    }),
  );
};
