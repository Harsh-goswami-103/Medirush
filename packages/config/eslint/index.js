// @medrush/config/eslint — shared ESLint 9 flat-config preset for all MedRush packages.
// Phase 0 policy (phase-0-conventions.md "Style"): typescript-eslint recommended only,
// NO type-aware rules yet; `no-console` is an error in source (use the pino logger),
// tests are exempt. Import from consumers as:
//   import medrush from "@medrush/config/eslint/index.js";
//   export default medrush;
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Shared ignores — build output, deps, turbo cache, coverage.
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/coverage/**"],
  },

  // Base recommended sets.
  js.configs.recommended,
  tseslint.configs.recommended,

  // Disable stylistic rules that conflict with Prettier (must come after the rule sets).
  prettier,

  // House rules.
  {
    rules: {
      // BLUEPRINT §21 / Phase 0 conventions: no console.log in package source — use pino.
      "no-console": "error",
    },
  },

  // Test files may use console (debug output in vitest runs is fine).
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
    ],
    rules: {
      "no-console": "off",
    },
  },
);
