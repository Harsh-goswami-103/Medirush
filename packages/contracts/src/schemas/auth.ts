/**
 * Auth / profile / address-book / device endpoints (BLUEPRINT §7.2 — Customer).
 *
 * | Endpoint                        | Body / Query / Params            | Response data           |
 * |---------------------------------|----------------------------------|-------------------------|
 * | POST   /v1/auth/sync            | AuthSyncBodySchema               | UserSchema              |
 * | GET    /v1/me                   | —                                | UserSchema              |
 * | PATCH  /v1/me                   | UpdateMeBodySchema               | UserSchema              |
 * | GET    /v1/addresses            | —                                | AddressSchema[]         |
 * | POST   /v1/addresses            | CreateAddressBodySchema          | AddressSchema           |
 * | PATCH  /v1/addresses/:id        | UpdateAddressBodySchema + IdParams| AddressSchema          |
 * | DELETE /v1/addresses/:id        | IdParams                         | OkSchema                |
 * | POST   /v1/devices              | RegisterDeviceBodySchema         | OkSchema                |
 *
 * Identity itself is Firebase Phone-OTP; the API only sees verified ID tokens.
 * `auth/sync` upserts the PG user right after a Firebase login.
 */
import { z } from "zod";
import { DevicePlatformSchema, RoleSchema } from "../enums";
import {
  AckResponseSchema,
  IdSchema,
  IsoDateTimeSchema,
  LatSchema,
  LngSchema,
  OkSchema,
  PhoneSchema,
  PincodeSchema,
  envelope,
} from "./common";

/* ----------------------------------------------------------------- user */

/**
 * Client-safe view of the caller's own user row.
 * Internal-only fields are intentionally absent: `firebaseUid`, `isBlocked`,
 * `codRefusalCount`, `riskFlag` (fraud signals — admin surface only, see admin.ts).
 */
export const UserSchema = z.object({
  id: IdSchema,
  phone: PhoneSchema,
  name: z.string().nullable(),
  email: z.email().nullable(),
  role: RoleSchema,
  createdAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

/** POST /v1/auth/sync — phone comes from the verified Firebase token, not the body. */
export const AuthSyncBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.email().optional(),
});
export type AuthSyncBody = z.infer<typeof AuthSyncBodySchema>;
export const AuthSyncResponseSchema = envelope(UserSchema);

export const GetMeResponseSchema = envelope(UserSchema);

/** PATCH /v1/me */
export const UpdateMeBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.email().nullable().optional(),
});
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;
export const UpdateMeResponseSchema = envelope(UserSchema);

/* ------------------------------------------------------------ addresses */

export const AddressSchema = z.object({
  id: IdSchema,
  label: z.string(),
  line1: z.string(),
  line2: z.string().nullable(),
  landmark: z.string().nullable(),
  pincode: PincodeSchema,
  lat: LatSchema,
  lng: LngSchema,
  isDefault: z.boolean(),
});
export type Address = z.infer<typeof AddressSchema>;

export const ListAddressesResponseSchema = envelope(z.array(AddressSchema));

/** POST /v1/addresses — lat/lng come from map pin-drop or Ola autocomplete. */
export const CreateAddressBodySchema = z.object({
  /** Defaults to "Home" server-side when omitted. */
  label: z.string().trim().min(1).max(30).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(100).optional(),
  pincode: PincodeSchema,
  lat: LatSchema,
  lng: LngSchema,
  isDefault: z.boolean().optional(),
});
export type CreateAddressBody = z.infer<typeof CreateAddressBodySchema>;
export const CreateAddressResponseSchema = envelope(AddressSchema);

/** PATCH /v1/addresses/:id */
export const UpdateAddressBodySchema = CreateAddressBodySchema.partial();
export type UpdateAddressBody = z.infer<typeof UpdateAddressBodySchema>;
export const UpdateAddressResponseSchema = envelope(AddressSchema);

/** DELETE /v1/addresses/:id */
export const DeleteAddressResponseSchema = envelope(OkSchema);

/* -------------------------------------------------------------- devices */

/** POST /v1/devices — register an FCM token for push. */
export const RegisterDeviceBodySchema = z.object({
  token: z.string().min(1),
  platform: DevicePlatformSchema,
});
export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBodySchema>;
export const RegisterDeviceResponseSchema = AckResponseSchema;
