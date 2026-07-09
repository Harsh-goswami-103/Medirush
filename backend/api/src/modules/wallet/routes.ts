import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreatePayoutBodySchema,
  CreatePayoutResponseSchema,
  GetWalletResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  ListPayoutsResponseSchema,
  ListWalletTxnsResponseSchema,
  PayoutListQuerySchema,
  PayoutStatus,
  Role,
  WalletTxnListQuerySchema,
  type Payout,
  type WalletTxn,
  type WalletTxnRefType,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { withIdempotency } from "../../core/idempotency";

/**
 * Driver wallet & payout endpoints (BLUEPRINT §7.2 driver rows; §9.6).
 * - GET  /driver/wallet          balance
 * - GET  /driver/wallet/txns     ledger history
 * - POST /driver/payouts         request a payout (Idempotency-Key)
 * - GET  /driver/payouts         payout history
 */

const DRIVER_ROLES: Role[] = [Role.DRIVER];

/**
 * Resolve the authenticated user's DriverProfile. Returns the user id (used to
 * scope the Idempotency-Key on payout requests) plus the DriverProfile id (the
 * driver identity carried across wallet/payout/delivery rows).
 */
async function requireDriver(
  request: FastifyRequest,
): Promise<{ userId: string; driverId: string }> {
  const auth = request.auth;
  if (!auth?.userId) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  const profile = await getPrisma().driverProfile.findUnique({
    where: { userId: auth.userId },
    select: { id: true },
  });
  if (!profile) throw new AppError("FORBIDDEN", "No driver profile for this user", 403);
  return { userId: auth.userId, driverId: profile.id };
}

/** Shape a Payout row onto the driver-facing PayoutSchema (no driver join). */
function toPayout(row: {
  id: string;
  amountPaise: number;
  status: PayoutStatus;
  method: string;
  upiOrAcct: string;
  utr: string | null;
  requestedAt: Date;
  processedAt: Date | null;
}): Payout {
  return {
    id: row.id,
    amountPaise: row.amountPaise,
    status: row.status,
    method: row.method,
    upiOrAcct: row.upiOrAcct,
    utr: row.utr,
    requestedAt: row.requestedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
  };
}

export const walletRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: wallet/ledger responses (money + PII) are never cached.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  typed.get(
    "/driver/wallet",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["wallet"],
        summary: "Wallet balance",
        response: { 200: GetWalletResponseSchema },
      },
    },
    async (request) => {
      const { driverId } = await requireDriver(request);
      const wallet = await getPrisma().wallet.findUnique({
        where: { driverId },
        select: { balancePaise: true },
      });
      // No wallet row until the first credit — balance is simply zero.
      return { data: { balancePaise: wallet?.balancePaise ?? 0 } };
    },
  );

  typed.get(
    "/driver/wallet/txns",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["wallet"],
        summary: "Ledger history (cursor-paginated, newest first)",
        querystring: WalletTxnListQuerySchema,
        response: { 200: ListWalletTxnsResponseSchema },
      },
    },
    async (request) => {
      const { driverId } = await requireDriver(request);
      const prisma = getPrisma();

      const wallet = await prisma.wallet.findUnique({
        where: { driverId },
        select: { id: true },
      });
      if (!wallet) return { data: [], meta: { nextCursor: null } };

      const { cursor, limit } = request.query;
      const rows = await prisma.walletTxn.findMany({
        where: { walletId: wallet.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];

      const data: WalletTxn[] = page.map((txn) => ({
        id: txn.id,
        type: txn.type,
        amountPaise: txn.amountPaise,
        balanceAfterPaise: txn.balanceAfterPaise,
        refType: (txn.refType as WalletTxnRefType | null) ?? null,
        refId: txn.refId,
        note: txn.note,
        createdAt: txn.createdAt.toISOString(),
      }));

      return { data, meta: { nextCursor: hasMore && last ? last.id : null } };
    },
  );

  typed.post(
    "/driver/payouts",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["wallet"],
        summary: "Request a payout (Idempotency-Key; ₹500 ≤ amount ≤ wallet balance)",
        body: CreatePayoutBodySchema,
        response: { 200: CreatePayoutResponseSchema, 201: CreatePayoutResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId, driverId } = await requireDriver(request);

      // §7.1: payout requests are idempotent — the key is mandatory (400 if absent).
      const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (key.length === 0) {
        throw new AppError("VALIDATION_ERROR", "Idempotency-Key header is required", 400);
      }

      const { amountPaise, upiOrAcct, method } = request.body;

      const result = await withIdempotency(key, userId, () =>
        getPrisma().$transaction(async (tx) => {
          // amountPaise ≥ MIN_PAYOUT_PAISE is enforced by the contract; here we
          // additionally require it not to exceed the current balance. NO ledger
          // movement — funds are debited at admin approval (§9.6, P3), so this is
          // an advisory balance gate (no wallet lock / fund hold) at request time.
          const wallet = await tx.wallet.findUnique({
            where: { driverId },
            select: { balancePaise: true },
          });
          const balancePaise = wallet?.balancePaise ?? 0;
          if (amountPaise > balancePaise) {
            throw new AppError(
              "VALIDATION_ERROR",
              `Payout amount exceeds the available balance (${balancePaise} paise)`,
              422,
              { amountPaise, balancePaise },
            );
          }

          const payout = await tx.payout.create({
            data: { driverId, amountPaise, upiOrAcct, method, status: PayoutStatus.REQUESTED },
          });
          return toPayout(payout);
        }),
      );

      reply.code(result.replayed ? 200 : 201);
      return { data: result.response };
    },
  );

  typed.get(
    "/driver/payouts",
    {
      config: { roles: DRIVER_ROLES },
      schema: {
        tags: ["wallet"],
        summary: "Payout history (cursor-paginated, newest first, optional status filter)",
        querystring: PayoutListQuerySchema,
        response: { 200: ListPayoutsResponseSchema },
      },
    },
    async (request) => {
      const { driverId } = await requireDriver(request);
      const prisma = getPrisma();

      const { cursor, limit, status } = request.query;
      const rows = await prisma.payout.findMany({
        where: { driverId, ...(status ? { status } : {}) },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];

      const data: Payout[] = page.map(toPayout);
      return { data, meta: { nextCursor: hasMore && last ? last.id : null } };
    },
  );
};
