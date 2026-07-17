"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrderSummary } from "@medrush/contracts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui";

/** Chromium's install event — not in lib.dom yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "medrush.web.installPromptDismissed";

/**
 * PWA install banner (§20.5 — "install prompt after first delivered order").
 * Renders only when ALL hold: the browser fired `beforeinstallprompt` (i.e.
 * installable and not yet installed), we're not already running standalone,
 * the customer has ≥1 DELIVERED order (a proven, happy user), and they haven't
 * dismissed the banner before. Safari never fires the event → renders nothing.
 */
export function InstallPrompt() {
  const { user } = useAuth();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until read

  useEffect(() => {
    setDismissed(
      window.localStorage.getItem(DISMISS_KEY) === "1" ||
        window.matchMedia("(display-mode: standalone)").matches,
    );
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  // Cheapest possible "has a delivered order" probe; only runs once the
  // browser has actually offered installability and the user is signed in.
  const deliveredQuery = useQuery({
    queryKey: ["orders", "DELIVERED", "install-probe"],
    queryFn: () => api.get<OrderSummary[]>("/v1/orders?status=DELIVERED&limit=1"),
    enabled: Boolean(user) && deferred !== null && !dismissed,
    staleTime: 5 * 60_000,
  });
  const hasDelivered = (deliveredQuery.data?.data.length ?? 0) > 0;

  if (!deferred || dismissed || !hasDelivered) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage blocked — banner just reappears next session.
    }
  }

  async function install() {
    const evt = deferred;
    if (!evt) return;
    setDeferred(null);
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    if (outcome === "dismissed") dismiss();
  }

  return (
    <div className="fixed bottom-20 left-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-card border border-primary-600/20 bg-surface p-3 shadow-lg">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-900">Install MedRush</p>
          <p className="text-xs text-ink-600">One tap from your home screen next time.</p>
        </div>
        <Button onClick={() => void install()}>Install</Button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="p-1 text-ink-400"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
