"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker (public/sw.js) — production only, so dev
 * never serves stale chunks from the SW cache. Registration failure is
 * non-fatal: the app simply runs without offline support.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* non-fatal */
    });
  }, []);
  return null;
}
