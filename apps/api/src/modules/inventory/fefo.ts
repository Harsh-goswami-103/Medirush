import { FEFO_MIN_SHELF_LIFE_DAYS } from "@medrush/contracts";

/**
 * FEFO (first-expiry-first-out) allocation proposal — BLUEPRINT §9.4.
 *
 * Pure: no I/O, no clock reads — `today` is injected so tests are hermetic.
 * Batches whose expiry is NOT strictly beyond `today + FEFO_MIN_SHELF_LIFE_DAYS`
 * (30d) are excluded: they belong to the near-expiry report / EXPIRY write-off,
 * never in a customer order. Ordering is deterministic: expiry ASC, then id ASC.
 */

export interface FefoBatchInput {
  id: string;
  qtyAvailable: number;
  expiryDate: Date;
}

export interface FefoAllocation {
  batchId: string;
  qty: number;
}

export interface FefoProposal {
  allocations: FefoAllocation[];
  /** Units that eligible batches could not cover (0 = fully satisfiable). */
  shortfall: number;
}

export function proposeFefo(
  requiredQty: number,
  batches: FefoBatchInput[],
  today: Date,
): FefoProposal {
  const cutoff = new Date(today.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() + FEFO_MIN_SHELF_LIFE_DAYS);
  const cutoffMs = cutoff.getTime();

  const eligible = [...batches]
    .filter((batch) => batch.qtyAvailable > 0 && batch.expiryDate.getTime() > cutoffMs)
    .sort(
      (a, b) =>
        a.expiryDate.getTime() - b.expiryDate.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const allocations: FefoAllocation[] = [];
  let remaining = Math.max(0, requiredQty);
  for (const batch of eligible) {
    if (remaining === 0) break;
    const qty = Math.min(batch.qtyAvailable, remaining);
    allocations.push({ batchId: batch.id, qty });
    remaining -= qty;
  }

  return { allocations, shortfall: remaining };
}
