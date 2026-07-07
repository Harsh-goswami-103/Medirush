import type { MetadataRoute } from "next";

/** PWA manifest (§20 — installable, standalone, brand theme). Icons land as a polish item. */
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
  };
}
