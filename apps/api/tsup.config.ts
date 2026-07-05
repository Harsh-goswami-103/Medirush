import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
  clean: true,
  // App bundle, not a library — no .d.ts output. Dependencies stay external (tsup default).
  dts: false,
});
