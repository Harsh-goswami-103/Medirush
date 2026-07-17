import type { Config } from "tailwindcss";
import preset from "@medrush/config/tailwind/preset.js";

/**
 * Ops/Admin Tailwind config. Design tokens (pharmacy teal, ink, surface, radii,
 * shadows) come from the shared preset (BLUEPRINT §20.2); this file only adds
 * the content globs for JIT class scanning.
 */
export default {
  presets: [preset],
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Web-only override: point the preset's Inter/Noto stack at the
        // next/font self-hosted variables set on <html> in layout.tsx.
        sans: [
          "var(--font-inter)",
          "var(--font-noto-devanagari)",
          "system-ui",
          "sans-serif",
        ],
      },
    },
  },
} satisfies Config;
