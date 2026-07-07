/**
 * Human order number: `MR-<yymmdd>-<seq padded to 4>` (e.g. MR-250705-0042).
 * The date portion is the IST calendar date; `seq` is `Order.seq`
 * (autoincrement), read back inside the create TX (phase-1 brief).
 */

/** IST is UTC+05:30 — fixed offset, no DST. */
const IST_OFFSET_MINUTES = 330;

export function makeOrderNo(seq: number, date: Date = new Date()): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  const yy = String(ist.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  return `MR-${yy}${mm}${dd}-${String(seq).padStart(4, "0")}`;
}
