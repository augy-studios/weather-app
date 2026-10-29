// Offline maps: OpenFreeMap's map of a country or a city kept on this device,
// so the Map page still draws it with no connection. The radar, the readings
// and the weather over it still need one.
//
// - Singapore to zoom 14, with its buildings, and Malaysia to zoom 11, town
//   level, from the country outlines; and cities, Malaysia's and the world's,
//   to zoom 14 over their centres, so their buildings stand up in 3D, with
//   their surroundings to zoom 10. Their tiles are listed by
//   lib/build-map-packs.mjs and served with the list by /api/maptile.
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
  const REGIONS = ["home", "asia", "europe", "north-america", "australia"];
  const PACKS = [
    { id: "sg", region: "home", mb: 32 },
    { id: "my", region: "home", mb: 33 },
    { id: "kuala-lumpur", region: "home", mb: 35 },
    { id: "penang", region: "home", mb: 18 },
    { id: "johor-bahru", region: "home", mb: 21 },
    { id: "kota-kinabalu", region: "home", mb: 10 },
    { id: "kuching", region: "home", mb: 10 },
    { id: "taipei", region: "asia", mb: 30 },
    { id: "hong-kong", region: "asia", mb: 22 },
    { id: "bangkok", region: "asia", mb: 20 },
    { id: "kyoto", region: "asia", mb: 26 },
    { id: "tokyo", region: "asia", mb: 37 },
    { id: "seoul", region: "asia", mb: 32 },
    { id: "london", region: "europe", mb: 40 },
    { id: "paris", region: "europe", mb: 40 },
    { id: "amsterdam", region: "europe", mb: 33 },
    { id: "barcelona", region: "europe", mb: 29 },
    { id: "rome", region: "europe", mb: 29 },
    { id: "new-york", region: "north-america", mb: 41 },
    { id: "vancouver", region: "north-america", mb: 37 },
    { id: "san-francisco", region: "north-america", mb: 29 },
    { id: "sydney", region: "australia", mb: 19 },
  ];
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
      job.kept += keep ? before.kept || 0 : 0;
      meta = { week, complete: false, tiles: count, bytes: job.bytes, kept: job.kept, at: before?.at || null };
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

      meta.bytes = job.bytes;
      meta.kept = job.kept;
      if (!signal.aborted && !failed.length) {
        meta.complete = true;
        meta.at = Date.now();
      } else if (failed.length) {
        notes[id] = { key: "offline.note.failed", params: { count: failed.length }, tone: "bad" };
      }
    } catch (err) {
      if (err.name === "QuotaExceededError") full = true;
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
  const mb = (bytes) => t("offline.mb", { n: (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) });
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
          ? t("offline.state.downloading", { done: job.done, total: job.total, size: mb(job.bytes) })
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
    const area = t(`offline.pack.${p.id}.area`);
    const detail = t("offline.pack.detail", { size: mb(p.mb * 1e6), area });
    return `<li class="pack" data-pack="${p.id}">
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
    list.innerHTML = REGIONS.map((r) => `
      <p class="modal-section-label">${esc(t(`offline.region.${r}`))}</p>
      <ul class="pack-list">${PACKS.filter((p) => p.region === r).map((p) => row(p, metas[p.id])).join("")}</ul>`).join("");
    hydrateIcons(list);
    progress();

    const storage = $("#offlineStorage");
    try {
      const { usage, quota } = await navigator.storage.estimate();
      storage.textContent = t("offline.storage", { used: mb(usage), quota: quota > 1e9 ? t("offline.gb", { n: (quota / 1e9).toFixed(1) }) : mb(quota) });
      storage.hidden = false;
    } catch {
      storage.hidden = true;
    }
  }

  function init() {
    const btn = $("#offlineBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      openModal("offlineModal");
      render();
    });
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
