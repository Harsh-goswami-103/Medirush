/**
 * MedRush service worker — minimal offline support (§20 PWA polish).
 *
 * Scope, deliberately narrow:
 *  - Precache ONLY the self-contained /offline.html fallback (a static file in
 *    public/ — inline styles, no JS, no hashed Next assets to go missing) and
 *    the manifest icon set.
 *  - Navigations go network-first; when the network fails, serve /offline.html.
 *  - NEVER caches /v1/ API requests, anything carrying an Authorization
 *    header, non-GET requests, or cross-origin requests (the API lives on
 *    another origin anyway). Medical/order data must never sit in CacheStorage.
 */

// CONVENTION: bump CACHE_VERSION whenever offline.html or the icon set changes.
// This file's bytes don't otherwise change on deploy, so installed clients keep
// serving the previously precached copies until the version string moves —
// acceptable staleness for a fully static fallback, but every content change
// MUST come with a bump (the activate handler then drops the older caches).
const CACHE_VERSION = "medrush-static-v2";
const PRECACHE_URLS = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // GET only, same-origin only, never API traffic, never authorized requests.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/")) return;
  if (request.headers.has("authorization")) return;

  // Navigations: network-first with the precached /offline.html fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/offline.html").then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  // Static requests: serve precached entries (icons); everything else goes to
  // the network untouched — nothing new is ever added to the cache at runtime.
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
