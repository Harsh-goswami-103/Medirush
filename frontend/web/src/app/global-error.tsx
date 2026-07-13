"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { whatsappUrl } from "@/lib/env";

/**
 * Root error boundary — replaces the ROOT LAYOUT when it (or the template)
 * throws, so it must render its own <html>/<body> and cannot rely on
 * globals.css/Tailwind being loaded: everything is inline-styled with the
 * MedRush tokens (§20.2 — teal #0D9488, ink #0F172A/#475569, surface-2 #F8FAFC).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  // null when NEXT_PUBLIC_SUPPORT_PHONE is unset — the CTA is hidden then.
  const supportUrl = whatsappUrl("Hi, something went wrong in the MedRush app.");

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8FAFC",
          fontFamily: "Inter, 'Noto Sans Devanagari', system-ui, sans-serif",
          color: "#0F172A",
        }}
      >
        <div style={{ maxWidth: 320, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 32, margin: 0 }} aria-hidden>
            ⚕️
          </p>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "12px 0 4px" }}>
            MedRush hit a snag
          </h1>
          <p style={{ fontSize: 14, color: "#475569", margin: "0 0 16px", lineHeight: 1.5 }}>
            Something went wrong loading the app. Your orders and cart are safe — please try
            again.
          </p>
          <button
            onClick={reset}
            style={{
              width: "100%",
              padding: "10px 14px",
              fontSize: 14,
              fontWeight: 500,
              color: "#FFFFFF",
              background: "#0D9488",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {supportUrl && (
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                marginTop: 10,
                padding: "10px 14px",
                fontSize: 14,
                fontWeight: 500,
                color: "#16A34A",
                border: "1px solid rgba(22, 163, 74, 0.3)",
                borderRadius: 8,
                textDecoration: "none",
              }}
            >
              Chat with support on WhatsApp
            </a>
          )}
          {error.digest && (
            <p style={{ marginTop: 12, fontSize: 12, color: "#94A3B8" }}>
              Support code: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
