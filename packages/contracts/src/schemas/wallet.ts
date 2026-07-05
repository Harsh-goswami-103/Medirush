/**
 * Driver wallet & payout endpoints (BLUEPRINT §7.2 — role DRIVER; §9.6 invariants).
 *
 * | Endpoint                                | Body / Query               | Response data           |
 * |-----------------------------------------|----------------------------|-------------------------|
 * | GET  /v1/driver/wallet                  | —                          | WalletSchema            |
 * | GET  /v1/driver/wallet/txns             | WalletTxnListQuerySchema   | WalletTxnSchema[] + meta|
 * | POST /v1/driver/payouts (Idempotency-Key)| CreatePayoutBodySchema    | PayoutSchema            |
 * | GET  /v1/driver/payouts                 | PayoutListQuerySchema      | PayoutSchema[] + meta   |
 *
 * Admin-side payout processing lives in admin.ts (AdminPayoutSchema).
 */
import { z } from "zod";
import { PayoutStatusSchema, TxnTypeSchema, WalletTxnRefTypeSchema } from "../enums";
import { MIN_PAYOUT_PAISE } from "../domain";
import {
  CursorQuerySchema,
  IdSchema,
  IsoDateTimeSchema,
  PaiseSchema,
  envelope,
  paginatedEnvelope,
} from "./common";

/* ---------------------------------------------------------------- wallet */

export const WalletSchema = z.object({
  /** Current balance in paise. Invariant: equals Σ(credits) − Σ(debits) of the ledger. */
  balancePaise: PaiseSchema,
});
export type Wallet = z.infer<typeof WalletSchema>;
export const GetWalletResponseSchema = envelope(WalletSchema);

/** Append-only ledger entry. `amountPaise` is ALWAYS positive; `type` carries the sign. */
export const WalletTxnSchema = z.object({
  id: IdSchema,
  type: TxnTypeSchema,
  amountPaise: PaiseSchema,
  /** Balance after this txn was applied (paise). */
  balanceAfterPaise: PaiseSchema,
  refType: WalletTxnRefTypeSchema.nullable(),
  /** Order id or payout id, matching `refType`. */
  refId: IdSchema.nullable(),
  note: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type WalletTxn = z.infer<typeof WalletTxnSchema>;

/** GET /v1/driver/wallet/txns */
export const WalletTxnListQuerySchema = CursorQuerySchema;
export const ListWalletTxnsResponseSchema = paginatedEnvelope(WalletTxnSchema);

/* --------------------------------------------------------------- payouts */

export const PayoutSchema = z.object({
  id: IdSchema,
  amountPaise: PaiseSchema,
  status: PayoutStatusSchema,
  /** "UPI" | "BANK" (free-form string column; UPI is the v1 default). */
  method: z.string(),
  /** UPI VPA or masked account identifier the driver supplied. */
  upiOrAcct: z.string(),
  /** Bank UTR reference, set when admin marks the payout paid. */
  utr: z.string().nullable(),
  requestedAt: IsoDateTimeSchema,
  processedAt: IsoDateTimeSchema.nullable(),
});
export type Payout = z.infer<typeof PayoutSchema>;

/**
 * POST /v1/driver/payouts — requires `Idempotency-Key` header.
 * Server enforces `amountPaise ≤ wallet.balancePaise`; funds are debited at
 * admin approval, and a rejected payout is compensated with a CREDIT (§9.6).
 */
export const CreatePayoutBodySchema = z.object({
  /** Minimum ₹500 (= MIN_PAYOUT_PAISE). */
  amountPaise: PaiseSchema.min(MIN_PAYOUT_PAISE),
  upiOrAcct: z.string().trim().min(3).max(100),
  method: z.enum(["UPI", "BANK"]).default("UPI"),
});
export type CreatePayoutBody = z.infer<typeof CreatePayoutBodySchema>;
export const CreatePayoutResponseSchema = envelope(PayoutSchema);

/** GET /v1/driver/payouts */
export const PayoutListQuerySchema = CursorQuerySchema.extend({
  status: PayoutStatusSchema.optional(),
});
export type PayoutListQuery = z.infer<typeof PayoutListQuerySchema>;
export const ListPayoutsResponseSchema = paginatedEnvelope(PayoutSchema);
