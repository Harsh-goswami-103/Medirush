"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { whatsappUrl } from "@/lib/env";
import { Button, WhatsAppIcon } from "@/components/ui";

/**
 * Checkout-scoped error boundary: payment is the one flow where a crash makes
 * customers fear a double charge, so the copy addresses that directly and
 * points at the order history (where a created-but-unpaid order shows a
 * "Complete payment" action).
 */
export default function CheckoutError({
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
  const supportUrl = whatsappUrl("Hi, I hit an error during checkout on MedRush.");

  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold text-ink-900">Checkout hit a snag</h1>
      <p className="max-w-xs text-sm text-ink-600">
        Something went wrong during checkout. If you had already started a payment, check{" "}
        <span className="font-medium text-ink-900">My orders</span> before paying again — the
        order may already be there.
      </p>
      <Button className="mt-2 w-full max-w-xs" onClick={reset}>
        Try again
      </Button>
      <Link href="/orders" className="w-full max-w-xs">
        <Button variant="secondary" className="w-full">
          View my orders
        </Button>
      </Link>
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
