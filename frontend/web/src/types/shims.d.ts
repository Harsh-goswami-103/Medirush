/** The shared Tailwind preset is a plain ESM `.js` (no bundled types). */
declare module "@medrush/config/tailwind/preset.js" {
  import type { Config } from "tailwindcss";
  const preset: Partial<Config>;
  export default preset;
}
