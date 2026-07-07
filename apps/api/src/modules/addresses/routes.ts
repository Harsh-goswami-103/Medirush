import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  type Address as AddressDto,
  CreateAddressBodySchema,
  CreateAddressResponseSchema,
  DeleteAddressResponseSchema,
  IdParamsSchema,
  ListAddressesResponseSchema,
  Role,
  UpdateAddressBodySchema,
  UpdateAddressResponseSchema,
} from "@medrush/contracts";
import type { Address, Prisma } from "@prisma/client";
import { getPrisma } from "../../core/db";
import { AppError } from "../../core/errors";
import { requireSyncedAuth } from "../../plugins/auth";

/**
 * Address book (§7.2 — customer CRUD, ownership enforced §8.3).
 * `isDefault` is exclusive: setting it clears every other default in a TX.
 * Foreign addresses answer 404 (existence is not leaked).
 */

function toAddressDto(address: Address): AddressDto {
  return {
    id: address.id,
    label: address.label,
    line1: address.line1,
    line2: address.line2,
    landmark: address.landmark,
    pincode: address.pincode,
    lat: address.lat,
    lng: address.lng,
    isDefault: address.isDefault,
  };
}

async function getOwnedAddress(id: string, userId: string): Promise<Address> {
  const address = await getPrisma().address.findUnique({ where: { id } });
  if (!address || address.userId !== userId) {
    throw new AppError("NOT_FOUND", "Address not found", 404);
  }
  return address;
}

export const addressRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Personal data — never cache (§12).
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.getHeader("cache-control")) void reply.header("cache-control", "no-store");
  });

  app.get(
    "/addresses",
    {
      config: { roles: [Role.CUSTOMER] },
      schema: {
        tags: ["addresses"],
        summary: "List own addresses",
        response: { 200: ListAddressesResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const addresses = await getPrisma().address.findMany({
        where: { userId },
        orderBy: [{ isDefault: "desc" }, { id: "asc" }],
      });
      return { data: addresses.map(toAddressDto) };
    },
  );

  app.post(
    "/addresses",
    {
      config: { roles: [Role.CUSTOMER] },
      schema: {
        tags: ["addresses"],
        summary: "Create address",
        body: CreateAddressBodySchema,
        response: { 201: CreateAddressResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId } = requireSyncedAuth(request);
      const body = request.body;

      const address = await getPrisma().$transaction(async (tx) => {
        if (body.isDefault === true) {
          await tx.address.updateMany({
            where: { userId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.address.create({
          data: {
            userId,
            label: body.label ?? "Home",
            line1: body.line1,
            line2: body.line2 ?? null,
            landmark: body.landmark ?? null,
            pincode: body.pincode,
            lat: body.lat,
            lng: body.lng,
            isDefault: body.isDefault ?? false,
          },
        });
      });

      void reply.code(201);
      return { data: toAddressDto(address) };
    },
  );

  app.patch(
    "/addresses/:id",
    {
      config: { roles: [Role.CUSTOMER] },
      schema: {
        tags: ["addresses"],
        summary: "Update address",
        params: IdParamsSchema,
        body: UpdateAddressBodySchema,
        response: { 200: UpdateAddressResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { id } = request.params;
      const body = request.body;

      await getOwnedAddress(id, userId);

      const data: Prisma.AddressUpdateInput = {};
      if (body.label !== undefined) data.label = body.label;
      if (body.line1 !== undefined) data.line1 = body.line1;
      if (body.line2 !== undefined) data.line2 = body.line2;
      if (body.landmark !== undefined) data.landmark = body.landmark;
      if (body.pincode !== undefined) data.pincode = body.pincode;
      if (body.lat !== undefined) data.lat = body.lat;
      if (body.lng !== undefined) data.lng = body.lng;
      if (body.isDefault !== undefined) data.isDefault = body.isDefault;

      const updated = await getPrisma().$transaction(async (tx) => {
        if (body.isDefault === true) {
          await tx.address.updateMany({
            where: { userId, isDefault: true, id: { not: id } },
            data: { isDefault: false },
          });
        }
        return tx.address.update({ where: { id }, data });
      });

      return { data: toAddressDto(updated) };
    },
  );

  app.delete(
    "/addresses/:id",
    {
      config: { roles: [Role.CUSTOMER] },
      schema: {
        tags: ["addresses"],
        summary: "Delete address",
        params: IdParamsSchema,
        response: { 200: DeleteAddressResponseSchema },
      },
    },
    async (request) => {
      const { userId } = requireSyncedAuth(request);
      const { id } = request.params;

      await getOwnedAddress(id, userId);
      await getPrisma().address.delete({ where: { id } });

      return { data: { ok: true as const } };
    },
  );
};
