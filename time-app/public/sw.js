// Minimal service worker: enables install + a network-first fetch so the app
// works as an installed PWA. Avoids caching authenticated pages aggressively.
const CACHE = "withers-time-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Network-first; fall back to cache for static assets only.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/icon") || url.pathname === "/manifest.webmanifest") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
