// Bump on every deploy that changes anything this worker serves. The browser
// compares this file byte for byte, so an unchanged VERSION means no update
// reaches anybody and the update bar never appears.
const VERSION = "v6";
const CACHE = `weather-${VERSION}`;

// The app shell. Served only from this version's own cache, so a page never
// mixes files from two deploys; the next version's shell arrives with the next
// worker, which waits until somebody presses Reload in the update bar.
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/script.js",
  "/js/theme.js",
  "/js/icons.js",
  "/js/ui.js",
  "/js/sync.js",
  "/js/update.js",
  "/manifest.json",
  "/favicon.ico",
  "/weathericon3.png",
  "/weather-192.png",
  "/weather-512.png",
  "/images/screenshot_1.png",
  "/images/screenshot_2.png"
];
const SHELL = new Set(ASSETS);

self.addEventListener("install", (event) => {
  // No skipWaiting here. A new version downloads, installs, and then waits.
  // `cache: "reload"` so the precache comes from the server, not from an HTTP
  // cache entry left over from the version being replaced.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      const stale = keys.filter((key) => key !== CACHE);
      await Promise.all(stale.map((key) => caches.delete(key)));

      // First install only: no earlier version's cache, so there is nothing on
      // screen to protect. Claiming lets the very first visit fill the runtime
      // cache (forecast, chart library, fonts), which is what makes a second
      // visit work offline. An update never gets here with a page to claim: it
      // only activates through the skip-waiting message below, or once every
      // page using the old version has closed.
      if (stale.length === 0) await self.clients.claim();
    })
  );
});

self.addEventListener("message", (event) => {
  const type = typeof event.data === "string" ? event.data : event.data?.type;

  // The only place skipWaiting is ever called: somebody pressed Reload.
  if (type === "skip-waiting") {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
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

  // Shell files, including "/?q=Tokyo" from the manifest shortcuts: this
  // version's copy, never rewritten in place.
  if (url.origin === self.location.origin && SHELL.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE)
        .then((cache) => cache.match(event.request, { ignoreSearch: true }))
        .then((cached) => cached || fetch(event.request))
    );
    return;
  }

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
