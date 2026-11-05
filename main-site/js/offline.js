// Offline maps: OpenFreeMap's map of a country or a city kept on this device,
// so the Map page still draws it with no connection. The radar, the readings
// and the weather over it still need one.
//
// - Malaysia, Singapore and Brunei, all of it to zoom 14 with the buildings,
//   from our own archive; and the world's cities to zoom 14 over their
//   centres, so their buildings stand up in 3D, with their surroundings to
//   zoom 9. Their tiles are listed by lib/build-map-packs.mjs and served with
//   the list by /api/maptile.
// - The archive: one PMTiles file, our own build of OpenStreetMap in
//   OpenFreeMap's schema (.github/workflows/offline-maps.yml), fetched in
//   pieces through /api/mappack and kept as those pieces; the service worker
//   reads tiles out of them when the network can't answer. Its wide zooms,
//   styles, fonts and icons still come from OpenFreeMap like a city's.
// - OpenFreeMap allows a download of at most 3,000 tiles or 50 MB, four
//   requests at a time, each with a User-Agent naming the app
//   (https://openfreemap.org/tos/). So everything comes through /api/maptile,
//   which sets one, four at a time, and a download stops at 50 MB.
// - Each map is a cache of its own (weather-offline-sg, weather-offline-paris),
//   outside the service worker's 400-tile limit. Its vector tiles are kept by
//   z/x/y with no week in the address, so the service worker serves them
//   whichever week's tiles OpenFreeMap's tile list names. Both styles (light
//   and dark), their icons and the fonts the labels need go in too.
// - OpenStreetMap's own tiles, the map's fallback, are never kept: its rules
//   don't allow it.
// Plain script, not a module: published on window.UwuOffline.

(function () {
  const { esc, hydrateIcons, openModal } = window.UwuUI;
  const { t, onChange } = window.UwuI18n;

  const $ = (sel) => document.querySelector(sel);

  // The packs in lib/map-packs.js, in the order the modal lists them, under
  // their region. mb is the download's size as lib/build-map-packs.mjs
  // measured it. Each one's name and area are offline.pack.<id>.name and
  // .area in the language files.
  const REGIONS = ["home", "asia", "middle-east", "africa", "europe", "north-america", "south-america", "oceania"];
  // cc: its countries, so a country's name finds it, in the page's language
  // and in English, from the browser's own list of country names.
  // city: a city by its centre, fitted by lib/build-map-packs.mjs, which says
  // so (offline.pack.city.area) rather than naming its districts.
  // full: one of our own archives of a whole country or region, which says
  // so (offline.pack.full.area) rather than naming its area. Its mb is the
  // archive (its <id>.json on the release) and its OpenFreeMap part.
  const PACKS = [
    { id: "malaysia", region: "home", mb: 243, cc: "MY SG BN" },
    { id: "taiwan", region: "asia", mb: 213, full: true, cc: "TW" },
    { id: "taipei", region: "asia", mb: 30, cc: "TW" },
    { id: "hong-kong-sar", region: "asia", mb: 33, full: true, cc: "HK" },
    { id: "hong-kong", region: "asia", mb: 22, cc: "HK" },
    { id: "thailand", region: "asia", mb: 409, full: true, cc: "TH" },
    { id: "bangkok", region: "asia", mb: 20, cc: "TH" },
    { id: "south-korea", region: "asia", mb: 383, full: true, cc: "KR" },
    { id: "seoul", region: "asia", mb: 32, cc: "KR" },
    { id: "japan", region: "asia", mb: 1721, full: true, cc: "JP" },
    { id: "tokyo", region: "asia", mb: 37, cc: "JP" },
    { id: "kyoto", region: "asia", mb: 26, cc: "JP" },
    { id: "java", region: "asia", mb: 520, full: true, cc: "ID" },
    { id: "sumatra", region: "asia", mb: 273, full: true, cc: "ID" },
    { id: "kalimantan", region: "asia", mb: 152, full: true, cc: "ID" },
    { id: "sulawesi", region: "asia", mb: 135, full: true, cc: "ID" },
    { id: "bali-nusa-tenggara", region: "asia", mb: 125, full: true, cc: "ID" },
    { id: "maluku", region: "asia", mb: 52, full: true, cc: "ID" },
    { id: "papua", region: "asia", mb: 75, full: true, cc: "ID" },
    { id: "philippines", region: "asia", mb: 481, full: true, cc: "PH" },
    { id: "vietnam", region: "asia", mb: 330, full: true, cc: "VN" },
    { id: "greater-london", region: "europe", mb: 78, full: true, cc: "GB" },
    { id: "london", region: "europe", mb: 40, cc: "GB" },
    { id: "ile-de-france", region: "europe", mb: 168, full: true, cc: "FR" },
    { id: "paris", region: "europe", mb: 40, cc: "FR" },
    { id: "netherlands", region: "europe", mb: 690, full: true, cc: "NL" },
    { id: "amsterdam", region: "europe", mb: 33, cc: "NL" },
    { id: "catalonia", region: "europe", mb: 198, full: true, cc: "ES" },
    { id: "barcelona", region: "europe", mb: 29, cc: "ES" },
    { id: "lazio", region: "europe", mb: 99, full: true, cc: "IT" },
    { id: "rome", region: "europe", mb: 29, cc: "IT" },
    { id: "new-york-state", region: "north-america", mb: 365, full: true, cc: "US" },
    { id: "new-york", region: "north-america", mb: 41, cc: "US" },
    { id: "northern-california", region: "north-america", mb: 454, full: true, cc: "US" },
    { id: "san-francisco", region: "north-america", mb: 29, cc: "US" },
    { id: "british-columbia", region: "north-america", mb: 1150, full: true, cc: "CA" },
    { id: "vancouver", region: "north-america", mb: 37, cc: "CA" },
    { id: "new-south-wales", region: "oceania", mb: 345, full: true, cc: "AU" },
    { id: "sydney", region: "oceania", mb: 19, cc: "AU" },
    // The rest of the world's major cities, each fitted round its centre.
    { id: "beijing", region: "asia", mb: 23, city: true, cc: "CN" },
    { id: "shanghai", region: "asia", mb: 24, city: true, cc: "CN" },
    { id: "guangzhou", region: "asia", mb: 21, city: true, cc: "CN" },
    { id: "shenzhen", region: "asia", mb: 27, city: true, cc: "CN" },
    { id: "osaka", region: "asia", mb: 40, city: true, cc: "JP" },
    { id: "busan", region: "asia", mb: 17, city: true, cc: "KR" },
    { id: "manila", region: "asia", mb: 36, city: true, cc: "PH" },
    { id: "ho-chi-minh-city", region: "asia", mb: 22, city: true, cc: "VN" },
    { id: "hanoi", region: "asia", mb: 22, city: true, cc: "VN" },
    { id: "jakarta", region: "asia", mb: 44, city: true, cc: "ID" },
    { id: "mumbai", region: "asia", mb: 18, city: true, cc: "IN" },
    { id: "delhi", region: "asia", mb: 27, city: true, cc: "IN" },
    { id: "bengaluru", region: "asia", mb: 32, city: true, cc: "IN" },
    { id: "kathmandu", region: "asia", mb: 25, city: true, cc: "NP" },
    { id: "dubai", region: "middle-east", mb: 22, city: true, cc: "AE" },
    { id: "abu-dhabi", region: "middle-east", mb: 14, city: true, cc: "AE" },
    { id: "doha", region: "middle-east", mb: 18, city: true, cc: "QA" },
    { id: "istanbul", region: "middle-east", mb: 39, city: true, cc: "TR" },
    { id: "tel-aviv", region: "middle-east", mb: 25, city: true, cc: "IL" },
    { id: "riyadh", region: "middle-east", mb: 18, city: true, cc: "SA" },
    { id: "tehran", region: "middle-east", mb: 25, city: true, cc: "IR" },
    { id: "cairo", region: "africa", mb: 28, city: true, cc: "EG" },
    { id: "marrakesh", region: "africa", mb: 14, city: true, cc: "MA" },
    { id: "casablanca", region: "africa", mb: 14, city: true, cc: "MA" },
    { id: "lagos", region: "africa", mb: 20, city: true, cc: "NG" },
    { id: "nairobi", region: "africa", mb: 21, city: true, cc: "KE" },
    { id: "johannesburg", region: "africa", mb: 20, city: true, cc: "ZA" },
    { id: "cape-town", region: "africa", mb: 20, city: true, cc: "ZA" },
    { id: "addis-ababa", region: "africa", mb: 14, city: true, cc: "ET" },
    { id: "berlin", region: "europe", mb: 43, city: true, cc: "DE" },
    { id: "munich", region: "europe", mb: 42, city: true, cc: "DE" },
    { id: "madrid", region: "europe", mb: 40, city: true, cc: "ES" },
    { id: "lisbon", region: "europe", mb: 33, city: true, cc: "PT" },
    { id: "vienna", region: "europe", mb: 41, city: true, cc: "AT" },
    { id: "prague", region: "europe", mb: 44, city: true, cc: "CZ" },
    { id: "zurich", region: "europe", mb: 44, city: true, cc: "CH" },
    { id: "copenhagen", region: "europe", mb: 33, city: true, cc: "DK" },
    { id: "stockholm", region: "europe", mb: 36, city: true, cc: "SE" },
    { id: "dublin", region: "europe", mb: 33, city: true, cc: "IE" },
    { id: "edinburgh", region: "europe", mb: 31, city: true, cc: "GB" },
    { id: "athens", region: "europe", mb: 34, city: true, cc: "GR" },
    { id: "warsaw", region: "europe", mb: 43, city: true, cc: "PL" },
    { id: "budapest", region: "europe", mb: 37, city: true, cc: "HU" },
    { id: "moscow", region: "europe", mb: 43, city: true, cc: "RU" },
    { id: "los-angeles", region: "north-america", mb: 41, city: true, cc: "US" },
    { id: "chicago", region: "north-america", mb: 36, city: true, cc: "US" },
    { id: "washington", region: "north-america", mb: 41, city: true, cc: "US" },
    { id: "boston", region: "north-america", mb: 37, city: true, cc: "US" },
    { id: "miami", region: "north-america", mb: 26, city: true, cc: "US" },
    { id: "toronto", region: "north-america", mb: 37, city: true, cc: "CA" },
    { id: "montreal", region: "north-america", mb: 43, city: true, cc: "CA" },
    { id: "mexico-city", region: "north-america", mb: 28, city: true, cc: "MX" },
    { id: "honolulu", region: "north-america", mb: 12, city: true, cc: "US" },
    { id: "sao-paulo", region: "south-america", mb: 41, city: true, cc: "BR" },
    { id: "rio-de-janeiro", region: "south-america", mb: 20, city: true, cc: "BR" },
    { id: "buenos-aires", region: "south-america", mb: 25, city: true, cc: "AR" },
    { id: "lima", region: "south-america", mb: 21, city: true, cc: "PE" },
    { id: "bogota", region: "south-america", mb: 23, city: true, cc: "CO" },
    { id: "santiago", region: "south-america", mb: 28, city: true, cc: "CL" },
    { id: "melbourne", region: "oceania", mb: 37, city: true, cc: "AU" },
    { id: "brisbane", region: "oceania", mb: 25, city: true, cc: "AU" },
    { id: "perth", region: "oceania", mb: 23, city: true, cc: "AU" },
    { id: "auckland", region: "oceania", mb: 33, city: true, cc: "NZ" },
  ];
  // Downloads from before the Malaysia archive replaced them. A device that
  // still has one is shown it, to delete; the service worker still serves it.
  const RETIRED = ["sg", "my", "kuala-lumpur", "penang", "johor-bahru", "kota-kinabalu", "kuching"];
  const packName = (id) => t(`offline.pack.${id}.name`);

  const OFM = "https://tiles.openfreemap.org";
  const MAX_TILES = 3000;
  const MAX_BYTES = 50_000_000;
  const AT_ONCE = 4;
  const TRIES = 3;

  const cacheName = (id) => `weather-offline-${id}`;
  // How far a download got, kept in the pack's own cache.
  const metaKey = (id) => `${location.origin}/offline-maps/${id}.json`;
  // A vector tile with no week in its address. Keep in step with packKey in sw.js.
  const tileKey = (t) => `${OFM}/planet/any/${t}.pbf`;
  const via = (path) => `/api/maptile?path=${encodeURIComponent(path)}`;
  // An archive's pieces. Keep in step with readBytes in sw.js.
  const pieceKey = (id, etag, n) => `${location.origin}/offline-maps/${id}/${etag}/${n}`;

  const supported = "caches" in window && "serviceWorker" in navigator;
  const running = {}; // id -> { abort, done, total, bytes }
  const notes = {}; // id -> { text, tone }

  // ---------- the packs on the device ----------

  async function readMeta(id) {
    try {
      // Looked up without opening the cache, which would make an empty one.
      const res = await caches.match(metaKey(id), { cacheName: cacheName(id) });
      return res ? await res.json() : null;
    } catch {
      return null;
    }
  }

  function writeMeta(cache, id, meta) {
    return cache.put(metaKey(id), new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  }

  // ---------- downloading ----------

  // Checked with the server each time, so Update sees a new week's tiles.
  async function getJSON(url, signal) {
    const res = await fetch(url, { signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} replied ${res.status}`);
    return res.json();
  }

  // One file through /api/maptile, a few tries apart, into the pack. How much
  // OpenFreeMap sent for it, which is what counts against the 50 MB, and how
  // much it takes up here, unpacked.
  async function save(cache, file, signal) {
    for (let attempt = 1; ; attempt++) {
      try {
        // Not into the browser's own cache as well: the pack is the copy.
        const res = await fetch(via(file.path), { signal, cache: "no-store" });
        if (!res.ok) throw new Error(`${file.path} replied ${res.status}`);
        const body = await res.arrayBuffer();
        const type = res.headers.get("content-type") || "application/octet-stream";
        await cache.put(file.key, new Response(body, { headers: { "Content-Type": type } }));
        return { sent: Number(res.headers.get("x-upstream-length")) || body.byteLength, kept: body.byteLength };
      } catch (err) {
        if (signal.aborted || err.name === "QuotaExceededError" || attempt >= TRIES) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 3 ** (attempt - 1)));
      }
    }
  }

  async function download(id) {
    if (running[id]) return;
    const job = (running[id] = { abort: new AbortController(), done: 0, total: 0, bytes: 0, kept: 0 });
    job.finished = new Promise((resolve) => (job.resolve = resolve));
    const { signal } = job.abort;
    delete notes[id];
    render();

    let cache;
    let meta = null;
    let tooBig = false;
    let full = false;
    try {
      // Kept through a browser clearing space, where it allows that.
      if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist();

      const pack = await getJSON(`/api/maptile?pack=${id}`, signal);
      const count = pack.vector.length + pack.relief.length;
      if (count > MAX_TILES) throw new Error(`${id} is ${count} tiles, over OpenFreeMap's ${MAX_TILES}`);

      cache = await caches.open(cacheName(id));
      const before = await readMeta(id);
      // The tile list and styles count towards the 50 MB too.
      const viaJSON = async (path) => {
        const res = await fetch(via(path), { signal, cache: "no-cache" });
        if (!res.ok) throw new Error(`${path} replied ${res.status}`);
        const text = await res.text();
        job.bytes += Number(res.headers.get("x-upstream-length")) || text.length;
        job.kept += text.length;
        return JSON.parse(text);
      };
      const tileJSON = await viaJSON("/planet");
      const week = tileJSON.tiles?.[0]?.match(/\/planet\/([^/]+)\/\{z\}/)?.[1];
      if (!week) throw new Error("OpenFreeMap's tile list has changed shape");
      // The same week's tiles: what is already here stays, so a stopped
      // download carries on and an update checks rather than fetches again.
      // A new week's tiles replace the old.
      const keep = before?.week === week;
      job.bytes += keep ? before.bytes || 0 : 0;
      // kept counts the archive too; job.kept is OpenFreeMap's files only.
      job.kept += keep ? (before.kept || 0) - (before.archive?.have || 0) : 0;
      // The archive as it was, so the map keeps working while this runs.
      meta = { week, complete: false, tiles: count, bytes: job.bytes, kept: job.kept, at: before?.at || null, archive: before?.archive };
      await writeMeta(cache, id, meta);

      // The tile list, the styles, and from the styles their icons.
      await cache.put(`${OFM}/planet`, new Response(JSON.stringify(tileJSON), { headers: { "Content-Type": "application/json" } }));
      const sprites = new Set();
      for (const s of pack.styles) {
        const style = await viaJSON(`/styles/${s}`);
        await cache.put(`${OFM}/styles/${s}`, new Response(JSON.stringify(style), { headers: { "Content-Type": "application/json" } }));
        if (typeof style.sprite === "string") sprites.add(new URL(style.sprite).pathname);
      }

      const files = [
        ...[...sprites].flatMap((p) => [".json", ".png", "@2x.json", "@2x.png"].map((ext) => ({ path: p + ext, key: OFM + p + ext }))),
        ...pack.fonts.flatMap((f) => pack.glyphs.map((r) => {
          const path = `/fonts/${encodeURIComponent(f)}/${r}.pbf`;
          return { path, key: OFM + path };
        })),
        ...pack.relief.map((t) => ({ path: `/natural_earth/ne2sr/${t}.png`, key: `${OFM}/natural_earth/ne2sr/${t}.png` })),
        ...pack.vector.map((t) => ({ path: `/planet/${week}/${t}.pbf`, key: tileKey(t) })),
      ];
      job.total = files.length;

      // Four at a time, OpenFreeMap's limit. What still fails after its tries
      // waits for a second round, then for Resume.
      const run = async (list) => {
        const failed = [];
        let next = 0;
        const worker = async () => {
          while (next < list.length && !signal.aborted) {
            const file = list[next++];
            if (!(keep && (await cache.match(file.key)))) {
              try {
                const size = await save(cache, file, signal);
                job.bytes += size.sent;
                job.kept += size.kept;
              } catch (err) {
                if (err.name === "QuotaExceededError") {
                  full = true;
                  job.abort.abort();
                } else if (!signal.aborted) {
                  failed.push(file);
                }
              }
              if (job.bytes > MAX_BYTES) {
                tooBig = true;
                job.abort.abort();
              }
            }
            job.done++;
            if (job.done % 100 === 0) {
              meta.bytes = job.bytes;
              meta.kept = job.kept;
              writeMeta(cache, id, meta).catch(() => {});
            }
            progress();
          }
        };
        await Promise.all(Array.from({ length: AT_ONCE }, worker));
        return failed;
      };
      let failed = await run(files);
      if (failed.length && !signal.aborted) {
        job.done -= failed.length;
        failed = await run(failed);
      }

      // The archive, after OpenFreeMap's files, piece by piece.
      if (pack.archive && !signal.aborted && !failed.length) {
        failed = await fetchArchive(id, cache, before, meta, job, signal);
      }

      meta.bytes = job.bytes;
      meta.kept = job.kept + (meta.archive?.have || 0);
      if (!signal.aborted && !failed.length && (!pack.archive || meta.archive?.complete)) {
        meta.complete = true;
        meta.at = Date.now();
      } else if (failed.length) {
        notes[id] = { key: "offline.note.failed", params: { count: failed.length }, tone: "bad" };
      }
    } catch (err) {
      if (err.name === "QuotaExceededError") full = true;
      else if (err.rebuilt) notes[id] = { key: "offline.note.rebuilt" };
      else if (!signal.aborted) {
        console.warn(`offline map ${id} failed:`, err);
        notes[id] = { key: "offline.note.unreachable", tone: "bad" };
      }
    } finally {
      if (full) notes[id] = { key: "offline.note.full", tone: "bad" };
      else if (tooBig) notes[id] = { key: "offline.note.too-big", tone: "bad" };
      else if (signal.aborted && !notes[id]) notes[id] = { key: "offline.note.paused" };
      if (cache && meta) await writeMeta(cache, id, meta).catch(() => {});
      delete running[id];
      job.resolve();
      render();
    }
  }

  // The archive's pieces through /api/mappack, four at a time, into the pack.
  // Pieces of the same file already here stay; a rebuilt file replaces them.
  // Returns the pieces that didn't come through.
  async function fetchArchive(id, cache, before, meta, job, signal) {
    const info = await getJSON(`/api/mappack?id=${id}`, signal);
    const old = before?.archive;
    if (old && old.etag !== info.etag) {
      for (let n = 0; n < old.parts; n++) await cache.delete(pieceKey(id, old.etag, n));
    }
    const same = old?.etag === info.etag;
    // Room for it, or say so now rather than 200 MB in.
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const have = same ? old.have || 0 : 0;
      if (quota && quota - usage < info.size - have) {
        const err = new Error("not enough room");
        err.name = "QuotaExceededError";
        throw err;
      }
    } catch (err) {
      if (err.name === "QuotaExceededError") throw err;
    }
    meta.archive = { etag: info.etag, size: info.size, part: info.part, parts: info.parts, complete: false, have: 0 };
    await writeMeta(cache, id, meta);

    job.total += info.parts;
    progress();
    const failed = [];
    let next = 0;
    const worker = async () => {
      while (next < info.parts && !signal.aborted) {
        const n = next++;
        const key = pieceKey(id, info.etag, n);
        let hit = same && (await cache.match(key));
        let size = hit ? Number(hit.headers.get("content-length")) || 0 : 0;
        if (!hit) {
          try {
            size = await savePiece(cache, id, info, n, key, signal);
          } catch (err) {
            if (err.name === "QuotaExceededError" || err.rebuilt) {
              job.abort.abort();
              throw err;
            }
            if (!signal.aborted) failed.push(n);
          }
        }
        job.archive = (job.archive || 0) + size;
        job.done++;
        progress();
      }
    };
    const results = await Promise.allSettled(Array.from({ length: AT_ONCE }, worker));
    const thrown = results.find((r) => r.status === "rejected");
    if (thrown) throw thrown.reason;

    meta.archive.have = job.archive || 0;
    meta.kept = job.kept + meta.archive.have;
    meta.archive.complete = !signal.aborted && !failed.length;
    await writeMeta(cache, id, meta);
    return failed;
  }

  async function savePiece(cache, id, info, n, key, signal) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`/api/mappack?id=${id}&part=${n}&v=${encodeURIComponent(info.etag)}`, { signal, cache: "no-store" });
        if (res.status === 409) {
          const err = new Error("the map was rebuilt");
          err.rebuilt = true;
          throw err;
        }
        if (!res.ok) throw new Error(`piece ${n} replied ${res.status}`);
        const body = await res.arrayBuffer();
        const want = n === info.parts - 1 ? info.size - n * info.part : info.part;
        if (body.byteLength !== want) throw new Error(`piece ${n} is ${body.byteLength} bytes, not ${want}`);
        await cache.put(key, new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(want) } }));
        return want;
      } catch (err) {
        if (signal.aborted || err.rebuilt || err.name === "QuotaExceededError" || attempt >= TRIES) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 3 ** (attempt - 1)));
      }
    }
  }

  function cancel(id) {
    running[id]?.abort.abort();
  }

  // Once a download under way has stopped, or its last files would land in a
  // new cache.
  async function remove(id) {
    const job = running[id];
    if (job) {
      job.abort.abort();
      await job.finished;
    }
    await caches.delete(cacheName(id));
    notes[id] = { key: "offline.note.deleted" };
    render();
  }

  // ---------- the modal ----------

  // In decimal megabytes, as OpenFreeMap's 50 MB is.
  const mb = (bytes) => (bytes >= 1e9
    ? t("offline.gb", { n: (bytes / 1e9).toFixed(1) })
    : t("offline.mb", { n: (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) }));
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  let drawing = null;
  function progress() {
    drawing ??= requestAnimationFrame(() => {
      drawing = null;
      for (const [id, job] of Object.entries(running)) {
        const row = document.querySelector(`[data-pack="${id}"]`);
        if (!row) continue;
        row.querySelector("progress").max = job.total || 1;
        row.querySelector("progress").value = job.done;
        row.querySelector(".pack-state").textContent = job.total
          ? t("offline.state.downloading", { done: job.done, total: job.total, size: mb(job.bytes + (job.archive || 0)) })
          : t("offline.state.ready");
      }
    });
  }

  // One pack's row.
  function row(p, meta) {
    const job = running[p.id];
    let state;
    let buttons;
    if (job) {
      state = t("offline.state.ready");
      buttons = `<button type="button" class="btn secondary" data-act="cancel">${esc(t("offline.button.cancel"))}</button>`;
    } else if (meta?.complete) {
      state = t("offline.state.downloaded", { date: day(meta.at), size: mb(meta.kept || meta.bytes) });
      buttons = `<button type="button" class="btn secondary" data-act="download">${esc(t("offline.button.update"))}</button><button type="button" class="btn secondary" data-act="delete">${esc(t("offline.button.delete"))}</button>`;
    } else if (meta) {
      state = t("offline.state.part", { size: mb(meta.kept || meta.bytes) });
      buttons = `<button type="button" class="btn" data-act="download">${esc(t("offline.button.resume"))}</button><button type="button" class="btn secondary" data-act="delete">${esc(t("offline.button.delete"))}</button>`;
    } else {
      state = t("offline.state.none");
      buttons = `<button type="button" class="btn" data-act="download"><span data-icon="download"></span><span>${esc(t("offline.button.download"))}</span></button>`;
    }
    const note = notes[p.id];
    if (p.retired) {
      return `<li class="pack" data-pack="${p.id}">
      <div class="pack-text">
        <strong>${esc(packName(p.id))}</strong>
        ${meta ? `<span class="fine pack-state">${esc(t("offline.note.replaced"))}</span>` : ""}
        ${note ? `<span class="alerts-note"${note.tone ? ` data-tone="${note.tone}"` : ""}>${esc(t(note.key, note.params))}</span>` : ""}
      </div>
      <div class="pack-actions">${meta ? `<button type="button" class="btn secondary" data-act="delete">${esc(t("offline.button.delete"))}</button>` : ""}</div>
    </li>`;
    }
    const area = p.full ? t("offline.pack.full.area") : p.city ? t("offline.pack.city.area") : t(`offline.pack.${p.id}.area`);
    const detail = t("offline.pack.detail", { size: mb(p.mb * 1e6), area });
    return `<li class="pack" data-pack="${p.id}" data-search="${esc(searchText(p, area))}">
      <div class="pack-text">
        <strong>${esc(packName(p.id))}</strong>
        <span class="muted fine">${esc(detail)}</span>
        <span class="fine pack-state">${esc(state)}</span>
        <progress max="1" value="0"${job ? "" : " hidden"}></progress>
        ${note ? `<span class="alerts-note"${note.tone ? ` data-tone="${note.tone}"` : ""}>${esc(t(note.key, note.params))}</span>` : ""}
      </div>
      <div class="pack-actions">${buttons}</div>
    </li>`;
  }

  async function render() {
    const list = $("#offlinePacks");
    if (!list) return;
    if (!supported) {
      list.innerHTML = `<p class="muted">${esc(t("offline.unsupported"))}</p>`;
      return;
    }
    const metas = Object.fromEntries(await Promise.all(PACKS.map(async (p) => [p.id, await readMeta(p.id)])));
    const retired = (await Promise.all(RETIRED.map(async (id) => [id, await readMeta(id)])))
      .filter(([id, meta]) => meta || notes[id]);
    await englishNames();
    list.innerHTML = REGIONS.map((r) => `
      <p class="modal-section-label" data-region="${r}">${esc(t(`offline.region.${r}`))}</p>
      <ul class="pack-list" data-region="${r}" data-search="${esc(fold(`${t(`offline.region.${r}`)} ${english[`offline.region.${r}`] || ""}`))}">${PACKS.filter((p) => p.region === r).map((p) => row(p, metas[p.id])).join("")}</ul>`).join("")
      + (retired.length ? `
      <p class="modal-section-label">${esc(t("offline.region.retired"))}</p>
      <ul class="pack-list">${retired.map(([id, meta]) => row({ id, retired: true }, meta)).join("")}</ul>` : "");
    hydrateIcons(list);
    progress();
    filter();

    const storage = $("#offlineStorage");
    try {
      const { usage, quota } = await navigator.storage.estimate();
      storage.textContent = t("offline.storage", { used: mb(usage), quota: mb(quota) });
      storage.hidden = false;
    } catch {
      storage.hidden = true;
    }
  }

  // ---------- search ----------

  // Lower case, accents off, so "sao" finds São Paulo and "zurich" Zürich.
  const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // The English names too, so a name typed in English finds the pack in any
  // language. From the language file the service worker already keeps.
  let english = {};
  let englishLoaded = null;
  function englishNames() {
    englishLoaded ??= fetch("/i18n/en.json").then((r) => r.json()).then((j) => (english = j)).catch(() => {});
    return englishLoaded;
  }
  function countryNames(codes) {
    const out = [];
    for (const lang of [window.UwuI18n.getLocale?.(), "en"]) {
      try {
        const names = new Intl.DisplayNames([lang || "en", "en"], { type: "region" });
        for (const cc of codes.split(" ")) out.push(names.of(cc));
      } catch {}
    }
    return out.join(" ");
  }
  const searchText = (p, area) => fold(`${packName(p.id)} ${english[`offline.pack.${p.id}.name`] || ""} ${area} ${p.cc ? countryNames(p.cc) : ""}`);

  // Rows that match every word typed, in their name, area or region; a
  // region with none is hidden whole.
  function filter() {
    const list = $("#offlinePacks");
    const input = $("#offlineSearch");
    const none = $("#offlineNone");
    if (!list || !input) return;
    const words = fold(input.value).split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const ul of list.querySelectorAll(".pack-list")) {
      let inRegion = 0;
      for (const li of ul.querySelectorAll(".pack")) {
        const hay = `${li.dataset.search || ""} ${ul.dataset.search || ""}`;
        const match = words.every((w) => hay.includes(w));
        li.hidden = !match;
        if (match) inRegion++;
      }
      ul.hidden = !inRegion;
      const label = ul.previousElementSibling;
      if (label?.classList.contains("modal-section-label")) label.hidden = !inRegion;
      shown += inRegion;
    }
    none.hidden = shown > 0 || !words.length;
    none.textContent = none.hidden ? "" : t("offline.search.none", { q: input.value.trim() });
  }

  function init() {
    const btn = $("#offlineBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      openModal("offlineModal");
      render();
    });
    $("#offlineSearch")?.addEventListener("input", filter);
    $("#offlinePacks").addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      const id = e.target.closest("[data-pack]")?.dataset.pack;
      if (!act || !id) return;
      if (act === "download") download(id);
      else if (act === "cancel") cancel(id);
      else if (act === "delete") remove(id);
    });
  }

  init();
  // The modal again in the new language, if it's open.
  onChange(() => {
    if (!$("#offlineModal")?.classList.contains("hidden")) render();
  });

  window.UwuOffline = { download, cancel, remove, status: readMeta };
})();
