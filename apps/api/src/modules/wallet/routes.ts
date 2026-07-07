import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  GetWalletResponseSchema,
  ListWalletTxnsResponseSchema,
  Role,
  WalletTxnListQuerySchema,
  type WalletTxn,
  type WalletTxnRefType,
} from "@medrush/contracts";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";

/**
 * Driver wallet reads (BLUEPRINT §7.2 driver rows; §9.6). Payout endpoints
 * land in a later phase — Phase 1 ships balance + ledger history.
 */

const DRIVER_ROLES: Role[] = [Role.DRIVER];

async function requireDriverProfileId(request: FastifyRequest): Promise<string> {
  const auth = request.auth;
  if (!auth?.userId) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
  const profile = await getPrisma().driverProfile.findUnique({
    where: { userId: auth.userId },
    select: { id: true },
  });
  if (!profile) throw new AppError("FORBIDDEN", "No driver profile for this user", 403);
  return profile.id;
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
      const driverId = await requireDriverProfileId(request);
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
      const driverId = await requireDriverProfileId(request);
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
};
