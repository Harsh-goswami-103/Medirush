import type { MetadataRoute } from "next";

/** PWA manifest (§20 — installable, standalone, brand theme). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MedRush",
    short_name: "MedRush",
    description: "Medicines & health essentials delivered in 40 minutes.",
    start_url: "/",
    display: "standalone",
    background_color: "#F8FAFC",
    theme_color: "#0D9488",
    orientation: "portrait",
    // Generated brand icons (teal + white cross): `any` for launchers/tabs,
    // `maskable` full-bleed variants keep the glyph inside the safe zone.
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
