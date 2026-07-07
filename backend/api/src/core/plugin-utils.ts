import type { FastifyPluginAsync } from "fastify";

/**
 * Mark a plugin as non-encapsulated so its decorators/hooks apply app-wide —
 * exactly what the `fastify-plugin` package does, without adding the
 * dependency (Phase 0 keeps the pinned dep list frozen).
 */
export function asGlobalPlugin<Options extends Record<string, unknown> = Record<never, never>>(
  plugin: FastifyPluginAsync<Options>,
): FastifyPluginAsync<Options> {
  (plugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
  return plugin;
}
