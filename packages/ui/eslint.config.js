// Shared MedRush flat-config preset. Full file path (not bare "@medrush/config/eslint")
// because @medrush/config has no exports field and Node ESM does not resolve directory imports.
import medrush from "@medrush/config/eslint/index.js";

export default medrush;
