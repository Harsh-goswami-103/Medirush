/**
 * Opaque client-generated id for the `Idempotency-Key` header (POST
 * /driver/payouts). Not security-sensitive — it only needs to be unique per
 * distinct request so a retry/duplicate submit collapses to one payout.
 */
export function makeIdempotencyKey(): string {
  return `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
