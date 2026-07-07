import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration tests (*.int.test.ts) share one Postgres database and truncate
    // tables between cases — files must not run concurrently.
    fileParallelism: false,
    // /readyz probes an unreachable Postgres in tests — allow for connect timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
