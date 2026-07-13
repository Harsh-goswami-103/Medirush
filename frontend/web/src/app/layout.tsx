import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";

export const metadata: Metadata = {
  title: "MedRush — 40-minute medicine delivery",
  description: "Medicines & health essentials delivered in 40 minutes.",
  manifest: "/manifest.webmanifest",
};

// No maximumScale: pinch-zoom must stay available (WCAG 1.4.4 — many customers
// are older users reading small dosage text).
export const viewport: Viewport = {
  themeColor: "#0D9488",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        {/* Offline service worker (public/sw.js) — registers in production only. */}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
