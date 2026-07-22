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
      /**
       * "Premium Teal" — the customer app evolves the §20.2 palette with depth
       * rather than replacing it. Brand hues are unchanged; these are the tints,
       * shadows and motion the shared preset deliberately does not carry (ops
       * stays flat and dense).
       */
      colors: {
        primary: {
          50: "#F0FDFA",
          100: "#CCFBF1",
          200: "#99F6E4",
          500: "#14B8A6",
          800: "#115E59",
          900: "#134E4A",
        },
        mint: "#ECFDF5",
      },
      borderRadius: {
        xl2: "20px", // generous card rounding
        sheet2: "24px", // bottom sheets / hero cards
      },
      boxShadow: {
        glow: "0 8px 30px -6px rgb(13 148 136 / 0.35)", // teal-tinted CTA lift
        glass: "0 8px 32px rgb(15 23 42 / 0.10)",
        card2: "0 2px 8px rgb(15 23 42 / 0.06), 0 12px 28px -12px rgb(15 23 42 / 0.14)",
      },
      keyframes: {
        "gradient-pan": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        "reveal-up": {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        pop: {
          "0%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.12)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        "gradient-pan": "gradient-pan 12s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "reveal-up": "reveal-up 500ms cubic-bezier(.2,.8,.2,1) both",
        pop: "pop 300ms ease-out",
      },
    },
  },
} satisfies Config;
