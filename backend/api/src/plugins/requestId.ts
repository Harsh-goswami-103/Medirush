import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyServerOptions } from "fastify";
import { asGlobalPlugin } from "../core/plugin-utils";

/**
 * Request-id wiring: honour an inbound `x-request-id` (proxy-generated) or
 * mint a UUID, and echo it back on every response for log correlation.
 */

export const genReqId: NonNullable<FastifyServerOptions["genReqId"]> = (req) => {
  const header = req.headers["x-request-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 128) {
    return header;
  }
  return randomUUID();
};

export const requestIdPlugin: FastifyPluginAsync = asGlobalPlugin(async (app) => {
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });
});
