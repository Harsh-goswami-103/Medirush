import medrush from "../../packages/config/eslint/index.js";

/**
 * Flat ESLint config — shared MedRush preset, with React Native tweaks.
 *
 * The preset is imported by relative path (and the `lint` script runs the
 * eslint binary out of `packages/config/node_modules`) because this wave adds
 * no new dependencies to this package. When the lockfile next changes, switch
 * to proper `eslint` + `@medrush/config` devDependencies like web/ops.
 */
export default [
  {
    ignores: [
      "node_modules/**",
      ".expo/**",
      "android/**",
      "ios/**",
      "dist/**",
      "expo-env.d.ts",
      // Build tooling config (CJS with Node globals) — not app source.
      "app.config.js",
      "babel.config.js",
      "metro.config.js",
      "react-native.config.js",
    ],
  },
  ...(Array.isArray(medrush) ? medrush : [medrush]),
  {
    // React Native has no pino; console maps to the native log stream (and is
    // captured by Sentry breadcrumbs), so the backend no-console rule is off.
    rules: { "no-console": "off" },
  },
  {
    // eslint-plugin-react-hooks is not installed here (no new deps this wave),
    // but source carries `eslint-disable react-hooks/*` directives (e.g.
    // lib/useCountdown.ts). Stub the rules as no-ops so those directives don't
    // error as "rule not found"; replace with the real plugin when driver gets
    // proper eslint devDependencies.
    plugins: {
      "react-hooks": {
        rules: {
          "exhaustive-deps": { create: () => ({}) },
          "rules-of-hooks": { create: () => ({}) },
        },
      },
    },
  },
];
