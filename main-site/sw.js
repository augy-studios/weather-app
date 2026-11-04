// Bump on every deploy that changes anything this worker serves. The browser
// compares this file byte for byte, so an unchanged VERSION means no update
// reaches anybody and the update bar never appears.
const VERSION = "v22";
const CACHE = `weather-${VERSION}`;

// Kept across versions, so an update doesn't throw away what makes the site
// work offline: the last weather, the radar frames, the map tiles already
// looked at, and the map's fonts and icons.
const DATA_CACHE = "weather-data";
const RADAR_CACHE = "weather-radar";
const TILE_CACHE = "weather-tiles";
const MAP_CACHE = "weather-map";
const KEEP = [CACHE, DATA_CACHE, RADAR_CACHE, TILE_CACHE, MAP_CACHE];
// The offline maps (js/offline.js), one cache each, kept until deleted there
// and never trimmed.
const PACK_PREFIX = "weather-offline-";
const kept = (key) => KEEP.includes(key) || key.startsWith(PACK_PREFIX);

// About 25 MB of map tiles at most (OpenFreeMap's run to about 60 KB each,
// OpenStreetMap's to 20 KB), and three hours of radar with room to spare:
// NEA's frames at all three ranges, the DWD's, and the tiled radars' tiles for
// a view or two. The oldest go first.
const MAX_TILES = 400;
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
  "/js/offline.js",
  "/js/info.js",
  // The i18n runtime and every language, so the switcher works offline. Add a
  // language's file here when it goes into i18n/locales.js.
  "/i18n/boot.js",
  "/i18n/i18n.js",
  "/i18n/locales.js",
  "/i18n/switcher.js",
  "/i18n/en.json",
  "/i18n/zh-CN.json",
  "/i18n/ms.json",
  "/i18n/id.json",
  "/i18n/ta.json",
  "/i18n/zh-TW.json",
  "/i18n/zh-HK.json",
  "/i18n/ja.json",
  "/i18n/ko.json",
  "/i18n/th.json",
  "/i18n/tl.json",
  "/i18n/vi.json",
  "/i18n/fr.json",
  "/i18n/es.json",
  "/i18n/nb.json",
  "/i18n/ca.json",
  "/i18n/de.json",
  "/i18n/it.json",
  "/i18n/nl.json",
  "/i18n/pt.json",
  "/i18n/ru.json",
  "/i18n/sw.json",
  "/i18n/eo.json",
  "/i18n/en-pirate.json",
  "/i18n/hnr.json",
  // The switcher's flags (vendor/flags, from flag-icons), one per language in
  // i18n/locales.js.
  "/vendor/flags/gb.svg",
  "/vendor/flags/cn.svg",
  "/vendor/flags/my.svg",
  "/vendor/flags/in.svg",
  "/vendor/flags/id.svg",
  "/vendor/flags/tw.svg",
  "/vendor/flags/hk.svg",
  "/vendor/flags/jp.svg",
  "/vendor/flags/kr.svg",
  "/vendor/flags/th.svg",
  "/vendor/flags/ph.svg",
  "/vendor/flags/vn.svg",
  "/vendor/flags/fr.svg",
  "/vendor/flags/es.svg",
  "/vendor/flags/no.svg",
  "/vendor/flags/es-ct.svg",
  "/vendor/flags/de.svg",
  "/vendor/flags/it.svg",
  "/vendor/flags/nl.svg",
  "/vendor/flags/pt.svg",
  "/vendor/flags/ru.svg",
  "/vendor/flags/tz.svg",
  "/vendor/flags/eo.svg",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre/maplibre-gl.css",
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

// The base map. OpenFreeMap's style and its tile list name this week's tiles,
// so they come from the network first and from the last copy offline, which
// names the tiles kept here. Its fonts and icons never change at a given
// address. Its tiles, and OpenStreetMap's when it stands in, are kept like the
// radar's.
const OFM = "tiles.openfreemap.org";
const isMapStyle = (url) => url.hostname === OFM && (url.pathname.startsWith("/styles/") || url.pathname === "/planet");
const isMapStatic = (url) => url.hostname === OFM && (url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/sprites/"));
const isTile = (url) => url.hostname === "tile.openstreetmap.org" || url.hostname === OFM;
// An offline map keeps its vector tiles with no week in the address, so they
// serve whichever week's tiles the map asks for. Keep in step with tileKey in
// js/offline.js.
const VECTOR_TILE = /^\/planet\/[^/]+\/(\d+\/\d+\/\d+)\.pbf$/;
const packKey = (url) => {
  const m = url.hostname === OFM && url.pathname.match(VECTOR_TILE);
  return m ? `https://${OFM}/planet/any/${m[1]}.pbf` : null;
};
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
      const stale = keys.filter((key) => !kept(key));
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

  // The info modal's version button (js/info.js) asks which version this is.
  if (type === "version") event.ports[0]?.postMessage(VERSION);
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
    else if (isMapStyle(url)) event.respondWith(networkFirst(event, request));
    // An offline map's copy first, online or not: it is the same map, and
    // spares OpenFreeMap the request.
    else if (isMapStatic(url)) event.respondWith(packed(request, url).then((r) => r || cacheFirst(request, MAP_CACHE)));
    else if (isTile(url)) event.respondWith(tile(event, request, url));
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

// From an offline map, if one holds it. A vector tile by z/x/y; anything else,
// its fonts, icons and shaded relief, by its own address.
async function packed(request, url) {
  const key = packKey(url);
  if (!key && url.hostname !== OFM) return null;
  for (const name of await caches.keys()) {
    if (!name.startsWith(PACK_PREFIX)) continue;
    const hit = await (await caches.open(name)).match(key || request);
    if (hit) return hit;
  }
  return null;
}

// A map tile: an offline map's copy, else the network (kept like the radar's),
// else, when the network can't answer, an offline map's archive. The archive
// only stands in offline: it is cut at its borders, so online OpenFreeMap's
// own tiles, which show the neighbours too, come first.
async function tile(event, request, url) {
  const hit = await packed(request, url);
  if (hit) return hit;
  if (self.navigator.onLine === false) {
    const a = await archived(url);
    if (a) return a;
  }
  try {
    const response = await capped(event, request, TILE_CACHE, MAX_TILES);
    if (response.ok || response.type === "opaque") return response;
    return (await archived(url)) || response;
  } catch (err) {
    const a = await archived(url);
    if (a) return a;
    throw err;
  }
}

/* -- Offline map archives --
   A pack with an archive (js/offline.js, from /api/mappack) keeps one PMTiles
   v3 file (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) in
   its cache, in pieces of 4 MiB under /offline-maps/<id>/<etag>/<n>. A tile is
   found from the header and the directories, read out of the pieces it spans,
   and sent unzipped, as OpenFreeMap's arrive. */

const archives = new Map(); // cache name -> { etag, ready: Promise<{ header, root }> }
const pieces = new Map(); // piece key -> Blob, a handle on the cache's copy, not the bytes
const leaves = new Map(); // etag:offset -> parsed leaf directory

async function archived(url) {
  const m = url.hostname === OFM && url.pathname.match(VECTOR_TILE);
  if (!m) return null;
  const [z, x, y] = m[1].split("/").map(Number);
  for (const name of await caches.keys()) {
    if (!name.startsWith(PACK_PREFIX)) continue;
    try {
      const a = await archiveOf(name);
      if (!a) continue;
      const { header } = a;
      if (z < header.minZoom || z > header.maxZoom) continue;
      // Not this archive's: the tile is outside its bounds.
      const n = 2 ** z;
      const west = (x / n) * 360 - 180;
      const east = ((x + 1) / n) * 360 - 180;
      const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
      const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
      if (east < header.west || west > header.east || north < header.south || south > header.north) continue;
      const data = await findTile(a, z, x, y);
      if (data) return new Response(data, { headers: { "Content-Type": "application/x-protobuf" } });
    } catch (err) {
      console.warn("offline map archive:", err);
    }
  }
  return null;
}

// The archive a pack's cache holds, if it is all there. Its metadata is read
// again at most every few seconds, not for every tile.
const metas = new Map(); // cache name -> { at, info }
async function archiveOf(name) {
  const id = name.slice(PACK_PREFIX.length);
  const seen = metas.get(name);
  if (seen && Date.now() - seen.at < 5000) {
    if (!seen.info?.complete) return null;
    const a = archives.get(name);
    if (a && a.etag === seen.info.etag) return Object.assign(a, await a.ready);
  }
  const cache = await caches.open(name);
  const res = await cache.match(`${self.location.origin}/offline-maps/${id}.json`);
  const meta = res && (await res.json());
  const info = meta?.archive;
  metas.set(name, { at: Date.now(), info });
  if (!info?.complete) {
    archives.delete(name);
    return null;
  }
  let a = archives.get(name);
  if (!a || a.etag !== info.etag) {
    a = { etag: info.etag, cache, id, part: info.part, ready: null };
    a.ready = readHeader(a).catch((err) => {
      archives.delete(name);
      throw err;
    });
    archives.set(name, a);
  }
  return Object.assign(a, await a.ready);
}

async function readHeader(a) {
  const buf = await readBytes(a, 0, 16384);
  const v = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 7));
  if (magic !== "PMTiles" || v.getUint8(7) !== 3) throw new Error("not a PMTiles v3 file");
  const u64 = (o) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;
  const header = {
    rootOffset: u64(8), rootLength: u64(16),
    leafOffset: u64(40), dataOffset: u64(56),
    internalCompression: v.getUint8(97), tileCompression: v.getUint8(98),
    minZoom: v.getUint8(100), maxZoom: v.getUint8(101),
    west: v.getInt32(102, true) / 1e7, south: v.getInt32(106, true) / 1e7,
    east: v.getInt32(110, true) / 1e7, north: v.getInt32(114, true) / 1e7,
  };
  const rootBytes = header.rootOffset + header.rootLength <= buf.byteLength
    ? buf.slice(header.rootOffset, header.rootOffset + header.rootLength)
    : await readBytes(a, header.rootOffset, header.rootLength);
  const root = parseDirectory(await unpack(rootBytes, header.internalCompression));
  return { header, root };
}

// Bytes offset .. offset+length from the pieces they span.
async function readBytes(a, offset, length) {
  const P = a.part;
  const first = Math.floor(offset / P);
  const last = Math.floor((offset + length - 1) / P);
  const parts = [];
  for (let i = first; i <= last; i++) {
    const key = `${self.location.origin}/offline-maps/${a.id}/${a.etag}/${i}`;
    let blob = pieces.get(key);
    if (!blob) {
      const res = await a.cache.match(key);
      if (!res) throw new Error(`piece ${i} is missing`);
      blob = await res.blob();
      if (pieces.size > 256) pieces.clear();
      pieces.set(key, blob);
    }
    parts.push(blob.slice(i === first ? offset - i * P : 0, i === last ? offset + length - i * P : P));
  }
  return new Blob(parts).arrayBuffer();
}

async function unpack(buf, compression) {
  if (compression === 0 || compression === 1) return buf; // unknown, none
  if (compression !== 2) throw new Error(`compression ${compression} isn't supported`);
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

// A directory: n entries of tile id, run length, length and offset, as
// varints, each column in turn.
function parseDirectory(buf) {
  const bytes = new Uint8Array(buf);
  let pos = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const b = bytes[pos++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return value;
      scale *= 128;
    }
  };
  const n = varint();
  const ids = new Array(n);
  const runs = new Array(n);
  const lengths = new Array(n);
  const offsets = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) ids[i] = last += varint();
  for (let i = 0; i < n; i++) runs[i] = varint();
  for (let i = 0; i < n; i++) lengths[i] = varint();
  for (let i = 0; i < n; i++) {
    const o = varint();
    offsets[i] = o === 0 && i > 0 ? offsets[i - 1] + lengths[i - 1] : o - 1;
  }
  return { ids, runs, lengths, offsets };
}

// The tile id: the tiles in every zoom above, then the Hilbert curve's index.
function tileId(z, x, y) {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  let d = 0;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return acc + d;
}

async function findTile(a, z, x, y) {
  const { header } = a;
  const id = tileId(z, x, y);
  let dir = a.root;
  for (let depth = 0; depth < 4; depth++) {
    // The last entry at or before the id.
    let lo = 0;
    let hi = dir.ids.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dir.ids[mid] <= id) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (at < 0) return null;
    if (dir.runs[at] === 0) {
      // A leaf directory.
      const key = `${a.etag}:${dir.offsets[at]}`;
      let leaf = leaves.get(key);
      if (!leaf) {
        const raw = await readBytes(a, header.leafOffset + dir.offsets[at], dir.lengths[at]);
        leaf = parseDirectory(await unpack(raw, header.internalCompression));
        if (leaves.size > 64) leaves.clear();
        leaves.set(key, leaf);
      }
      dir = leaf;
      continue;
    }
    if (id - dir.ids[at] >= dir.runs[at]) return null;
    const raw = await readBytes(a, header.dataOffset + dir.offsets[at], dir.lengths[at]);
    return unpack(raw, header.tileCompression);
  }
  return null;
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
  // The last copy, or an offline map's: OpenFreeMap's style and tile list.
  const cached = (await cache.match(request)) || (await packed(request, new URL(request.url)));
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
