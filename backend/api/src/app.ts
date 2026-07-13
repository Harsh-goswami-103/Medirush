import Fastify, { type FastifyBaseLogger } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { RX_MAX_UPLOAD_BYTES } from "@medrush/contracts";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { getConfig, type Config } from "./core/config";
import { logger } from "./core/logger";
import { AppError, errorHandler, notFoundHandler } from "./core/errors";
import { appVersionPlugin } from "./plugins/appVersion";
import { authPlugin } from "./plugins/auth";
import { genReqId, requestIdPlugin } from "./plugins/requestId";
import { swaggerPlugin } from "./plugins/swagger";
import { healthRoutes } from "./modules/health/routes";
import { v1Routes } from "./modules/v1";

/**
 * Proxy trust (§10 hardening): trusting the entire X-Forwarded-For chain lets a
 * client prepend its own XFF entries and control `request.ip` (rate-limit
 * bypass + poisoned logs). With a hop count N, fastify only walks N trusted
 * hops back from the socket address — a client-crafted prefix is never reached.
 * Unset → 1 in production (Railway's single edge proxy), permissive `true` in
 * dev/test so inject()/localhost behaviour is unchanged.
 */
function trustProxyFor(config: Config): number | boolean {
  return config.TRUST_PROXY_HOPS ?? (config.isProduction ? 1 : true);
}

/**
 * Rate-limit client key: prefer Cloudflare's CF-Connecting-IP when the CF
 * perimeter is enabled (`RATE_LIMIT_TRUST_CF_HEADER` — CF strips/sets the
 * header, so it is only trustworthy behind CF), else the proxy-trust-derived
 * `request.ip`. Exported for the key-derivation tests.
 */
export function rateLimitKeyFor(
  request: { ip: string; headers: Record<string, unknown> },
  trustCfHeader: boolean,
): string {
  if (trustCfHeader) {
    const cf = request.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.length > 0) return cf;
  }
  return request.ip;
}

/** Build the Fastify app (no listen, no side effects — inject()-able in tests). */
export async function buildApp() {
  const config = getConfig();

  const app = Fastify({
    // pino Logger and FastifyBaseLogger are structurally compatible; the cast
    // bridges their nominal type mismatch (pino v9 generics vs fastify v5).
    loggerInstance: logger as FastifyBaseLogger,
    genReqId,
    trustProxy: trustProxyFor(config),
    // Backstop for hung clients/handlers (§10): Node would otherwise keep the
    // request open forever (fastify default 0). This bounds receiving the
    // ENTIRE request: a 5MB Rx upload on a weak Indian mobile uplink can
    // legitimately take minutes (30s would need ~1.4Mbps sustained), so give it
    // 120s. Slow-loris exposure stays bounded — multipart caps uploads at 5MB +
    // 1 file, and Node has no per-route override for this http option.
    // socket.io upgrades are unaffected — engine.io hijacks the connection on
    // the HTTP `upgrade` event, after which it is no longer an in-flight
    // request that Node's request timer tracks.
    requestTimeout: 120_000,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod validation + serialization everywhere (contracts schemas plug in Phase 1).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Envelope-shaped errors + 404s (§7.1).
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(helmet, {
    // Swagger UI needs inline scripts/styles in dev; full CSP applies in prod.
    contentSecurityPolicy: config.isProduction ? undefined : false,
  });

  const allowedOrigins = [config.WEB_ORIGIN, config.OPS_ORIGIN];
  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header → native apps (Expo driver), curl, server-to-server. Allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new AppError("FORBIDDEN", "Origin not allowed", 403), false);
    },
    credentials: true,
    // @fastify/cors v11 defaults Access-Control-Allow-Methods to GET,HEAD,POST —
    // which browser-blocks every cross-origin PUT/PATCH/DELETE (cart updates,
    // profile edits, ops mutations). Found by the e2e golden path.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    // Without this, cross-origin JS can only read the CORS-safelisted response
    // headers — the web apps' "Support code: <x-request-id>" toasts would
    // render empty in production.
    exposedHeaders: ["x-request-id"],
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: 60_000, // 100 req/min per client
    // Per-route configs (auth sync 20/min, webhook exempt) inherit this key.
    keyGenerator: (request) => rateLimitKeyFor(request, config.RATE_LIMIT_TRUST_CF_HEADER),
  });

  // Prescription uploads (§7.2): single file, hard-capped at 5MB; the route
  // magic-byte validates + re-encodes. Larger parts are rejected mid-stream.
  await app.register(multipart, {
    limits: { fileSize: RX_MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  });

  await app.register(requestIdPlugin);
  // Before auth: outdated driver apps get 426 (blocking update screen), not 401.
  await app.register(appVersionPlugin);
  await app.register(authPlugin);
  await app.register(swaggerPlugin);

  // System endpoints stay unprefixed; everything else lives under /v1.
  await app.register(healthRoutes);
  await app.register(v1Routes, { prefix: "/v1" });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
