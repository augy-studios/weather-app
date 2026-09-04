const CACHE = "weather-v5";

const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/js/theme.js",
  "/js/icons.js",
  "/js/ui.js",
  "/js/sync.js",
  "/manifest.json",
  "/favicon.ico",
  "/weathericon3.png",
  "/weather-192.png",
  "/weather-512.png",
  "/images/screenshot_1.png",
  "/images/screenshot_2.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Weather responses are still worth caching, sync ones never are: a cached
  // reply would show a stale list of saved places, and a POST cannot be stored
  // at all. Both go straight to the network.
  const url = new URL(event.request.url);
  const isSync = url.pathname.startsWith("/api/link")
    || url.pathname.startsWith("/api/favourites")
    || url.pathname.startsWith("/api/auth/");
  if (event.request.method !== "GET" || isSync) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
