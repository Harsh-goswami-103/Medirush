"use client";

import { useEffect } from "react";
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
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-4xl" aria-hidden>
        ⚕️
      </p>
      <h1 className="text-lg font-semibold text-ink-900">Something went wrong</h1>
      <p className="max-w-xs text-sm text-ink-600">
        Sorry about that — an unexpected error occurred. Your orders and cart are safe.
      </p>
      <Button className="mt-2 w-full max-w-xs" onClick={reset}>
        Try again
      </Button>
      {supportUrl && (
        <a
          href={supportUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-full max-w-xs items-center justify-center gap-2 rounded-input border border-success/30 bg-success/5 px-3.5 py-2 text-sm font-medium text-success hover:bg-success/10"
        >
          <WhatsAppIcon />
          Chat with support
        </a>
      )}
      {error.digest && <p className="mt-1 text-xs text-ink-400">Support code: {error.digest}</p>}
    </div>
  );
}
