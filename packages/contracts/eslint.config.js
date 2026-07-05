// Flat ESLint config — extends the shared @medrush/config preset (ESLint 9, typescript-eslint).
import medrush from "@medrush/config/eslint/index.js";

export default [{ ignores: ["dist/**", "coverage/**"] }, ...medrush];
