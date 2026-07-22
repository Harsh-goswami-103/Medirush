import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Devanagari } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { Providers } from "./providers";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";

/**
 * §20.2 declares Inter + Noto Sans Devanagari, but nothing loaded them — the
 * app silently fell back to system fonts (and wasn't Devanagari-safe). Served
 * self-hosted via next/font (no external requests at runtime, zero CLS).
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-devanagari",
  display: "swap",
});

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

/**
 * Root layout owns only the document + providers. The mobile app shell lives in
 * the `(app)` route group so the `(marketing)` landing page can render
 * full-bleed and responsive without a bottom tab bar.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Locale comes from a cookie (src/i18n/request.ts), so `lang` is resolved per
  // request — screen readers and Devanagari shaping both depend on it being right.
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={`${inter.variable} ${notoDevanagari.variable}`}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
        {/* Offline service worker (public/sw.js) — registers in production only. */}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
