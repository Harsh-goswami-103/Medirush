/**
 * Driver-app design tokens (BLUEPRINT §20 — DARK, high-contrast, sunlight-
 * readable, big touch targets for on-the-road one-handed use). Brand hues match
 * `packages/config/tailwind/preset.js` (teal primary) but on a dark surface.
 *
 * React Native has no Tailwind, so these are plain constants consumed by
 * StyleSheet. Keep them the single source — do not inline hex in screens.
 */

export const colors = {
  /** App background — near-black navy for OLED contrast. */
  bg: "#0B1220",
  /** Raised surface (cards, sheets). */
  surface: "#111C2E",
  /** Higher surface (pressed/active rows, inputs). */
  surfaceAlt: "#1A2740",
  /** Hairline borders on the dark surface. */
  border: "#25324B",

  /** Brand teal. */
  primary: "#14B8A6",
  primaryPressed: "#0D9488",
  onPrimary: "#04121A",

  /** Text. */
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textFaint: "#64748B",

  /** Semantic. */
  success: "#22C55E",
  successBg: "#0E2A1B",
  danger: "#F87171",
  dangerPressed: "#DC2626",
  dangerBg: "#2A1416",
  warning: "#FBBF24",
  warningBg: "#2A2411",
  info: "#38BDF8",

  /** COD cash highlight. */
  cash: "#FCD34D",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const font = {
  /** Body. */
  base: 16,
  sm: 14,
  xs: 12,
  lg: 18,
  xl: 22,
  xxl: 28,
  /** Hero numbers (commission, cash, countdown). */
  display: 40,
} as const;

/** Minimum touch target — mega-buttons for gloved/one-handed taps (§20). */
export const HIT_HEIGHT = 56;
