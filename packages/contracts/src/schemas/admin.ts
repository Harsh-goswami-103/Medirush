/**
 * Admin endpoints (BLUEPRINT §7.2 — role ADMIN).
 *
 * | Endpoint                                   | Body / Query / Params         | Response data                  |
 * |--------------------------------------------|-------------------------------|--------------------------------|
 * | GET  /v1/admin/dashboard                   | DashboardQuerySchema          | DashboardKpisSchema            |
 * | GET  /v1/admin/orders                      | AdminOrderListQuerySchema     | AdminOrderSchema[] + meta      |
 * | GET  /v1/admin/drivers                     | —                             | AdminDriverSchema[]            |
 * | POST /v1/admin/drivers/:id/verify          | IdParams                      | AdminDriverSchema              |
 * | POST /v1/admin/drivers/:id/block           | BlockBodySchema               | AdminDriverSchema              |
 * | GET  /v1/admin/payouts                     | AdminPayoutListQuerySchema    | AdminPayoutSchema[] + meta     |
 * | POST /v1/admin/payouts/:id/approve         | IdParams                      | AdminPayoutSchema              |
 * | POST /v1/admin/payouts/:id/mark-paid       | MarkPayoutPaidBodySchema      | AdminPayoutSchema              |
 * | POST /v1/admin/payouts/:id/reject          | RejectPayoutBodySchema        | AdminPayoutSchema              |
 * | GET  /v1/admin/users                       | AdminUserListQuerySchema      | AdminUserSchema[] + meta       |
 * | POST /v1/admin/users/:id/block             | BlockBodySchema               | AdminUserSchema                |
 * | POST /v1/admin/users/:id/role              | SetUserRoleBodySchema         | AdminUserSchema                |
 * | GET  /v1/admin/coupons                     | CouponListQuerySchema         | CouponSchema[] + meta          |
 * | POST /v1/admin/coupons                     | CreateCouponBodySchema        | CouponSchema                   |
 * | PATCH /v1/admin/coupons/:id                | UpdateCouponBodySchema        | CouponSchema                   |
 * | DELETE /v1/admin/coupons/:id               | IdParams (deactivate)         | OkSchema                       |
 * | GET  /v1/admin/settings                    | —                             | AdminSettingsSchema            |
 * | PUT  /v1/admin/settings                    | UpdateSettingsBodySchema      | AdminSettingsSchema            |
 * | GET  /v1/admin/reports/sales               | ReportQuerySchema             | SalesReportSchema              |
 * | GET  /v1/admin/reports/gst                 | ReportQuerySchema             | GstReportSchema                |
 * | GET  /v1/admin/reports/h1-register         | ReportQuerySchema             | H1RegisterSchema               |
 *
 * Report endpoints also accept `format=csv` → `text/csv` attachment (the zod
 * response schemas below describe the JSON form only).
 */
import { z } from "zod";
import {
  CouponKindSchema,
  OrderStatusSchema,
  PaymentMethodSchema,
  PayoutStatusSchema,
  RiskFlagSchema,
  RoleSchema,
  RxStatusSchema,
} from "../enums";
import {
  CountSchema,
  CursorQuerySchema,
  GstRateSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LatSchema,
  LngSchema,
  MetersSchema,
  OkSchema,
  PaiseSchema,
  PhoneSchema,
  QtySchema,
  SemverSchema,
  TimeHHMMSchema,
  envelope,
  paginatedEnvelope,
} from "./common";
import { PayoutSchema } from "./wallet";
import { OpsOrderSummarySchema } from "./inventory";

/* ------------------------------------------------------------- dashboard */

/** GET /v1/admin/dashboard?range */
export const DashboardQuerySchema = z.object({
  range: z.enum(["today", "7d", "30d"]).default("today"),
});
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

export const DashboardKpisSchema = z.object({
  range: z.enum(["today", "7d", "30d"]),
  ordersPlaced: CountSchema,
  ordersDelivered: CountSchema,
  ordersCancelled: CountSchema,
  /** Σ totalPaise of DELIVERED orders in range. */
  revenuePaise: PaiseSchema,
  /** Average order value (delivered), rounded to integer paise. */
  aovPaise: PaiseSchema,
  /** % of deliveries within the 40-min SLA (0–100, one decimal is fine). */
  onTimePct: z.number().min(0).max(100),
  /** Drivers currently online. */
  activeDrivers: CountSchema,
  /** Products at/below their low-stock threshold. */
  lowStockCount: CountSchema,
  /** COD collected by drivers but not yet reconciled with the store. */
  codDuePaise: PaiseSchema,
});
export type DashboardKpis = z.infer<typeof DashboardKpisSchema>;
export const DashboardResponseSchema = envelope(DashboardKpisSchema);

/* ---------------------------------------------------------------- orders */

/** GET /v1/admin/orders?filters — add `format=csv` for export. */
export const AdminOrderListQuerySchema = CursorQuerySchema.extend({
  status: OrderStatusSchema.optional(),
  paymentMethod: PaymentMethodSchema.optional(),
  rxStatus: RxStatusSchema.optional(),
  /** Inclusive calendar-date range (IST). */
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  /** Matches orderNo or customer phone. */
  search: z.string().trim().min(1).max(100).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
export type AdminOrderListQuery = z.infer<typeof AdminOrderListQuerySchema>;

export const AdminOrderSchema = OpsOrderSummarySchema.extend({
  userId: IdSchema,
  customerPhone: PhoneSchema,
});
export type AdminOrder = z.infer<typeof AdminOrderSchema>;
export const AdminListOrdersResponseSchema = paginatedEnvelope(AdminOrderSchema);

/* --------------------------------------------------------------- drivers */

export const AdminDriverSchema = z.object({
  /** DriverProfile id (used in /drivers/:id/... routes and driverRoom()). */
  id: IdSchema,
  userId: IdSchema,
  name: z.string().nullable(),
  phone: PhoneSchema,
  vehicleType: z.string(),
  vehicleNo: z.string().nullable(),
  licenseNo: z.string().nullable(),
  isVerified: z.boolean(),
  isOnline: z.boolean(),
  /** User-level block (rejected at auth hook). */
  isBlocked: z.boolean(),
  /** Last known position for the fleet map; null before first ping. */
  lastLocation: z.object({ lat: LatSchema, lng: LngSchema }).nullable(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
  walletBalancePaise: PaiseSchema,
  totalDeliveries: CountSchema,
  /** Driver-initiated cancels — repeated cancels are a §9.5 flag. */
  cancelCount: CountSchema,
});
export type AdminDriver = z.infer<typeof AdminDriverSchema>;

/** GET /v1/admin/drivers — single-store fleet is small; no pagination. */
export const AdminListDriversResponseSchema = envelope(z.array(AdminDriverSchema));

/** POST /v1/admin/drivers/:id/verify — no body. */
export const VerifyDriverResponseSchema = envelope(AdminDriverSchema);

/** Shared block/unblock body (drivers and users). */
export const BlockBodySchema = z.object({
  blocked: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
export type BlockBody = z.infer<typeof BlockBodySchema>;
export const BlockDriverResponseSchema = envelope(AdminDriverSchema);

/* --------------------------------------------------------------- payouts */

export const AdminPayoutSchema = PayoutSchema.extend({
  driverId: IdSchema,
  driverName: z.string().nullable(),
  driverPhone: PhoneSchema,
});
export type AdminPayout = z.infer<typeof AdminPayoutSchema>;

/** GET /v1/admin/payouts?status */
export const AdminPayoutListQuerySchema = CursorQuerySchema.extend({
  status: PayoutStatusSchema.optional(),
});
export type AdminPayoutListQuery = z.infer<typeof AdminPayoutListQuerySchema>;
export const AdminListPayoutsResponseSchema = paginatedEnvelope(AdminPayoutSchema);

/** POST /v1/admin/payouts/:id/approve — debits the wallet immediately (funds locked, §9.6). */
export const ApprovePayoutResponseSchema = envelope(AdminPayoutSchema);

/** POST /v1/admin/payouts/:id/mark-paid */
export const MarkPayoutPaidBodySchema = z.object({
  /** Bank UTR reference of the UPI/IMPS transfer. */
  utr: z.string().trim().min(4).max(50),
});
export type MarkPayoutPaidBody = z.infer<typeof MarkPayoutPaidBodySchema>;
export const MarkPayoutPaidResponseSchema = envelope(AdminPayoutSchema);

/** POST /v1/admin/payouts/:id/reject — triggers a compensating wallet CREDIT (§9.6). */
export const RejectPayoutBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RejectPayoutBody = z.infer<typeof RejectPayoutBodySchema>;
export const RejectPayoutResponseSchema = envelope(AdminPayoutSchema);

/* ----------------------------------------------------------------- users */

/** Admin view of a user — includes fraud fields hidden from the customer surface. */
export const AdminUserSchema = z.object({
  id: IdSchema,
  phone: PhoneSchema,
  name: z.string().nullable(),
  email: z.email().nullable(),
  role: RoleSchema,
  isBlocked: z.boolean(),
  /** COD refusals at door (≥2 → COD disabled, §10.3). */
  codRefusalCount: CountSchema,
  riskFlag: RiskFlagSchema,
  createdAt: IsoDateTimeSchema,
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

/** GET /v1/admin/users */
export const AdminUserListQuerySchema = CursorQuerySchema.extend({
  /** Matches phone or name. */
  search: z.string().trim().min(1).max(100).optional(),
  role: RoleSchema.optional(),
  blocked: z.stringbool().optional(),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;
export const AdminListUsersResponseSchema = paginatedEnvelope(AdminUserSchema);

/** POST /v1/admin/users/:id/block */
export const BlockUserResponseSchema = envelope(AdminUserSchema);

/** POST /v1/admin/users/:id/role — sets PG role + Firebase claim, revokes refresh tokens (§8.2). */
export const SetUserRoleBodySchema = z.object({
  role: RoleSchema,
});
export type SetUserRoleBody = z.infer<typeof SetUserRoleBodySchema>;
export const SetUserRoleResponseSchema = envelope(AdminUserSchema);

/* --------------------------------------------------------------- coupons */

export const CouponSchema = z.object({
  id: IdSchema,
  code: z.string(),
  kind: CouponKindSchema,
  /** Paise off when kind=FLAT; percent (1–100) when kind=PERCENT. */
  valuePaiseOrPct: z.number().int().positive(),
  minOrderPaise: PaiseSchema,
  /** Cap for PERCENT coupons; null = uncapped. */
  maxDiscountPaise: PaiseSchema.nullable(),
  /** Global redemption cap; null = unlimited. */
  usageLimit: QtySchema.nullable(),
  /** Enforced per user AND per delivery-address hash (§10.3). */
  perUserLimit: QtySchema,
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  isActive: z.boolean(),
  /** Total redemptions so far. */
  redemptionCount: CountSchema,
});
export type Coupon = z.infer<typeof CouponSchema>;

const couponBodyBase = z.object({
  /** Uppercase A–Z, digits, `-`/`_`; 3–32 chars. */
  code: z.string().regex(/^[A-Z0-9_-]{3,32}$/),
  kind: CouponKindSchema,
  valuePaiseOrPct: z.number().int().positive(),
  minOrderPaise: PaiseSchema.optional(),
  maxDiscountPaise: PaiseSchema.optional(),
  usageLimit: QtySchema.optional(),
  perUserLimit: QtySchema.optional(),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
  isActive: z.boolean().optional(),
});

/** POST /v1/admin/coupons */
export const CreateCouponBodySchema = couponBodyBase.superRefine((b, ctx) => {
  if (b.kind === "PERCENT" && b.valuePaiseOrPct > 100) {
    ctx.addIssue({
      code: "custom",
      path: ["valuePaiseOrPct"],
      message: "PERCENT coupons must be 1–100",
    });
  }
  if (new Date(b.endsAt) <= new Date(b.startsAt)) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
  }
});
export type CreateCouponBody = z.infer<typeof CreateCouponBodySchema>;
export const CreateCouponResponseSchema = envelope(CouponSchema);

/** PATCH /v1/admin/coupons/:id */
export const UpdateCouponBodySchema = couponBodyBase.partial();
export type UpdateCouponBody = z.infer<typeof UpdateCouponBodySchema>;
export const UpdateCouponResponseSchema = envelope(CouponSchema);

/** GET /v1/admin/coupons */
export const CouponListQuerySchema = CursorQuerySchema.extend({
  active: z.stringbool().optional(),
});
export type CouponListQuery = z.infer<typeof CouponListQuerySchema>;
export const ListCouponsResponseSchema = paginatedEnvelope(CouponSchema);

/** DELETE /v1/admin/coupons/:id — deactivate (redemption history survives). */
export const DeleteCouponResponseSchema = envelope(OkSchema);

/* -------------------------------------------------------------- settings */

/** Editable StoreConfig fields (single row). Every change is audit-logged. */
export const StoreSettingsSchema = z.object({
  name: z.string(),
  address: z.string(),
  drugLicenseNo: z.string().nullable(),
  pharmacistName: z.string().nullable(),
  pharmacistRegNo: z.string().nullable(),
  gstin: z.string().nullable(),
  fssaiNo: z.string().nullable(),
  lat: LatSchema,
  lng: LngSchema,
  serviceRadiusM: MetersSchema,
  /** Kill-switch: false instantly blocks checkout (§19 incident lever). */
  isOpen: z.boolean(),
  openTime: TimeHHMMSchema,
  closeTime: TimeHHMMSchema,
  minOrderPaise: PaiseSchema,
  deliveryBasePaise: PaiseSchema,
  freeDeliveryAbovePaise: PaiseSchema,
  codLimitPaise: PaiseSchema,
  /** Driver commission: base + perKm × ceil(distanceM/1000) (§9.6). */
  commissionBasePaise: PaiseSchema,
  commissionPerKmPaise: PaiseSchema,
  minDriverAppVersion: SemverSchema,
  minCustomerAppVersion: SemverSchema,
  supportPhone: z.string(),
});
export type StoreSettings = z.infer<typeof StoreSettingsSchema>;

/** `AppSetting` feature flags & tunables, keyed by setting name (e.g. "cod_enabled"). */
export const AppFlagsSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.number(), z.string()]),
);
export type AppFlags = z.infer<typeof AppFlagsSchema>;

export const AdminSettingsSchema = z.object({
  store: StoreSettingsSchema,
  flags: AppFlagsSchema,
});
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;
export const GetSettingsResponseSchema = envelope(AdminSettingsSchema);

/** PUT /v1/admin/settings — partial update of either half. */
export const UpdateSettingsBodySchema = z.object({
  store: StoreSettingsSchema.partial().optional(),
  flags: AppFlagsSchema.optional(),
});
export type UpdateSettingsBody = z.infer<typeof UpdateSettingsBodySchema>;
export const UpdateSettingsResponseSchema = envelope(AdminSettingsSchema);

/* --------------------------------------------------------------- reports */

/** Shared query for /v1/admin/reports/* — `format=csv` streams text/csv instead. */
export const ReportQuerySchema = z.object({
  /** Inclusive IST calendar dates. */
  from: IsoDateSchema,
  to: IsoDateSchema,
  format: z.enum(["json", "csv"]).default("json"),
});
export type ReportQuery = z.infer<typeof ReportQuerySchema>;

/* Sales register (per-day rollup of DELIVERED orders). */
export const SalesReportRowSchema = z.object({
  date: IsoDateSchema,
  orders: CountSchema,
  itemsPaise: PaiseSchema,
  deliveryPaise: PaiseSchema,
  discountPaise: PaiseSchema,
  totalPaise: PaiseSchema,
  /** COD vs prepaid split of totalPaise. */
  codPaise: PaiseSchema,
  prepaidPaise: PaiseSchema,
});
export type SalesReportRow = z.infer<typeof SalesReportRowSchema>;

export const SalesReportSchema = z.object({
  rows: z.array(SalesReportRowSchema),
  totals: SalesReportRowSchema.omit({ date: true }),
});
export type SalesReport = z.infer<typeof SalesReportSchema>;
export const SalesReportResponseSchema = envelope(SalesReportSchema);

/**
 * GST summary. GST is inclusive in pricePaise; taxable value is back-computed
 * `round(line / (1 + r/100))` and split equally CGST/SGST (intra-state, §9.2).
 */
export const GstReportRowSchema = z.object({
  hsnCode: z.string().nullable(),
  gstRatePct: GstRateSchema,
  taxablePaise: PaiseSchema,
  cgstPaise: PaiseSchema,
  sgstPaise: PaiseSchema,
  totalPaise: PaiseSchema,
});
export type GstReportRow = z.infer<typeof GstReportRowSchema>;

export const GstReportSchema = z.object({
  rows: z.array(GstReportRowSchema),
  totals: GstReportRowSchema.omit({ hsnCode: true, gstRatePct: true }),
});
export type GstReport = z.infer<typeof GstReportSchema>;
export const GstReportResponseSchema = envelope(GstReportSchema);

/** Schedule H1 register — statutory (3-year retention): drug, batch, qty, patient, doctor, date. */
export const H1RegisterRowSchema = z.object({
  date: IsoDateSchema,
  orderNo: z.string(),
  invoiceNo: z.string().nullable(),
  productName: z.string(),
  batchNo: z.string(),
  qty: QtySchema,
  patientName: z.string().nullable(),
  doctorName: z.string().nullable(),
});
export type H1RegisterRow = z.infer<typeof H1RegisterRowSchema>;

export const H1RegisterSchema = z.object({
  rows: z.array(H1RegisterRowSchema),
});
export type H1Register = z.infer<typeof H1RegisterSchema>;
export const H1RegisterResponseSchema = envelope(H1RegisterSchema);
