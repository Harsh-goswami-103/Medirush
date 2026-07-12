import { afterAll, describe, expect, it, vi } from "vitest";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * Outbound-call deadlines (Phase 7 §10): a hung Razorpay call must 503 as
 * PAYMENT_UNAVAILABLE (retryable, envelope-shaped), and a hung firebase-admin
 * verifyIdToken must be a 503 outage — NEVER a 401 (a deadline is not an
 * invalid token). Plus the inbound bound: the server's requestTimeout must
 * leave a 5MB Rx upload on a weak mobile uplink enough time to arrive.
 * Pure unit tests: fakes only, no network, no DB.
 */

// Env must be set BEFORE src modules load (config/logger parse eagerly on import).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5433/medrush_test";
delete process.env.FIREBASE_PROJECT_ID;

const { AppError, errorHandler } = await import("../src/core/errors");
const { RazorpayTimeoutError, withRazorpayDeadline } = await import("../src/core/razorpay");
const { setFirebaseAuthForTests, verifyFirebaseToken } = await import("../src/core/firebase");

const NEVER = new Promise<never>(() => {});

afterAll(() => {
  setFirebaseAuthForTests(null);
});

/* ------------------------------------------------------ razorpay deadline */

describe("withRazorpayDeadline", () => {
  it("passes a fast result through untouched", async () => {
    await expect(withRazorpayDeadline(Promise.resolve("ok"), "order create", 50)).resolves.toBe(
      "ok",
    );
  });

  it("rejects with RazorpayTimeoutError when the SDK call hangs", async () => {
    await expect(withRazorpayDeadline(NEVER, "order create", 20)).rejects.toBeInstanceOf(
      RazorpayTimeoutError,
    );
  });

  it("propagates the SDK's own rejection unchanged (no mislabelled timeout)", async () => {
    const boom = new Error("BAD_REQUEST from gateway");
    await expect(withRazorpayDeadline(Promise.reject(boom), "refund", 50)).rejects.toBe(boom);
  });
});

describe("errorHandler maps RazorpayTimeoutError → 503 PAYMENT_UNAVAILABLE", () => {
  function fakeReply() {
    const reply = {
      code: vi.fn(),
      send: vi.fn(),
    };
    reply.code.mockReturnValue(reply);
    return reply;
  }

  const fakeRequest = {
    id: "req-1",
    method: "POST",
    url: "/v1/orders",
    log: { error: vi.fn() },
  } as unknown as FastifyRequest;

  it("keeps the §7.1 envelope shape with the typed code", () => {
    const reply = fakeReply();
    errorHandler(
      new RazorpayTimeoutError("order create") as unknown as FastifyError,
      fakeRequest,
      reply as unknown as FastifyReply,
    );
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: "PAYMENT_UNAVAILABLE",
        message: expect.stringContaining("Payment service"),
      },
    });
  });
});

/* ----------------------------------------------------- inbound requestTimeout */

describe("http requestTimeout leaves room for slow Rx uploads", () => {
  it("bounds the ENTIRE request at 120s — 30s would kill a 5MB upload on a weak uplink", async () => {
    const { buildApp } = await import("../src/app");
    const app = await buildApp();
    try {
      // Node's requestTimeout bounds receiving the whole request; multipart
      // already caps size (5MB, 1 file), so slow-loris exposure stays bounded.
      expect(app.server.requestTimeout).toBe(120_000);
    } finally {
      await app.close();
    }
  });
});

/* ------------------------------------------------------ firebase deadline */

describe("verifyFirebaseToken deadline semantics (503 outage ≠ 401 invalid token)", () => {
  it("times out as 503 (retryable outage), NOT 401", async () => {
    setFirebaseAuthForTests({ verifyIdToken: () => NEVER });
    const failure = await verifyFirebaseToken("some-token", 20).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as InstanceType<typeof AppError>).statusCode).toBe(503);
    expect((failure as InstanceType<typeof AppError>).code).not.toBe("UNAUTHENTICATED");
  });

  it("a genuinely rejected token stays 401 UNAUTHENTICATED", async () => {
    setFirebaseAuthForTests({
      verifyIdToken: () => Promise.reject(new Error("auth/id-token-expired")),
    });
    const failure = await verifyFirebaseToken("expired-token", 1_000).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as InstanceType<typeof AppError>).statusCode).toBe(401);
    expect((failure as InstanceType<typeof AppError>).code).toBe("UNAUTHENTICATED");
  });

  it("a token without a verified phone stays 401 (Phone-OTP is the only provider)", async () => {
    setFirebaseAuthForTests({
      verifyIdToken: () => Promise.resolve({ uid: "u1" }),
    });
    const failure = await verifyFirebaseToken("no-phone-token", 1_000).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as InstanceType<typeof AppError>).statusCode).toBe(401);
  });

  it("a valid decoded token resolves to { uid, phone }", async () => {
    setFirebaseAuthForTests({
      verifyIdToken: () => Promise.resolve({ uid: "u1", phone_number: "+919876543210" }),
    });
    await expect(verifyFirebaseToken("good-token", 1_000)).resolves.toEqual({
      uid: "u1",
      phone: "+919876543210",
    });
  });
});
