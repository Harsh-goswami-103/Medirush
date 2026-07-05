import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode } from "@medrush/contracts";

/**
 * Application error carrying a contract error code (§7.1 envelope).
 * Thrown anywhere; the global error handler serializes it.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorEnvelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** Fallback mapping for framework/plugin errors that carry an HTTP status. */
function codeForStatus(statusCode: number): ErrorCode {
  switch (statusCode) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return "INTERNAL";
  }
}

/**
 * Global error handler — every failure leaves the API as
 * `{ error: { code, message, details? } }` (§7.1).
 */
export function errorHandler(
  error: FastifyError | AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    void reply
      .code(error.statusCode)
      .send(errorEnvelope(error.code, error.message, error.details));
    return;
  }

  // Zod / Fastify schema validation failures → 400 VALIDATION_ERROR.
  if ("validation" in error && error.validation) {
    void reply
      .code(400)
      .send(errorEnvelope("VALIDATION_ERROR", "Request validation failed", error.validation));
    return;
  }

  const statusCode = error.statusCode ?? 500;
  if (statusCode < 500) {
    // Known client-side failures raised by plugins (rate limit, bad content-type, …).
    void reply.code(statusCode).send(errorEnvelope(codeForStatus(statusCode), error.message));
    return;
  }

  // Unknown → log with request context, never leak internals to the client.
  request.log.error({ err: error }, "unhandled error");
  void reply.code(500).send(errorEnvelope("INTERNAL", "Internal server error"));
}

/** 404 handler — unknown routes get the same envelope shape. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply
    .code(404)
    .send(errorEnvelope("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
}
