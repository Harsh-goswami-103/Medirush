import Fastify, { type FastifyBaseLogger } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { getConfig } from "./core/config";
import { logger } from "./core/logger";
import { AppError, errorHandler, notFoundHandler } from "./core/errors";
import { appVersionPlugin } from "./plugins/appVersion";
import { authPlugin } from "./plugins/auth";
import { genReqId, requestIdPlugin } from "./plugins/requestId";
import { swaggerPlugin } from "./plugins/swagger";
import { healthRoutes } from "./modules/health/routes";
import { v1Routes } from "./modules/v1";

/** Build the Fastify app (no listen, no side effects — inject()-able in tests). */
export async function buildApp() {
  const config = getConfig();

  const app = Fastify({
    // pino Logger and FastifyBaseLogger are structurally compatible; the cast
    // bridges their nominal type mismatch (pino v9 generics vs fastify v5).
    loggerInstance: logger as FastifyBaseLogger,
    genReqId,
    trustProxy: true,
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
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: 60_000, // 100 req/min per client
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
