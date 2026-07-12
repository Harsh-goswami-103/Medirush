"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Last-resort error boundary: catches errors thrown by the ROOT layout itself,
 * so it must render its own <html>/<body> and cannot rely on globals.css —
 * everything is inline-styled with the §20.2 tokens (pharmacy teal / ink).
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

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8FAFC", // --surface-2
          color: "#0F172A", // --ink-900
          fontFamily: "Inter, 'Noto Sans Devanagari', system-ui, sans-serif",
          textAlign: "center",
          padding: "24px",
        }}
      >
        <div>
          <p style={{ margin: 0, fontWeight: 600, color: "#0F766E" }}>
            MedRush <span style={{ fontWeight: 400, color: "#94A3B8" }}>Ops</span>
          </p>
          <h1 style={{ margin: "8px 0 4px", fontSize: "20px", fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ margin: 0, fontSize: "14px", color: "#475569" }}>
            The error has been reported. Try again, or reload the tab if it keeps happening.
          </p>
          {error.digest && (
            <p style={{ margin: "6px 0 0", fontSize: "12px", color: "#94A3B8" }}>
              Ref: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: "16px",
              padding: "8px 14px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#FFFFFF",
              background: "#0D9488", // --primary-600
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
