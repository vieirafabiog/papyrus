/**
 * Security-first Service Worker for papyrus PWA.
 *
 * Security invariant:
 * - NEVER cache `/api/*`, authenticated responses, documents, previews, or signed URLs.
 * - ONLY cache same-origin static app-shell assets (`/assets/*`, `/icons/*`, `/favicon.svg`,
 *   `/manifest.webmanifest`, `/offline.html`).
 * - Navigation requests use network-first with branded `/offline.html` fallback.
 */
const SHELL_CACHE_NAME = "papyrus-shell-v1";
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

function isCacheableStaticPath(pathname) {
  return (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/favicon.svg" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/offline.html"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== SHELL_CACHE_NAME).map((oldKey) => caches.delete(oldKey)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Strictly bypass all API and health requests: never cache authorized data or files.
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
    return;
  }

  // Navigation requests: network-first, falling back to the branded offline screen.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cachedOffline = await caches.match("/offline.html");
        return (
          cachedOffline ??
          new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }),
    );
    return;
  }

  // Static app-shell assets only: cache-first with safe network backfill.
  if (!isCacheableStaticPath(url.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(request).then((networkResponse) => {
        if (networkResponse.ok && networkResponse.type === "basic") {
          const clone = networkResponse.clone();
          void caches.open(SHELL_CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      });
    }),
  );
});
