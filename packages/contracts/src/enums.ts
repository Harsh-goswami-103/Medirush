/**
 * Prisma enums mirrored as const objects + zod schemas (BLUEPRINT §6.2).
 *
 * This package is consumed by browser/native clients, so it must NEVER import
 * `@prisma/client`. `apps/api` owns the Prisma schema; these mirrors are the
 * wire contract. Keep both in lock-step — any drift is a breaking change.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ Role */
export const Role = {
  CUSTOMER: "CUSTOMER",
  DRIVER: "DRIVER",
  INVENTORY: "INVENTORY",
  ADMIN: "ADMIN",
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const RoleSchema = z.enum(Role);

/* -------------------------------------------------------- ScheduleClass */
/** Indian drug schedule of a product. Schedule X is never stocked (by design there is no value for it). */
export const ScheduleClass = {
  NONE: "NONE",
  OTC: "OTC",
  H: "H",
  H1: "H1",
} as const;
export type ScheduleClass = (typeof ScheduleClass)[keyof typeof ScheduleClass];
export const ScheduleClassSchema = z.enum(ScheduleClass);

/* ---------------------------------------------------------- OrderStatus */
export const OrderStatus = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PLACED: "PLACED",
  RX_REVIEW: "RX_REVIEW",
  PACKING: "PACKING",
  READY: "READY",
  ASSIGNED: "ASSIGNED",
  PICKED_UP: "PICKED_UP",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const OrderStatusSchema = z.enum(OrderStatus);

/* -------------------------------------------------------- PaymentMethod */
export const PaymentMethod = {
  PREPAID: "PREPAID",
  COD: "COD",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const PaymentMethodSchema = z.enum(PaymentMethod);

/* -------------------------------------------------------- PaymentStatus */
export const PaymentStatus = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  REFUND_INITIATED: "REFUND_INITIATED",
  REFUNDED: "REFUNDED",
  COD_DUE: "COD_DUE",
  COD_COLLECTED: "COD_COLLECTED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];
export const PaymentStatusSchema = z.enum(PaymentStatus);

/* ------------------------------------------------------------- RxStatus */
export const RxStatus = {
  NA: "NA",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;
export type RxStatus = (typeof RxStatus)[keyof typeof RxStatus];
export const RxStatusSchema = z.enum(RxStatus);

/* ---------------------------------------------------------- OfferStatus */
export const OfferStatus = {
  OFFERED: "OFFERED",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;
export type OfferStatus = (typeof OfferStatus)[keyof typeof OfferStatus];
export const OfferStatusSchema = z.enum(OfferStatus);

/* -------------------------------------------------------------- TxnType */
export const TxnType = {
  CREDIT: "CREDIT",
  DEBIT: "DEBIT",
  PAYOUT: "PAYOUT",
  ADJUSTMENT: "ADJUSTMENT",
} as const;
export type TxnType = (typeof TxnType)[keyof typeof TxnType];
export const TxnTypeSchema = z.enum(TxnType);

/* --------------------------------------------------------- PayoutStatus */
export const PayoutStatus = {
  REQUESTED: "REQUESTED",
  APPROVED: "APPROVED",
  PAID: "PAID",
  REJECTED: "REJECTED",
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];
export const PayoutStatusSchema = z.enum(PayoutStatus);

/* --------------------------------------------------------- AdjustReason */
export const AdjustReason = {
  RECEIVED: "RECEIVED",
  SALE: "SALE",
  CANCEL_RESTOCK: "CANCEL_RESTOCK",
  RETURN: "RETURN",
  DAMAGE: "DAMAGE",
  EXPIRY: "EXPIRY",
  CORRECTION: "CORRECTION",
} as const;
export type AdjustReason = (typeof AdjustReason)[keyof typeof AdjustReason];
export const AdjustReasonSchema = z.enum(AdjustReason);

/* ------------------------------------------------------------ ActorType */
export const ActorType = {
  SYSTEM: "SYSTEM",
  CUSTOMER: "CUSTOMER",
  OPS: "OPS",
  DRIVER: "DRIVER",
  ADMIN: "ADMIN",
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];
export const ActorTypeSchema = z.enum(ActorType);

/* ----------------------------------------------------------------------
 * String-column "enums" (not Prisma enums, but fixed value sets in §6.2).
 * -------------------------------------------------------------------- */

/** `User.riskFlag` — fraud/abuse standing (§10.3). Stored as String in Prisma. */
export const RiskFlag = {
  NONE: "NONE",
  WATCH: "WATCH",
  COD_BLOCKED: "COD_BLOCKED",
  BLOCKED: "BLOCKED",
} as const;
export type RiskFlag = (typeof RiskFlag)[keyof typeof RiskFlag];
export const RiskFlagSchema = z.enum(RiskFlag);

/** `Coupon.kind` — FLAT is paise off, PERCENT is % off (capped by maxDiscountPaise). */
export const CouponKind = {
  FLAT: "FLAT",
  PERCENT: "PERCENT",
} as const;
export type CouponKind = (typeof CouponKind)[keyof typeof CouponKind];
export const CouponKindSchema = z.enum(CouponKind);

/** `DeviceToken.platform`. */
export const DevicePlatform = {
  WEB: "web",
  ANDROID: "android",
} as const;
export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];
export const DevicePlatformSchema = z.enum(DevicePlatform);

/** `WalletTxn.refType`. */
export const WalletTxnRefType = {
  ORDER: "ORDER",
  PAYOUT: "PAYOUT",
} as const;
export type WalletTxnRefType = (typeof WalletTxnRefType)[keyof typeof WalletTxnRefType];
export const WalletTxnRefTypeSchema = z.enum(WalletTxnRefType);
