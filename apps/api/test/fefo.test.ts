import { describe, expect, it } from "vitest";
import { proposeFefo, type FefoBatchInput } from "../src/modules/inventory/fefo";

/**
 * Pure FEFO proposal unit tests (§9.4): expiry ASC (id ASC tiebreak), batches
 * expiring within 30 days excluded, shortfall reported, fully deterministic.
 */

const TODAY = new Date("2026-07-06T00:00:00.000Z");
const DAY_MS = 86_400_000;

const inDays = (days: number): Date => new Date(TODAY.getTime() + days * DAY_MS);

const batch = (id: string, qtyAvailable: number, expiryInDays: number): FefoBatchInput => ({
  id,
  qtyAvailable,
  expiryDate: inDays(expiryInDays),
});

describe("proposeFefo", () => {
  it("fills exactly from a single batch", () => {
    const result = proposeFefo(5, [batch("b1", 5, 90)], TODAY);
    expect(result).toEqual({ allocations: [{ batchId: "b1", qty: 5 }], shortfall: 0 });
  });

  it("takes only what is needed from the earliest-expiring batch", () => {
    const result = proposeFefo(3, [batch("b1", 10, 90)], TODAY);
    expect(result).toEqual({ allocations: [{ batchId: "b1", qty: 3 }], shortfall: 0 });
  });

  it("splits across batches in expiry-ascending order", () => {
    const result = proposeFefo(
      5,
      [batch("late", 20, 240), batch("early", 3, 60)], // deliberately unsorted input
      TODAY,
    );
    expect(result.allocations).toEqual([
      { batchId: "early", qty: 3 },
      { batchId: "late", qty: 2 },
    ]);
    expect(result.shortfall).toBe(0);
  });

  it("excludes batches expiring within 30 days (boundary: exactly +30d is excluded)", () => {
    const result = proposeFefo(
      4,
      [
        batch("expired", 50, -1),
        batch("near", 50, 10),
        batch("boundary", 50, 30), // NOT strictly beyond today+30d → excluded
        batch("eligible", 2, 31), // first eligible day
      ],
      TODAY,
    );
    expect(result.allocations).toEqual([{ batchId: "eligible", qty: 2 }]);
    expect(result.shortfall).toBe(2);
  });

  it("reports the shortfall when eligible stock cannot cover the demand", () => {
    const result = proposeFefo(10, [batch("b1", 4, 60), batch("b2", 2, 90)], TODAY);
    expect(result.allocations).toEqual([
      { batchId: "b1", qty: 4 },
      { batchId: "b2", qty: 2 },
    ]);
    expect(result.shortfall).toBe(4);
  });

  it("skips zero-quantity batches", () => {
    const result = proposeFefo(2, [batch("empty", 0, 60), batch("full", 5, 90)], TODAY);
    expect(result.allocations).toEqual([{ batchId: "full", qty: 2 }]);
  });

  it("is deterministic: equal expiries tie-break by id ASC, regardless of input order", () => {
    const forward = [batch("b1", 2, 60), batch("b2", 2, 60), batch("b3", 2, 60)];
    const reversed = [...forward].reverse();

    const a = proposeFefo(5, forward, TODAY);
    const b = proposeFefo(5, reversed, TODAY);

    expect(a).toEqual(b);
    expect(a.allocations).toEqual([
      { batchId: "b1", qty: 2 },
      { batchId: "b2", qty: 2 },
      { batchId: "b3", qty: 1 },
    ]);
  });

  it("does not mutate the input batch array", () => {
    const input = [batch("z", 5, 90), batch("a", 5, 60)];
    const snapshot = input.map((b) => b.id);
    proposeFefo(7, input, TODAY);
    expect(input.map((b) => b.id)).toEqual(snapshot);
  });

  it("returns empty allocations and zero shortfall for non-positive demand", () => {
    expect(proposeFefo(0, [batch("b1", 5, 90)], TODAY)).toEqual({
      allocations: [],
      shortfall: 0,
    });
    expect(proposeFefo(-3, [batch("b1", 5, 90)], TODAY)).toEqual({
      allocations: [],
      shortfall: 0,
    });
  });
});
