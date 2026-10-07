// The Map page: Leaflet on OpenStreetMap's tiles, with the rain radar and every
// other reading on one screen, and a scrubber along the bottom through the last
// three hours.
//
// - Radar. Inside NEA's reach (Singapore and roughly 480 km round it), NEA's own
//   images from /api/radar, one every five minutes. The 70, 240 or 480 km image
//   is picked to suit the view. Everywhere else, or when NEA does not answer,
//   RainViewer's tiles, one every ten minutes for the last two hours, which is
//   all RainViewer keeps. Its tiles stop at zoom 7 and are enlarged beyond it.
// - Singapore's stations, from /api/timeline: temperature, humidity, rainfall
//   and wind, one metric on the pins at a time so they don't pile up.
// - NEA's 2-hour forecast for each area, which only exists for now.
// - Lightning strikes, the half hour before the time on the scrubber, fading
//   with age.
//
// OSM has no dark style, so in dark mode style.css turns the tiles down to match.
// The radar sits in its own pane so it keeps its true colours.
// Plain script, not a module: published on window.UwuMap. Leaflet is vendor/leaflet.

(function () {
  const W = window.UwuWx;
  const { esc, hydrateIcons } = window.UwuUI;
  const Charts = window.UwuCharts;

  const $ = (sel) => document.querySelector(sel);

  const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
  const NEA_ATTRIBUTION = 'Radar and stations: <a href="https://data.gov.sg/" target="_blank" rel="noopener noreferrer">NEA</a>';
  const RV_ATTRIBUTION = 'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener noreferrer">RainViewer</a>';
  const RV_INDEX = "https://api.rainviewer.com/public/weather-maps.json";

  const STEP_MS = 5 * 60 * 1000;
  const WINDOW_MS = 3 * 3600 * 1000;
  const STRIKE_WINDOW_MS = 30 * 60 * 1000;
  const REFRESH_MS = 5 * 60 * 1000;
  const PLAY_MS = 450;

  // NEA's three images, smallest first, with the box each covers.
  const NEA_RANGES = [
    { range: "70km", minZoom: 9, box: [[0.719515, 103.342685], [1.97854, 104.602315]] },
    { range: "240km", minZoom: 7, box: [[-0.809711, 101.810507], [3.506012, 106.130495]] },
    { range: "480km", minZoom: 0, box: [[W.NEA_RADAR_BOX.south, W.NEA_RADAR_BOX.west], [W.NEA_RADAR_BOX.north, W.NEA_RADAR_BOX.east]] },
  ];

  let map = null;
  let layers = {};
  let place = null;
  let sg = null; // /api/sg, for the forecast areas

  const state = {
    metric: "temp",
    radar: true,
    lightning: true,
    source: null, // "nea" | "rainviewer" | null
    neaRange: null,
    neaFrames: {}, // range -> { frames, bounds, fetchedAt }
    rv: null, // { host, frames: [{ t, path }], fetchedAt }
    rvLayers: new Map(),
    timeline: null,
    steps: [],
    index: -1,
    live: true,
    playing: null,
    lastLoad: 0,
    failed: { nea: false, timeline: false, rv: false },
  };

  // ---------- setup ----------

  function init() {
    map = L.map("map", {
      minZoom: 3,
      maxZoom: 18,
      zoomSnap: 0.5,
      zoomControl: false,
      worldCopyJump: true,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    // Measured again whenever the box changes: the update bar coming or going, a
    // phone turning, the scrubber growing a line.
    new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());
    // The scrubber's height, as --tl-h, so the zoom buttons and attribution sit
    // above it rather than under it.
    new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty("--tl-h", `${entry.target.offsetHeight}px`);
    }).observe($("#timeline"));

    L.tileLayer(OSM_URL, {
      maxZoom: 18,
      attribution: OSM_ATTRIBUTION,
      // CORS, so the service worker can keep a copy that works offline.
      crossOrigin: "anonymous",
    }).addTo(map);

    // Above the tiles, so the dark mode filter on the tile pane leaves it alone,
    // and under the pins.
    map.createPane("radar");
    map.getPane("radar").style.zIndex = 350;
    map.getPane("radar").style.pointerEvents = "none";

    layers = {
      stations: L.layerGroup().addTo(map),
      areas: L.layerGroup().addTo(map),
      strikes: L.layerGroup().addTo(map),
      place: L.layerGroup().addTo(map),
      nea: null,
    };

    map.on("moveend zoomend", () => {
      pickNeaRange();
      crowding();
    });

    wireControls();
    if (place) centre();
  }

  // Zoomed out, labels give way so the pins don't pile up.
  function crowding() {
    const z = map.getZoom();
    map.getContainer().classList.toggle("map-wide", z < 12);
    map.getContainer().classList.toggle("map-far", z < 9.5);
  }

  function centre() {
    map.setView([place.lat, place.lon], W.inSingapore(place.lat, place.lon) ? 11 : 8);
    layers.place.clearLayers();
    L.marker([place.lat, place.lon], {
      icon: L.divIcon({ className: "place-pin", html: '<span class="pin place"><span data-icon="pin"></span></span>', iconSize: null }),
      title: place.name,
      keyboard: false,
      zIndexOffset: 2000,
    }).addTo(layers.place);
    hydrateIcons(map.getPane("markerPane"));
    crowding();
  }

  // ---------- controls ----------

  function pick(group, attr, value) {
    group.querySelectorAll(`[${attr}]`).forEach((btn) => {
      const on = btn.getAttribute(attr) === value;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  function toggle(btn, on) {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  }

  function wireControls() {
    $("#mapMetric").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-metric]");
      if (!btn) return;
      state.metric = state.metric === btn.dataset.metric ? "none" : btn.dataset.metric;
      pick($("#mapMetric"), "data-metric", state.metric);
      drawStep();
    });
    $("#mapRadar").addEventListener("click", () => {
      state.radar = !state.radar;
      toggle($("#mapRadar"), state.radar);
      drawStep();
    });
    $("#mapLightning").addEventListener("click", () => {
      state.lightning = !state.lightning;
      toggle($("#mapLightning"), state.lightning);
      drawStep();
    });

    const range = $("#tlRange");
    range.addEventListener("input", () => {
      stop();
      setIndex(Number(range.value));
    });
    $("#tlPlay").addEventListener("click", () => (state.playing ? stop() : play()));
    $("#tlLive").addEventListener("click", () => {
      stop();
      setIndex(state.steps.length - 1);
    });
  }

  // ---------- loading ----------

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} replied ${res.status}`);
    return res.json();
  }

  // Loading a place and the map settling on it each ask for the same list; one
  // request answers all of them.
  const neaLoading = {};

  function loadNea(range, { force = false } = {}) {
    const have = state.neaFrames[range];
    if (have && !force && Date.now() - have.fetchedAt < 60_000) return Promise.resolve(have);
    neaLoading[range] ??= fetchNea(range).finally(() => delete neaLoading[range]);
    return neaLoading[range];
  }

  async function fetchNea(range) {
    const data = await getJSON(`/api/radar?range=${range}`);
    const entry = {
      bounds: data.bounds,
      frames: data.frames.map((f) => ({ t: Date.parse(f.t), src: f.src })),
      fetchedAt: Date.now(),
    };
    state.neaFrames[range] = entry;
    // Warm the cache, so scrubbing and playing don't wait on each image.
    for (const f of entry.frames) new Image().src = f.src;
    return entry;
  }

  async function loadRainViewer({ force = false } = {}) {
    if (state.rv && !force && Date.now() - state.rv.fetchedAt < 120_000) return state.rv;
    const data = await getJSON(RV_INDEX);
    state.rv = {
      host: data.host,
      frames: (data.radar?.past || []).map((f) => ({ t: f.time * 1000, path: f.path })),
      fetchedAt: Date.now(),
    };
    return state.rv;
  }

  async function loadTimeline() {
    const data = await getJSON("/api/timeline");
    state.timeline = {
      ...data,
      slots: data.slots.map((s) => ({ ...s, t: Date.parse(s.t) })),
      strikes: data.strikes.map((s) => ({ ...s, t: Date.parse(s.t) })),
    };
  }

  // The smallest NEA image that covers the middle of the view at this zoom.
  function rangeFor() {
    const c = map.getCenter();
    const z = map.getZoom();
    const inside = (box) => c.lat >= box[0][0] && c.lat <= box[1][0] && c.lng >= box[0][1] && c.lng <= box[1][1];
    return NEA_RANGES.find((r) => z >= r.minZoom && inside(r.box))?.range ?? null;
  }

  async function pickNeaRange() {
    if (!map) return;
    const range = rangeFor();
    if (!range) {
      // Panned out of NEA's reach altogether.
      if (state.source === "nea") await useRainViewer();
      return;
    }
    if (state.source === "nea" && range === state.neaRange) return;
    if (state.source === "rainviewer" && state.failed.nea) return;
    try {
      await loadNea(range);
      state.neaRange = range;
      state.source = "nea";
      state.failed.nea = false;
      clearRainViewer();
    } catch (err) {
      console.warn("NEA radar unavailable:", err);
      state.failed.nea = true;
      await useRainViewer();
      return;
    }
    buildSteps();
  }

  async function useRainViewer() {
    try {
      await loadRainViewer();
      state.source = "rainviewer";
      state.failed.rv = false;
      if (layers.nea) {
        layers.nea.remove();
        layers.nea = null;
        state.neaSrc = null;
      }
    } catch (err) {
      console.warn("RainViewer unavailable:", err);
      state.failed.rv = true;
      state.source = null;
    }
    buildSteps();
  }

  async function load({ force = false } = {}) {
    if (!map || !place) return;
    state.lastLoad = Date.now();
    $("#mapStatus").classList.add("busy");

    const nearSg = W.inNeaRadar(place.lat, place.lon);
    const tasks = [];
    if (nearSg) {
      tasks.push(loadTimeline().then(() => (state.failed.timeline = false), (err) => {
        console.warn("timeline unavailable:", err);
        state.failed.timeline = true;
      }));
    } else {
      state.timeline = null;
    }

    if (force) {
      state.neaFrames = {};
      state.rv = null;
    }
    state.failed.nea = false;
    state.source = null;
    state.neaRange = null;
    tasks.push(nearSg && rangeFor() ? pickNeaRange() : useRainViewer());

    await Promise.all(tasks);
    $("#mapStatus").classList.remove("busy");
    buildSteps();
  }

  // ---------- the scrubber's steps ----------

  // Five-minute steps across whatever the radar and stations have, ending at the
  // newest of them. Each step shows the newest frame and readings at or before it.
  function buildSteps() {
    const frames = radarFrames();
    const slots = state.timeline?.slots || [];
    const ends = [frames.at(-1)?.t, slots.at(-1)?.t].filter(Number.isFinite);
    if (!ends.length) {
      state.steps = [];
      drawScrubber();
      drawStep();
      return;
    }
    const end = Math.max(...ends);
    const starts = [frames[0]?.t, slots[0]?.t].filter(Number.isFinite);
    const start = Math.max(end - WINDOW_MS, Math.min(...starts));
    const wasLive = state.live || state.index < 0;
    const wasAt = state.steps[state.index];

    state.steps = [];
    for (let t = end; t >= start; t -= STEP_MS) state.steps.unshift(t);

    state.index = wasLive || !wasAt ? state.steps.length - 1 : Math.max(0, state.steps.findIndex((t) => t >= wasAt));
    drawScrubber();
    drawStep();
  }

  function radarFrames() {
    if (state.source === "nea") return state.neaFrames[state.neaRange]?.frames || [];
    if (state.source === "rainviewer") return state.rv?.frames || [];
    return [];
  }

  // The newest entry at or before t, if it is no older than `within`.
  function at(list, t, within) {
    let best = null;
    for (const e of list) if (e.t <= t && (!best || e.t > best.t)) best = e;
    return best && t - best.t <= within ? best : null;
  }

  function setIndex(i) {
    if (!state.steps.length) return;
    state.index = Math.max(0, Math.min(state.steps.length - 1, i));
    state.live = state.index === state.steps.length - 1;
    drawScrubber();
    drawStep();
  }

  function play() {
    if (state.steps.length < 2) return;
    if (state.index >= state.steps.length - 1) setIndex(0);
    $("#tlPlay").setAttribute("aria-label", "Pause");
    $("#tlPlay [data-icon]").dataset.icon = "pause";
    hydrateIcons($("#tlPlay"));
    state.playing = setInterval(() => {
      if (state.index >= state.steps.length - 1) return stop();
      setIndex(state.index + 1);
    }, PLAY_MS);
  }

  function stop() {
    if (!state.playing) return;
    clearInterval(state.playing);
    state.playing = null;
    $("#tlPlay").setAttribute("aria-label", "Play the last three hours");
    $("#tlPlay [data-icon]").dataset.icon = "play";
    hydrateIcons($("#tlPlay"));
  }

  function drawScrubber() {
    const range = $("#tlRange");
    const n = state.steps.length;
    range.max = Math.max(0, n - 1);
    range.value = Math.max(0, state.index);
    range.disabled = n < 2;
    $("#tlPlay").disabled = n < 2;
    const t = state.steps[state.index];
    $("#tlTime").textContent = t ? W.time(t) : "--";
    $("#tlAgo").textContent = !t ? "No readings yet" : state.live ? "Latest" : W.ago(t);
    $("#tlLive").disabled = state.live || !n;
    range.setAttribute("aria-valuetext", t ? `${W.time(t)}, ${state.live ? "latest" : W.ago(t)}` : "No readings");
    // Where the scale starts and ends, under the track.
    $("#tlStart").textContent = n ? W.time(state.steps[0]) : "";
    $("#tlEnd").textContent = n ? W.time(state.steps[n - 1]) : "";
  }

  // ---------- drawing one step ----------

  function drawStep() {
    if (!map || !place) return;
    const t = state.steps[state.index];
    drawRadar(t);
    drawStations(t);
    drawAreas();
    drawStrikes(t);
    drawStatus(t);
  }

  function drawRadar(t) {
    if (!state.radar || t == null) {
      if (layers.nea) layers.nea.setOpacity(0);
      for (const layer of state.rvLayers.values()) layer.setOpacity(0);
      return;
    }

    if (state.source === "nea") {
      const entry = state.neaFrames[state.neaRange];
      const frame = at(entry?.frames || [], t, 10 * 60 * 1000);
      if (!frame) {
        layers.nea?.setOpacity(0);
        return;
      }
      const bounds = entry.bounds || NEA_RANGES.find((r) => r.range === state.neaRange).box;
      if (!layers.nea) {
        layers.nea = L.imageOverlay(frame.src, bounds, {
          pane: "radar", opacity: 0.7, interactive: false, alt: "", attribution: NEA_ATTRIBUTION,
        }).addTo(map);
      } else {
        layers.nea.setBounds(L.latLngBounds(bounds));
        if (state.neaSrc !== frame.src) layers.nea.setUrl(frame.src);
        layers.nea.setOpacity(0.7);
      }
      state.neaSrc = frame.src;
      return;
    }

    if (state.source === "rainviewer") {
      const frame = at(state.rv?.frames || [], t, 20 * 60 * 1000);
      for (const [path, layer] of state.rvLayers) layer.setOpacity(frame && path === frame.path ? 0.75 : 0);
      if (frame && !state.rvLayers.has(frame.path)) {
        // Made the first time each frame is shown and kept, so a replay is
        // served from the browser's cache. RainViewer allows 100 requests a
        // minute from each address, so frames are never fetched ahead.
        const layer = L.tileLayer(`${state.rv.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
          pane: "radar",
          opacity: 0.75,
          maxNativeZoom: 7,
          maxZoom: 18,
          attribution: RV_ATTRIBUTION,
        }).addTo(map);
        state.rvLayers.set(frame.path, layer);
      }
    }
  }

  function clearRainViewer() {
    for (const layer of state.rvLayers.values()) layer.remove();
    state.rvLayers.clear();
  }

  const arrowSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 18 15h-4.5v6h-3v-6H6z"/></svg>';

  function pin(lat, lon, html, title, popup, className = "station-pin") {
    const marker = L.marker([lat, lon], {
      icon: L.divIcon({ className, html, iconSize: null }),
      title,
      keyboard: true,
      riseOnHover: true,
    });
    if (popup) marker.bindPopup(popup);
    return marker;
  }

  function drawStations(t) {
    layers.stations.clearLayers();
    const tl = state.timeline;
    const metric = state.metric;
    if (!tl || t == null || metric === "none" || metric === "forecast") return;
    const slot = at(tl.slots, t, 10 * 60 * 1000);
    if (!slot) return;
    const when = W.time(slot.t);

    if (metric === "wind") {
      for (const [id, speed] of Object.entries(slot.windSpeed || {})) {
        const s = tl.stations[id];
        const dir = slot.windDir?.[id];
        if (!s || !Number.isFinite(dir)) continue;
        const v = W.fromKnots(speed);
        // The direction is where the wind comes from; the arrow points where it goes.
        pin(s[1], s[2],
          `<span class="pin wind"><span class="wind-arrow" style="transform:rotate(${(dir + 180) % 360}deg)">${arrowSvg}</span><span>${Math.round(v)}</span></span>`,
          `${s[0]}: ${Math.round(v)} ${W.windUnit()} from the ${W.compass(dir)}`,
          `<p class="popup-title">${esc(s[0])}</p><p><strong>${Math.round(v)}</strong> ${W.windUnit()} from the ${W.compass(dir)}</p><p class="muted">${speed} knots, ${when}</p>`
        ).addTo(layers.stations);
      }
      return;
    }

    if (metric === "rain") {
      for (const [id, mm] of Object.entries(slot.rain || {})) {
        const s = tl.stations[id];
        if (!s) continue;
        const step = Charts.rainStep(mm * 3); // five minutes, on the fifteen minute scale
        const wet = mm > 0;
        pin(s[1], s[2],
          `<span class="pin rain${wet ? "" : " dry"}"><span class="rain-dot" style="background:var(${step.token})"></span>${wet ? `<span>${mm}</span>` : ""}</span>`,
          `${s[0]}: ${mm} mm in five minutes`,
          `<p class="popup-title">${esc(s[0])}</p><p><strong>${mm}</strong> mm in the five minutes to ${when}</p>`
        ).addTo(layers.stations);
      }
      return;
    }

    const values = slot[metric] || {};
    const fmt = metric === "temp" ? (v) => W.fmtDeg(W.fromC(v)) : (v) => W.fmtPerc(v);
    const name = metric === "temp" ? "Temperature" : "Humidity";
    for (const [id, v] of Object.entries(values)) {
      const s = tl.stations[id];
      if (!s) continue;
      pin(s[1], s[2],
        `<span class="pin value"><strong>${fmt(v)}</strong><span>${esc(s[0])}</span></span>`,
        `${s[0]}: ${name.toLowerCase()} ${fmt(v)}`,
        `<p class="popup-title">${esc(s[0])}</p><p>${name} <strong>${fmt(v)}</strong></p><p class="muted">${when}</p>`
      ).addTo(layers.stations);
    }
  }

  function drawAreas() {
    layers.areas.clearLayers();
    if (state.metric !== "forecast") return;
    const f = sg?.forecast2h;
    if (!f) return;
    for (const a of f.areas) {
      pin(a.lat, a.lon,
        `<span class="pin area"><span data-icon="${W.neaIcon(a.text)}"></span><span>${esc(a.name)}</span></span>`,
        `${a.name}: ${W.neaText(a.text)}`,
        `<p class="popup-title">${esc(a.name)}</p><p>${esc(W.neaText(a.text))}</p><p class="muted">${esc(f.valid?.text || "")}</p>`,
        "area-pin"
      ).addTo(layers.areas);
    }
    hydrateIcons(map.getPane("markerPane"));
  }

  function drawStrikes(t) {
    layers.strikes.clearLayers();
    const strikes = state.timeline?.strikes;
    if (!state.lightning || !strikes?.length || t == null) return;
    for (const s of strikes) {
      const age = t - s.t;
      if (age < 0 || age > STRIKE_WINDOW_MS) continue;
      // Newest at full strength, half an hour old at a quarter.
      const fade = 1 - (age / STRIKE_WINDOW_MS) * 0.75;
      pin(s.lat, s.lon,
        `<span class="strike${s.type === "ground" ? " ground" : ""}" style="opacity:${fade.toFixed(2)}"><span data-icon="bolt"></span></span>`,
        `Lightning, ${s.type === "ground" ? "cloud to ground" : "cloud to cloud"}, ${W.time(s.t)}`,
        `<p class="popup-title">Lightning</p><p>${s.type === "ground" ? "Cloud to ground" : "Cloud to cloud"}</p><p class="muted">${W.time(s.t)}, ${W.ago(s.t)}</p>`,
        "strike-pin"
      ).addTo(layers.strikes);
    }
    hydrateIcons(map.getPane("markerPane"));
  }

  function drawStatus(t) {
    const parts = [];
    if (state.source === "nea") parts.push("Radar from NEA");
    else if (state.source === "rainviewer") parts.push(W.inNeaRadar(place.lat, place.lon) ? "NEA's radar isn't answering, so this is RainViewer's" : "Radar from RainViewer, the last 2 hours");
    else parts.push("No radar right now");

    // Stations, forecast areas and lightning are NEA's, so away from Singapore
    // their controls step aside rather than showing nothing.
    const near = W.inNeaRadar(place.lat, place.lon);
    $("#mapMetric").hidden = !near;
    $("#mapLightning").hidden = !near;

    const tl = state.timeline;
    if (near) {
      if (state.failed.timeline) parts.push("station readings unavailable");
      // Before the collect cron has stored a few slots, only rainfall goes back.
      else if (tl?.source === "live" && state.index < state.steps.length - 1) parts.push("earlier times show rainfall only for now");
    }

    $("#mapStatusText").textContent = `${place.name}. ${parts.join(", ")}.`;
    $("#radarLegend").hidden = state.source !== "nea" || !state.radar;
    $("#forecastNote").hidden = state.metric !== "forecast" || !sg?.forecast2h;
    if (sg?.forecast2h) $("#forecastNote").textContent = `2-hour forecast, ${sg.forecast2h.valid?.text || "now"}. Forecasts are for now only.`;
  }

  // ---------- public ----------

  // Called when the Map tab is shown. Leaflet measures its container, so it is
  // only built once the container is on screen.
  function show() {
    if (!map) {
      init();
      load();
    } else {
      map.invalidateSize();
      if (Date.now() - state.lastLoad > REFRESH_MS) load();
    }
  }

  function hide() {
    stop();
  }

  function setPlace(next) {
    const moved = !place || place.lat !== next.lat || place.lon !== next.lon;
    place = next;
    if (!map) return;
    if (moved) {
      stop();
      state.live = true;
      clearRainViewer();
      if (layers.nea) {
        layers.nea.remove();
        layers.nea = null;
        state.neaSrc = null;
      }
      centre();
      load();
    } else {
      drawStep();
    }
  }

  function setSg(data) {
    sg = data;
    if (map) drawStep();
  }

  // Units or theme changed: the pins carry both.
  function redraw() {
    if (map) drawStep();
  }

  // Every five minutes while on screen, keeping to the latest if that's where it was.
  setInterval(() => {
    if (map && document.visibilityState === "visible" && document.body.classList.contains("view-map")) load();
  }, REFRESH_MS);

  window.UwuMap = { show, hide, setPlace, setSg, redraw, refresh: () => load({ force: true }) };
})();
