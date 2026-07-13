import medrush from "@medrush/config/eslint/index.js";

/** Flat ESLint config — shared MedRush preset, with frontend-appropriate tweaks. */
export default [
  { ignores: ["dist/**", "node_modules/**", ".next/**", "next-env.d.ts"] },
  ...(Array.isArray(medrush) ? medrush : [medrush]),
  {
    // Client code may log to the browser console for error reporting.
    rules: { "no-console": "off" },
  },
  {
    // Hand-rolled service worker: ServiceWorkerGlobalScope globals, not a module.
    files: ["public/sw.js"],
    languageOptions: {
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
  },
];
