"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui";

/**
 * Route-segment error boundary (P2 hardening): report the render error to
 * Sentry (a config-selected no-op without a DSN) and offer a branded retry —
 * `reset()` re-renders the failed segment. Rendered inside the root layout,
 * so globals.css and the design tokens apply.
 */
export default function RouteError({
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
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <p className="text-base font-semibold text-primary-700">
          MedRush <span className="font-normal text-ink-400">Ops</span>
        </p>
        <h1 className="mt-2 text-xl font-semibold text-ink-900">Something went wrong</h1>
        <p className="mt-1 text-sm text-ink-600">
          The error has been reported. Try again, or reload the tab if it keeps happening.
        </p>
        {error.digest && <p className="mt-1 text-xs text-ink-400">Ref: {error.digest}</p>}
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
