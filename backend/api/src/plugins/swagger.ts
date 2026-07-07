import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import type { FastifyPluginAsync } from "fastify";
import { getConfig } from "../core/config";
import { asGlobalPlugin } from "../core/plugin-utils";

/** OpenAPI docs at /docs — never mounted in production (§7.1). */
export const swaggerPlugin: FastifyPluginAsync = asGlobalPlugin(async (app) => {
  const config = getConfig();
  if (config.isProduction) return;

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "MedRush API",
        description:
          "Medicine delivery platform API. Envelope: success `{ data, meta? }`, " +
          "error `{ error: { code, message, details? } }`.",
        version: "0.1.0",
      },
      servers: [{ url: `http://localhost:${config.PORT}` }],
      tags: [{ name: "system", description: "Health & readiness" }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: "/docs" });
});
