// Bump on every deploy that changes anything this worker serves. The browser
// compares this file byte for byte, so an unchanged VERSION means no update
// reaches anybody and the update bar never appears.
const VERSION = "v13";
const CACHE = `weather-${VERSION}`;

// Kept across versions, so an update doesn't throw away what makes the site
// work offline: the last weather, the radar frames, and the map tiles already
// looked at.
const DATA_CACHE = "weather-data";
const RADAR_CACHE = "weather-radar";
const TILE_CACHE = "weather-tiles";
const KEEP = [CACHE, DATA_CACHE, RADAR_CACHE, TILE_CACHE];

// About 15 MB of tiles at most, and three hours of radar with room to spare:
// NEA's frames at all three ranges, the DWD's, and the tiled radars' tiles for
// a view or two. The oldest go first.
const MAX_TILES = 800;
const MAX_FRAMES = 600;
// How long the weather may take before the last saved copy is shown instead.
const NETWORK_TIMEOUT_MS = 6000;

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
  "/js/wx.js",
  "/js/sync.js",
  "/js/charts.js",
  "/js/map.js",
  "/js/alerts.js",
  "/js/update.js",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/vendor/chartjs/chart.umd.min.js",
  "/manifest.json",
  "/favicon.ico",
  "/weathericon3.png",
  "/weather-192.png",
  "/weather-512.png",
];
const SHELL = new Set(ASSETS);

// The weather, answered from the network first and from the last copy offline.
const DATA_PATHS = ["/api/forecast", "/api/air", "/api/sg", "/api/timeline", "/api/gauges", "/api/geocode"];

// Cached on first use: the Jua font, and html2canvas for the share image.
const STATIC_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

const isTile = (url) => url.hostname === "tile.openstreetmap.org";
// A single radar frame never changes. The frame list does, every five minutes.
const isFrame = (url) => url.pathname === "/api/radar" && url.searchParams.has("at");
// Canada's GeoMet radar: one WMS tile per frame time, so it never changes either.
const isGeoMet = (url) => url.hostname === "geo.weather.gc.ca" && url.searchParams.has("TIME");

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
      const stale = keys.filter((key) => !KEEP.includes(key));
      await Promise.all(stale.map((key) => caches.delete(key)));

      // First install only: no earlier version's shell, so there is nothing on
      // screen to protect. Claiming lets the very first visit fill the runtime
      // caches, which is what makes a second visit work offline. An update never
      // gets here with a page to claim: it only activates through the
      // skip-waiting message below, or once every page using the old version
      // has closed.
      const earlier = keys.some((key) => key.startsWith("weather-v") && key !== CACHE);
      if (!earlier) await self.clients.claim();
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

/* -- Lightning alerts, sent by the collect cron (api/cron/collect.js) -- */

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data?.json();
  } catch {}
  if (data?.type !== "lightning-alert") return;

  // One tag, so a newer warning replaces the last rather than stacking;
  // renotify still makes it heard.
  event.waitUntil(
    self.registration.showNotification(data.title || "Lightning nearby", {
      body: data.body || "",
      tag: "lightning-alert",
      renotify: true,
      icon: "/weather-192.png",
      badge: "/weatherapp-badge.png",
      data: { url: data.url || "/#map" },
    })
  );
});

// Tapping one opens the map: in the open window if there is one, otherwise a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/#map", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (!client) return self.clients.openWindow(url);
      return client.focus().then((c) => c.navigate?.(url) ?? c);
    })
  );
});

/* -- Fetch -- */

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (STATIC_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(request, CACHE));
    else if (isTile(url)) event.respondWith(capped(event, request, TILE_CACHE, MAX_TILES));
    else if (isGeoMet(url)) event.respondWith(capped(event, request, RADAR_CACHE, MAX_FRAMES));
    // RainViewer, analytics and ads go straight to the network, untouched.
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (isFrame(url)) event.respondWith(capped(event, request, RADAR_CACHE, MAX_FRAMES));
    else if (DATA_PATHS.includes(url.pathname) || url.pathname === "/api/radar") event.respondWith(networkFirst(event, request));
    // Sync, alerts sign-up and the cron talk to the server and nothing else.
    return;
  }

  // The app shell from this version's cache, including "/?q=Tokyo" from the
  // manifest's shortcuts. Offline navigations to anything uncached get the app.
  if (request.mode === "navigate" || SHELL.has(url.pathname)) {
    event.respondWith(shell(request, url));
    return;
  }

  event.respondWith(cacheFirst(request, CACHE));
});

async function shell(request, url) {
  const cache = await caches.open(CACHE);
  const key = request.mode === "navigate" ? "/" : url.pathname;
  const cached = await cache.match(key, { ignoreSearch: true });
  if (cached) return cached;
  return fetch(request);
}

async function cacheFirst(request, name) {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// The network, unless it is slow or gone: then the last copy. The page says
// how old that is from the readings' own timestamps. The fetch carries on in
// the background either way, so the copy stays fresh.
async function networkFirst(event, request) {
  const cache = await caches.open(DATA_CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // Offline: fall through to the copy.
  }
  const cached = await cache.match(request);
  if (cached) return cached;
  return network;
}

// Tiles and frames: whatever is cached, else the network, kept for next time.
// Each cache is trimmed now and then rather than on every put.
const puts = {};

async function capped(event, request, name, max) {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Same-origin or CORS only: an opaque response is padded to megabytes of quota.
  if (response.ok && (response.type === "basic" || response.type === "cors")) {
    event.waitUntil(cache.put(request, response.clone()).then(() => {
      puts[name] = (puts[name] || 0) + 1;
      return puts[name] % 50 === 0 ? trim(cache, max) : null;
    }));
  }
  return response;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  const extra = keys.length - max;
  if (extra > 0) await Promise.all(keys.slice(0, extra).map((k) => cache.delete(k)));
}
