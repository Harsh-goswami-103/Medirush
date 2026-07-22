"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { whatsappUrl } from "@/lib/env";

/**
 * Root error boundary — replaces the ROOT LAYOUT when it (or the template)
 * throws, so it must render its own <html>/<body> and cannot rely on
 * globals.css/Tailwind being loaded: everything is inline-styled with the
 * MedRush tokens (§20.2 — teal #0D9488, ink #0F172A/#475569, surface-2 #F8FAFC),
 * including a hand-rolled copy of the `.bg-mesh` backdrop.
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

  const secondaryButton: React.CSSProperties = {
    display: "block",
    marginTop: 10,
    padding: "13px 16px",
    fontSize: 15,
    fontWeight: 600,
    borderRadius: 12,
    textDecoration: "none",
  };

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          backgroundColor: "#F8FAFC",
          backgroundImage:
            "radial-gradient(at 12% 0%, rgba(13,148,136,0.16) 0px, transparent 55%), radial-gradient(at 92% 8%, rgba(20,184,166,0.14) 0px, transparent 50%), radial-gradient(at 45% 100%, rgba(245,158,11,0.07) 0px, transparent 55%)",
          fontFamily: "Inter, 'Noto Sans Devanagari', system-ui, sans-serif",
          color: "#0F172A",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 360,
            padding: 28,
            textAlign: "center",
            background: "rgba(255,255,255,0.8)",
            border: "1px solid rgba(255,255,255,0.6)",
            borderRadius: 24,
            boxShadow: "0 8px 32px rgba(15,23,42,0.10)",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 64,
              height: 64,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 20,
              background: "linear-gradient(135deg, #0D9488, #14B8A6)",
              boxShadow: "0 8px 30px -6px rgba(13,148,136,0.35)",
              color: "#FFFFFF",
              fontSize: 30,
              lineHeight: 1,
            }}
          >
            ⚕️
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "20px 0 8px", letterSpacing: "-0.01em" }}>
            MedRush hit a snag
          </h1>
          <p style={{ fontSize: 15, color: "#475569", margin: "0 0 22px", lineHeight: 1.6 }}>
            Something went wrong loading the app. Your orders and cart are safe — please try again.
          </p>
          <button
            onClick={reset}
            style={{
              width: "100%",
              padding: "13px 16px",
              fontSize: 15,
              fontWeight: 600,
              color: "#FFFFFF",
              background: "linear-gradient(90deg, #0D9488, #14B8A6)",
              border: "none",
              borderRadius: 12,
              boxShadow: "0 8px 30px -6px rgba(13,148,136,0.35)",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a
            href="/shop"
            style={{
              ...secondaryButton,
              color: "#0F172A",
              background: "#FFFFFF",
              border: "1px solid #E2E8F0",
            }}
          >
            Back to the shop
          </a>
          {supportUrl && (
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...secondaryButton,
                color: "#15803D",
                background: "rgba(22,163,74,0.05)",
                border: "1px solid rgba(22, 163, 74, 0.3)",
              }}
            >
              Chat with support on WhatsApp
            </a>
          )}
          {error.digest && (
            <p style={{ marginTop: 16, fontSize: 12, color: "#64748B" }}>
              Support code: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
