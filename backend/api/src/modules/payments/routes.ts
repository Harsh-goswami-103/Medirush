import type { FastifyPluginAsync } from "fastify";
import { processWebhook } from "./webhook";

/**
 * Payment webhook endpoint (BLUEPRINT §7.2, §9.3; phase-2 brief §2):
 * - POST /v1/webhooks/razorpay — PUBLIC (signature-gated, not token-auth) and
 *   RATE-LIMIT-EXEMPT (Razorpay must always reach it, and retries on non-2xx).
 *
 * The HMAC signature is computed over the EXACT bytes Razorpay sent, so this
 * plugin installs a SCOPED content-type parser that keeps the JSON body as a raw
 * string (never `JSON.parse`d before verification). Encapsulation keeps this
 * parser off every other /v1 route — they still get normal object bodies.
 */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  // Scoped to this plugin only: preserve the raw request body for HMAC checking.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    "/webhooks/razorpay",
    {
      // `public` bypasses the auth hook; `rateLimit: false` exempts the global limiter.
      config: { public: true, rateLimit: false },
      schema: {
        tags: ["payments"],
        summary: "Razorpay webhook (public, HMAC-signature-gated, raw body)",
      },
    },
    async (request, reply) => {
      const signature = request.headers["x-razorpay-signature"];
      const eventId = request.headers["x-razorpay-event-id"];
      const raw = typeof request.body === "string" ? request.body : "";

      const result = await processWebhook(
        raw,
        typeof signature === "string" ? signature : "",
        typeof eventId === "string" ? eventId : undefined,
      );

      // Always 200 on a handled (or duplicate/ignored) event — non-2xx triggers
      // Razorpay retries. Signature/JSON failures throw AppError (401/400).
      reply.code(200);
      return result;
    },
  );
};
