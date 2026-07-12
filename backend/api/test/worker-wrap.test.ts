import { describe, expect, it, vi } from "vitest";

/**
 * wrapWorker (§24): pg-boss v10's `error` event only covers INTERNAL errors —
 * a throwing handler is retried then silently parked in the failed state. The
 * wrapper must make the failure loud (log + Sentry capture with a queue tag)
 * and then RETHROW so pg-boss retry semantics stay intact.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  close: vi.fn().mockResolvedValue(true),
}));

const Sentry = await import("@sentry/node");
const { wrapWorker } = await import("../src/core/jobs");
const { logger } = await import("../src/core/logger");

describe("wrapWorker", () => {
  it("passes jobs through and stays silent on success", async () => {
    const seen: string[] = [];
    const wrapped = wrapWorker<{ orderId: string }>("ok-queue", async (jobs) => {
      for (const job of jobs) seen.push(job.data.orderId);
    });

    await wrapped([{ id: "j1", name: "ok-queue", data: { orderId: "o1" } } as never]);
    expect(seen).toEqual(["o1"]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("logs + Sentry-captures (queue tag) + rethrows on failure", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    const boom = new Error("handler exploded");
    const wrapped = wrapWorker("doomed-queue", async () => {
      throw boom;
    });

    await expect(wrapped([])).rejects.toThrow("handler exploded");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, queue: "doomed-queue" }),
      "job handler failed",
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, {
      tags: { queue: "doomed-queue" },
    });
    errorSpy.mockRestore();
  });
});
