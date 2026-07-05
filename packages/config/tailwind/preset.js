/**
 * @medrush/config/tailwind/preset.js
 *
 * Tailwind preset encoding the MedRush design tokens from docs/BLUEPRINT.md §20.2.
 * Consume via `presets: [medrushPreset]` in each app's tailwind.config.
 *
 * Token → spec mapping (BLUEPRINT §20.2):
 *   colors.primary.600/700   ← --primary-600 #0D9488 / --primary-700 #0F766E (pharmacy teal)
 *   colors.ink.900/600/400   ← --ink-900 #0F172A / --ink-600 #475569 / --ink-400 #94A3B8
 *   colors.surface / surface.2 ← --surface #FFFFFF / --surface-2 #F8FAFC
 *   colors.line              ← --line #E2E8F0
 *   colors.success/warning/danger/info ← #16A34A / #D97706 / #DC2626 / #2563EB
 *   colors.rx                ← --rx #7C3AED (Rx badge violet)
 *   colors.accent            ← --accent #F59E0B (offers / free-delivery)
 *   fontFamily.sans          ← Inter + "Noto Sans Devanagari" fallback (bilingual EN/HI)
 *   borderRadius             ← radius: 8 input · 12 card · 16 sheet · 999 pill
 *   boxShadow sm/md/lg       ← sm(0 1px 2px /.06) · md(0 4px 12px /.08) · lg(0 12px 32px /.12)
 *                              (shadow color = ink-900 #0F172A at the spec'd opacity)
 *
 * Not overridden here (spec matches Tailwind defaults / handled elsewhere):
 *   - space: 4pt scale (4 8 12 16 20 24 32 40 48 64) — Tailwind's default spacing scale covers it.
 *   - type scale fs-12…fs-30, weights 400–700, lh 1.5 body / 1.25 headings — Tailwind defaults.
 *   - motion: 150ms ease-out micro · 250ms cubic-bezier(.2,.8,.2,1) sheets · respect
 *     prefers-reduced-motion — applied per-component (Phase 3+, packages/ui).
 */

/** @type {import('tailwindcss').Config} */
const preset = {
  theme: {
    extend: {
      colors: {
        primary: {
          600: "#0D9488", // --primary-600 pharmacy teal
          700: "#0F766E", // --primary-700 hover/pressed
        },
        ink: {
          900: "#0F172A", // --ink-900 headings/body
          600: "#475569", // --ink-600 secondary text
          400: "#94A3B8", // --ink-400 placeholder/disabled
        },
        surface: {
          DEFAULT: "#FFFFFF", // --surface (bg-surface)
          2: "#F8FAFC", // --surface-2 (bg-surface-2)
        },
        line: "#E2E8F0", // --line borders/dividers
        success: "#16A34A", // --success
        warning: "#D97706", // --warning
        danger: "#DC2626", // --danger
        info: "#2563EB", // --info
        rx: "#7C3AED", // --rx Rx badge violet
        accent: "#F59E0B", // --accent offers/free-delivery
      },
      fontFamily: {
        // Inter first, Devanagari-safe fallback for Hindi strings (§20.1 bilingual-ready).
        sans: ["Inter", "Noto Sans Devanagari", "system-ui", "sans-serif"],
      },
      borderRadius: {
        input: "8px", // radius 8 → inputs
        card: "12px", // radius 12 → cards
        sheet: "16px", // radius 16 → bottom sheets/modals
        pill: "999px", // radius 999 → pills/chips
      },
      boxShadow: {
        sm: "0 1px 2px rgb(15 23 42 / 0.06)", // sm(0 1px 2px /.06)
        md: "0 4px 12px rgb(15 23 42 / 0.08)", // md(0 4px 12px /.08)
        lg: "0 12px 32px rgb(15 23 42 / 0.12)", // lg(0 12px 32px /.12)
      },
    },
  },
};

export default preset;
