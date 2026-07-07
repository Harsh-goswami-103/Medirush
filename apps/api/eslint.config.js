import medrush from "@medrush/config/eslint/index.js";

/** Flat ESLint config — preset from @medrush/config, plus api-specific rules. */
export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  ...(Array.isArray(medrush) ? medrush : [medrush]),
  {
    // No console in api src — use the pino logger. Tests, seed and configs are exempt.
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Seed and other prisma CLI scripts talk to a human terminal — console is the right tool.
    files: ["prisma/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Dev/verification scripts (golden-path driver, etc.): console is the output
    // channel and untyped fetch/JSON bodies make `any` pragmatic.
    files: ["scripts/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
