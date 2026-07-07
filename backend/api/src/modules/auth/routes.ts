import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AuthSyncBodySchema,
  AuthSyncResponseSchema,
  GetMeResponseSchema,
  UpdateMeBodySchema,
  UpdateMeResponseSchema,
  type User as UserDto,
} from "@medrush/contracts";
import type { User } from "@prisma/client";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { invalidateUserCache, requireSyncedAuth } from "../../plugins/auth";

/**
 * Auth/profile endpoints (§7.2):
 * - POST /v1/auth/sync — upsert PG user after Firebase login (allowUnsynced)
 * - GET  /v1/me · PATCH /v1/me (name/email only)
 */

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export const authRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Profile data is personal — never cache (§12).
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.getHeader("cache-control")) void reply.header("cache-control", "no-store");
  });

  app.post(
    "/auth/sync",
    {
      config: { allowUnsynced: true },
      schema: {
        tags: ["auth"],
        summary: "Upsert user after Firebase login",
        body: AuthSyncBodySchema,
        response: { 200: AuthSyncResponseSchema },
      },
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);

      const { name, email } = request.body;
      const user = await getPrisma().user.upsert({
        where: { firebaseUid: auth.uid },
        // Role defaults to CUSTOMER (schema default); phone comes from the
        // verified token, never the body (§8.1).
        create: { firebaseUid: auth.uid, phone: auth.phone, name, email },
        update: {
          phone: auth.phone,
          ...(name !== undefined ? { name } : {}),
          ...(email !== undefined ? { email } : {}),
        },
      });

      // The auth hook may have cached "no row / old phone" this minute.
      invalidateUserCache(auth.uid);

      return { data: toUserDto(user) };
    },
  );

  app.get(
    "/me",
    {
      schema: {
        tags: ["auth"],
        summary: "Own profile",
        response: { 200: GetMeResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const user = await getPrisma().user.findUnique({ where: { id: userId } });
      if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
      return { data: toUserDto(user) };
    },
  );

  app.patch(
    "/me",
    {
      schema: {
        tags: ["auth"],
        summary: "Update own profile (name/email only)",
        body: UpdateMeBodySchema,
        response: { 200: UpdateMeResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { name, email } = request.body;

      const user = await getPrisma().user.update({
        where: { id: userId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(email !== undefined ? { email } : {}),
        },
      });
      return { data: toUserDto(user) };
    },
  );
};
