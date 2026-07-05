import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // /readyz probes an unreachable Postgres in tests — allow for connect timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
