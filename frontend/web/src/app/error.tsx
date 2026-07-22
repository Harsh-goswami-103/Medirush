"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { whatsappUrl } from "@/lib/env";
import { Button, WhatsAppIcon } from "@/components/ui";

/**
 * Route-segment error boundary (App Router): catches render/runtime errors in
 * any page, reports them to Sentry, and offers a retry via `reset()` instead of
 * a white screen. Renders inside the root layout, so the shell/theme survive.
 */
export default function ErrorPage({
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
    <div className="bg-mesh flex min-h-[70dvh] items-center justify-center px-5 py-10">
      <div className="glass w-full max-w-sm animate-reveal-up rounded-sheet2 p-7 text-center shadow-glass">
        <div
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl2 bg-gradient-to-br from-primary-600 to-primary-500 text-white shadow-glow"
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            className="h-8 w-8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l7.5 3v5.2c0 4.4-3 8.3-7.5 9.8-4.5-1.5-7.5-5.4-7.5-9.8V6L12 3z" />
            <path d="M12 8.5v4M12 15.8v.2" />
          </svg>
        </div>

        <h1 className="mt-5 text-2xl font-bold tracking-tight text-ink-900" role="alert">
          Something went wrong
        </h1>
        <p className="mx-auto mt-2 max-w-[36ch] text-[15px] leading-6 text-ink-600">
          Sorry about that — an unexpected error occurred. Your orders and cart are safe.
        </p>

        <div className="mt-6 space-y-2.5">
          <Button
            className="press h-12 w-full rounded-card bg-gradient-to-r from-primary-600 to-primary-500 text-[15px] font-semibold shadow-glow"
            onClick={reset}
          >
            Try again
          </Button>
          <Link
            href="/shop"
            className="press flex h-12 w-full items-center justify-center rounded-card border border-line bg-surface text-[15px] font-semibold text-ink-900 transition-colors hover:bg-surface-2"
          >
            Back to the shop
          </Link>
          {supportUrl && (
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="press flex h-12 w-full items-center justify-center gap-2 rounded-card border border-success/30 bg-success/5 text-[15px] font-semibold text-success transition-colors hover:bg-success/10"
            >
              <WhatsAppIcon />
              Chat with support
            </a>
          )}
        </div>

        {error.digest && (
          <p className="mt-4 text-xs text-ink-400">
            Support code: <span className="font-mono tabular-nums">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  );
}
