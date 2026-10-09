// The Map page: Leaflet on OpenStreetMap's tiles, with the rain radar and every
// other reading on one screen, and a scrubber along the bottom through the last
// three hours.
//
// - Radar, three hours of it wherever a national service keeps that long:
//   - NEA's own images round Singapore (roughly 480 km), from /api/radar, one
//     every five minutes, kept by the sg cron. The 70, 240 or 480 km image is
//     picked to suit the view.
//   - In Germany, the DWD's radar through Bright Sky, every five minutes, drawn
//     into images by /api/radar?src=dwd round the place.
//   - In Canada, MSC's GeoMet radar as WMS tiles, every six minutes.
//   - Everywhere else, or when those don't answer, RainViewer's tiles, one every
//     ten minutes for the last two hours, which is all RainViewer keeps. Its
//     tiles stop at zoom 7 and are enlarged beyond it.
//   - When RainViewer doesn't answer either, OpenWeather's or Xweather's radar
//     as it is now, through /api/tiles, which keeps their keys off the page.
// - Readings on the pins, one metric at a time so they don't pile up:
//   - Singapore's stations from /api/timeline: temperature, humidity, rainfall
//     and wind, and NEA's 2-hour forecast for each area as it stood at the time.
//   - England's rain gauges round the place, from /api/gauges, every 15 minutes.
//   - Everywhere, the place itself, from the forecast's fifteen-minute series,
//     which runs three hours back.
// - Lightning, where a national network reports it: in Singapore, NEA's
//   strikes in the half hour before the time on the scrubber, fading with age;
//   in Canada, Environment Canada's grid of flashes in the ten minutes to it.
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
  const ATTRIBUTION = {
    nea: 'Radar and stations: <a href="https://data.gov.sg/" target="_blank" rel="noopener noreferrer">NEA</a>',
    dwd: 'Radar: <a href="https://www.dwd.de/" target="_blank" rel="noopener noreferrer">DWD</a> via <a href="https://brightsky.dev/" target="_blank" rel="noopener noreferrer">Bright Sky</a>',
    msc: 'Radar: <a href="https://eccc-msc.github.io/open-data/" target="_blank" rel="noopener noreferrer">ECCC</a>',
    rainviewer: 'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener noreferrer">RainViewer</a>',
    owm: 'Radar: <a href="https://openweathermap.org/" target="_blank" rel="noopener noreferrer">OpenWeather</a>',
    xweather: 'Radar: <a href="https://www.xweather.com/" target="_blank" rel="noopener noreferrer">Xweather</a>',
    gauges: 'Rain gauges: <a href="https://environment.data.gov.uk/" target="_blank" rel="noopener noreferrer">Environment Agency</a>',
    lightning: 'Lightning: <a href="https://eccc-msc.github.io/open-data/" target="_blank" rel="noopener noreferrer">ECCC</a>',
  };
  const SOURCE_NAMES = { nea: "NEA", dwd: "the DWD", msc: "Environment Canada", rainviewer: "RainViewer", owm: "OpenWeather", xweather: "Xweather" };
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

  // Roughly where GeoMet's Canadian radar has anything to show.
  const CANADA_BOX = [[41, -142], [72, -50]];

  let map = null;
  let layers = {};
  let place = null;
  let sg = null; // /api/sg, for the forecast areas
  let forecast = null; // /api/forecast, for the place's own readings

  const state = {
    metric: "temp",
    radar: true,
    lightning: true,
    // "nea" | "dwd" | "msc" | "rainviewer" | "owm" | "xweather" | null
    source: null,
    neaRange: null,
    images: {}, // NEA range or "dwd" -> { frames, bounds, fetchedAt }
    rv: null, // { host, frames: [{ t, path }], fetchedAt }
    msc: null, // { url, layer, frames: [{ t }], fetchedAt }
    tileLayers: new Map(), // frame key -> Leaflet layer, for RainViewer, GeoMet and the keyed tiles
    timeline: null, // Singapore's stations
    gauges: null, // England's rain gauges
    ltg: null, // Canada's lightning grid: { url, layer, frames: [{ t, iso }], fetchedAt }
    ltgLayers: new Map(), // frame time -> WMS layer
    steps: [],
    index: -1,
    live: true,
    playing: null,
    lastLoad: 0,
    failed: { radar: false, timeline: false, gauges: false },
  };

  const countryNow = () => forecast?.country || place?.name?.match(/,\s*([A-Z]{2})$/)?.[1] || null;
  const nearSg = () => place && W.inNeaRadar(place.lat, place.lon);

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
    // Canada's lightning grid, over the radar and under the pins.
    map.createPane("lightning");
    map.getPane("lightning").style.zIndex = 360;
    map.getPane("lightning").style.pointerEvents = "none";

    layers = {
      stations: L.layerGroup().addTo(map),
      areas: L.layerGroup().addTo(map),
      strikes: L.layerGroup().addTo(map),
      place: L.layerGroup().addTo(map),
      image: null,
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
    drawPlace(state.steps[state.index]);
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
  const imageLoading = {};

  function loadImages(key, url, { force = false } = {}) {
    const have = state.images[key];
    if (have && !force && Date.now() - have.fetchedAt < 60_000) return Promise.resolve(have);
    imageLoading[key] ??= getJSON(url).then((data) => {
      const entry = {
        bounds: data.bounds,
        frames: data.frames.map((f) => ({ t: Date.parse(f.t), src: f.src })),
        fetchedAt: Date.now(),
      };
      if (!entry.frames.length) throw new Error(`${url} listed no frames`);
      state.images[key] = entry;
      preload(entry.frames.map((f) => f.src).reverse());
      return entry;
    }).finally(() => delete imageLoading[key]);
    return imageLoading[key];
  }

  // Warm the cache, so scrubbing and playing don't wait on each image. Newest
  // first, since that is the frame on screen, and a few at a time: all of them
  // at once can land on cold functions together.
  const PRELOAD_AT_ONCE = 3;
  const preloaded = new Set();

  function preload(srcs) {
    const queue = srcs.filter((src) => !preloaded.has(src));
    const next = () => {
      const src = queue.shift();
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        preloaded.add(src);
        next();
      };
      // Left out of `preloaded`, so the next refresh tries it again.
      img.onerror = next;
      img.src = src;
    };
    for (let i = 0; i < PRELOAD_AT_ONCE; i++) next();
  }

  async function loadRainViewer({ force = false } = {}) {
    if (state.rv && !force && Date.now() - state.rv.fetchedAt < 120_000) return state.rv;
    const data = await getJSON(RV_INDEX);
    const frames = (data.radar?.past || []).map((f) => ({ t: f.time * 1000, path: f.path }));
    if (!frames.length) throw new Error("RainViewer listed no frames");
    state.rv = { host: data.host, frames, fetchedAt: Date.now() };
    return state.rv;
  }

  async function loadMsc({ force = false } = {}) {
    if (state.msc && !force && Date.now() - state.msc.fetchedAt < 120_000) return state.msc;
    const data = await getJSON("/api/radar?src=msc");
    state.msc = { ...data, frames: data.frames.map((f) => ({ t: Date.parse(f.t), iso: f.t })), fetchedAt: Date.now() };
    return state.msc;
  }

  async function loadTimeline() {
    const data = await getJSON("/api/timeline");
    state.timeline = {
      ...data,
      slots: data.slots.map((s) => ({ ...s, t: Date.parse(s.t) })),
      strikes: data.strikes.map((s) => ({ ...s, t: Date.parse(s.t) })),
      forecasts: (data.forecasts || []).map((f) => ({ ...f, t: Date.parse(f.t) })),
    };
  }

  async function loadCanadaLightning() {
    if (state.ltg && Date.now() - state.ltg.fetchedAt < 120_000) return;
    const data = await getJSON("/api/radar?src=msc-lightning");
    state.ltg = { ...data, frames: data.frames.map((f) => ({ t: Date.parse(f.t), iso: f.t })), fetchedAt: Date.now() };
  }

  async function loadGauges() {
    const data = await getJSON(`/api/gauges?lat=${place.lat}&lon=${place.lon}`);
    state.gauges = Object.keys(data.stations || {}).length
      ? { ...data, slots: data.slots.map((s) => ({ ...s, t: Date.parse(s.t) })) }
      : null;
  }

  // The smallest NEA image that covers the middle of the view at this zoom.
  function rangeFor() {
    const c = map.getCenter();
    const z = map.getZoom();
    return NEA_RANGES.find((r) => z >= r.minZoom && inside(r.box, c.lat, c.lng))?.range ?? null;
  }

  const inside = (box, lat, lon) => lat >= box[0][0] && lat <= box[1][0] && lon >= box[0][1] && lon <= box[1][1];

  // NEA's image follows the view; panning out of its reach goes to RainViewer.
  async function pickNeaRange() {
    if (!map || !nearSg()) return;
    const range = rangeFor();
    if (!range) {
      if (state.source === "nea") await useFallbacks();
      return;
    }
    if (state.source === "nea" && range === state.neaRange) return;
    if (state.source !== "nea" && state.failed.radar) return;
    await useSource("nea", range);
  }

  // The radar meant for this place, and the next in line when it doesn't answer.
  async function useSource(source, range = null) {
    try {
      if (source === "nea") await loadImages(range, `/api/radar?range=${range}`);
      else if (source === "dwd") await loadImages("dwd", `/api/radar?src=dwd&lat=${place.lat}&lon=${place.lon}`);
      else if (source === "msc") await loadMsc();
      switchTo(source, range);
      state.failed.radar = false;
      buildSteps();
    } catch (err) {
      console.warn(`${SOURCE_NAMES[source]} radar unavailable:`, err);
      state.failed.radar = true;
      await useFallbacks();
    }
  }

  async function useFallbacks() {
    try {
      await loadRainViewer();
      switchTo("rainviewer");
    } catch (err) {
      console.warn("RainViewer unavailable:", err);
      // The keyed services' radar as it is now; /api/tiles turns away a
      // provider without a key, and drawRadar moves on from one whose tiles fail.
      switchTo(state.source === "xweather" ? "xweather" : "owm");
    }
    buildSteps();
  }

  function switchTo(source, range = null) {
    if (state.source !== source || state.neaRange !== range) clearRadar();
    state.source = source;
    state.neaRange = range;
  }

  function clearRadar() {
    for (const layer of state.tileLayers.values()) layer.remove();
    state.tileLayers.clear();
    if (layers.image) {
      layers.image.remove();
      layers.image = null;
      state.imageSrc = null;
    }
  }

  function radarFor() {
    const country = countryNow();
    if (nearSg() && rangeFor()) return ["nea", rangeFor()];
    if (country === "DE") return ["dwd"];
    if (country === "CA" && inside(CANADA_BOX, place.lat, place.lon)) return ["msc"];
    return null;
  }

  async function load({ force = false } = {}) {
    if (!map || !place) return;
    state.lastLoad = Date.now();
    $("#mapStatus").classList.add("busy");

    const tasks = [];
    if (nearSg()) {
      tasks.push(loadTimeline().then(() => (state.failed.timeline = false), (err) => {
        console.warn("timeline unavailable:", err);
        state.failed.timeline = true;
      }));
    } else {
      state.timeline = null;
    }
    if (countryNow() === "CA") {
      tasks.push(loadCanadaLightning().catch((err) => {
        console.warn("Canadian lightning unavailable:", err);
        state.ltg = null;
      }));
    } else {
      clearCanadaLightning();
    }
    if (countryNow() === "GB") {
      tasks.push(loadGauges().then(() => (state.failed.gauges = false), (err) => {
        console.warn("rain gauges unavailable:", err);
        state.failed.gauges = true;
      }));
    } else {
      state.gauges = null;
    }

    if (force) {
      state.images = {};
      state.rv = null;
      state.msc = null;
    }
    state.failed.radar = false;
    const wanted = radarFor();
    tasks.push(wanted ? useSource(...wanted) : useFallbacks());

    await Promise.all(tasks);
    $("#mapStatus").classList.remove("busy");
    buildSteps();
  }

  // ---------- the scrubber's steps ----------

  // The place's own readings, every fifteen minutes from three hours back.
  function placeSeries() {
    const m = forecast?.minutely_15;
    if (!m?.time?.length) return [];
    const now = Date.now();
    return m.time
      .map((t, i) => ({
        t: t * 1000,
        temp: m.temperature_2m?.[i],
        humidity: m.relative_humidity_2m?.[i],
        rain: m.precipitation?.[i],
        windSpeed: m.wind_speed_10m?.[i],
        windDir: m.wind_direction_10m?.[i],
      }))
      .filter((s) => s.t <= now);
  }

  // Five-minute steps across whatever the radar and readings have, ending at
  // the newest of them. Each step shows the newest frame and readings at or
  // before it.
  function buildSteps() {
    const series = [radarFrames(), state.timeline?.slots || [], state.gauges?.slots || [], placeSeries()];
    const ends = series.map((s) => s.at(-1)?.t).filter(Number.isFinite);
    if (!ends.length) {
      state.steps = [];
      drawScrubber();
      drawStep();
      return;
    }
    const end = Math.max(...ends);
    const starts = series.map((s) => s[0]?.t).filter(Number.isFinite);
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
    if (state.source === "nea") return state.images[state.neaRange]?.frames || [];
    if (state.source === "dwd") return state.images.dwd?.frames || [];
    if (state.source === "msc") return state.msc?.frames || [];
    if (state.source === "rainviewer") return state.rv?.frames || [];
    // The keyed tiles have only now.
    if (state.source === "owm" || state.source === "xweather") return [{ t: Math.floor(Date.now() / STEP_MS) * STEP_MS }];
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
    drawAreas(t);
    drawStrikes(t);
    drawPlace(t);
    drawStatus(t);
  }

  function drawRadar(t) {
    const showing = state.radar && t != null;
    if (!showing) {
      layers.image?.setOpacity(0);
      for (const layer of state.tileLayers.values()) layer.setOpacity(0);
      return;
    }

    if (state.source === "nea" || state.source === "dwd") {
      const key = state.source === "nea" ? state.neaRange : "dwd";
      const entry = state.images[key];
      const frame = at(entry?.frames || [], t, 10 * 60 * 1000);
      if (!frame) {
        layers.image?.setOpacity(0);
        return;
      }
      const bounds = entry.bounds || NEA_RANGES.find((r) => r.range === state.neaRange)?.box;
      if (!layers.image) {
        layers.image = L.imageOverlay(frame.src, bounds, {
          pane: "radar", opacity: 0.7, interactive: false, alt: "", attribution: ATTRIBUTION[state.source],
        }).addTo(map);
      } else {
        layers.image.setBounds(L.latLngBounds(bounds));
        if (state.imageSrc !== frame.src) layers.image.setUrl(frame.src);
        layers.image.setOpacity(0.7);
      }
      state.imageSrc = frame.src;
      return;
    }

    // Tiled radars: one layer per frame, made the first time the frame is shown
    // and kept, so a replay is served from the browser's cache. RainViewer
    // allows 100 requests a minute from each address, and the keyed services
    // are on free plans, so frames are never fetched ahead.
    const tiled = {
      rainviewer: () => {
        const frame = at(state.rv?.frames || [], t, 20 * 60 * 1000);
        return frame && {
          key: `rv:${frame.path}`,
          make: () => L.tileLayer(`${state.rv.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
            pane: "radar", opacity: 0.75, maxNativeZoom: 7, maxZoom: 18, attribution: ATTRIBUTION.rainviewer,
          }),
        };
      },
      msc: () => {
        const frame = at(state.msc?.frames || [], t, 12 * 60 * 1000);
        return frame && {
          key: `msc:${frame.iso}`,
          make: () => L.tileLayer.wms(state.msc.url, {
            layers: state.msc.layer, format: "image/png", transparent: true, version: "1.3.0",
            TIME: frame.iso, pane: "radar", opacity: 0.75, maxZoom: 18, attribution: ATTRIBUTION.msc,
            // CORS, so the service worker can keep frames for offline.
            crossOrigin: "anonymous",
          }),
        };
      },
      owm: () => keyedTiles("owm"),
      xweather: () => keyedTiles("xweather"),
    }[state.source];
    const want = tiled?.();
    for (const [key, layer] of state.tileLayers) layer.setOpacity(want && key === want.key ? 0.75 : 0);
    if (want && !state.tileLayers.has(want.key)) state.tileLayers.set(want.key, want.make().addTo(map));
  }

  // Now only, so there is one layer. Too many failed tiles and the other
  // provider takes over.
  function keyedTiles(p) {
    return {
      key: `keyed:${p}`,
      make: () => {
        let failures = 0;
        const layer = L.tileLayer(`/api/tiles?p=${p}&z={z}&x={x}&y={y}`, {
          pane: "radar", opacity: 0.75, maxNativeZoom: 7, maxZoom: 18, attribution: ATTRIBUTION[p],
        });
        layer.on("tileerror", () => {
          if (++failures === 6 && p === "owm" && state.source === "owm") {
            switchTo("xweather");
            buildSteps();
          }
        });
        return layer;
      },
    };
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

  // One reading as a pin, the same way for a station, a gauge or the place.
  // `minutes` is how long a rain reading covers.
  function readingPin(metric, lat, lon, name, v, when, { dir = null, minutes = 5, knots = false } = {}) {
    if (metric === "wind") {
      if (!Number.isFinite(v) || !Number.isFinite(dir)) return null;
      const speed = knots ? W.fromKnots(v) : v;
      // The direction is where the wind comes from; the arrow points where it goes.
      return pin(lat, lon,
        `<span class="pin wind"><span class="wind-arrow" style="transform:rotate(${(dir + 180) % 360}deg)">${arrowSvg}</span><span>${Math.round(speed)}</span></span>`,
        `${name}: ${Math.round(speed)} ${W.windUnit()} from the ${W.compass(dir)}`,
        `<p class="popup-title">${esc(name)}</p><p><strong>${Math.round(speed)}</strong> ${W.windUnit()} from the ${W.compass(dir)}</p><p class="muted">${knots ? `${v} knots, ` : ""}${when}</p>`);
    }
    if (metric === "rain") {
      if (!Number.isFinite(v)) return null;
      const mm = Math.round(v * 10) / 10;
      const step = Charts.rainStep(mm * (15 / minutes)); // on the fifteen minute scale
      const wet = mm > 0;
      return pin(lat, lon,
        `<span class="pin rain${wet ? "" : " dry"}"><span class="rain-dot" style="background:var(${step.token})"></span>${wet ? `<span>${mm}</span>` : ""}</span>`,
        `${name}: ${mm} mm in ${minutes} minutes`,
        `<p class="popup-title">${esc(name)}</p><p><strong>${mm}</strong> mm in the ${minutes} minutes to ${when}</p>`);
    }
    if (!Number.isFinite(v)) return null;
    const fmt = metric === "temp" ? (x) => W.fmtDeg(x) : (x) => W.fmtPerc(x);
    const label = metric === "temp" ? "Temperature" : "Humidity";
    return pin(lat, lon,
      `<span class="pin value"><strong>${fmt(v)}</strong><span>${esc(name)}</span></span>`,
      `${name}: ${label.toLowerCase()} ${fmt(v)}`,
      `<p class="popup-title">${esc(name)}</p><p>${label} <strong>${fmt(v)}</strong></p><p class="muted">${when}</p>`);
  }

  function drawStations(t) {
    layers.stations.clearLayers();
    const metric = state.metric;
    if (t == null || metric === "none" || metric === "forecast") return;

    // Singapore's stations, in Celsius and knots as NEA reports them.
    const tl = state.timeline;
    const slot = tl && at(tl.slots, t, 10 * 60 * 1000);
    if (slot) {
      const when = W.time(slot.t);
      const values = metric === "wind" ? slot.windSpeed : slot[metric];
      for (const [id, v] of Object.entries(values || {})) {
        const s = tl.stations[id];
        if (!s) continue;
        const value = metric === "temp" ? W.fromC(v) : v;
        readingPin(metric, s[1], s[2], s[0], value, when, { dir: slot.windDir?.[id], knots: true })?.addTo(layers.stations);
      }
    }

    // England's gauges: rain only.
    const g = state.gauges;
    const gslot = g && metric === "rain" && at(g.slots, t, 20 * 60 * 1000);
    if (gslot) {
      const when = W.time(gslot.t + g.slotMinutes * 60 * 1000);
      for (const [id, mm] of Object.entries(gslot.rain || {})) {
        const s = g.stations[id];
        if (s) readingPin("rain", s[1], s[2], s[0], mm, when, { minutes: g.slotMinutes })?.addTo(layers.stations);
      }
    }
  }

  // The place itself: its pin, carrying the forecast's own reading for the time
  // on the scrubber. In Singapore the stations say it better, so it stays a pin.
  function drawPlace(t) {
    if (!map || !place) return;
    layers.place.clearLayers();
    const metric = state.metric;
    const reading = !nearSg() && t != null && !["none", "forecast"].includes(metric)
      ? at(placeSeries(), t, 15 * 60 * 1000)
      : null;
    // The series is in the units the page asked for, so no conversion here.
    const value = reading && { temp: reading.temp, humidity: reading.humidity, rain: reading.rain, wind: reading.windSpeed }[metric];
    const marker = reading && Number.isFinite(value)
      ? readingPin(metric, place.lat, place.lon, place.name, value, W.time(reading.t), { dir: reading.windDir, minutes: 15 })
      : null;
    if (marker) {
      marker.setZIndexOffset(2000);
      marker.addTo(layers.place);
      return;
    }
    L.marker([place.lat, place.lon], {
      icon: L.divIcon({ className: "place-pin", html: '<span class="pin place"><span data-icon="pin"></span></span>', iconSize: null }),
      title: place.name,
      keyboard: false,
      zIndexOffset: 2000,
    }).addTo(layers.place);
    hydrateIcons(map.getPane("markerPane"));
  }

  // NEA's 2-hour forecast for each area, as it stood at the time on the
  // scrubber when the sg cron has kept it, else the one in force now.
  function drawAreas(t) {
    layers.areas.clearLayers();
    if (state.metric !== "forecast") return;
    const f = sg?.forecast2h;
    if (!f) return;
    const then = t != null && !state.live ? at(state.timeline?.forecasts || [], t, 3 * 3600 * 1000) : null;
    const textOf = (a) => then?.areas?.[a.name] || a.text;
    const valid = then ? then.valid : f.valid?.text;
    for (const a of f.areas) {
      const text = textOf(a);
      pin(a.lat, a.lon,
        `<span class="pin area"><span data-icon="${W.neaIcon(text)}"></span><span>${esc(a.name)}</span></span>`,
        `${a.name}: ${W.neaText(text)}`,
        `<p class="popup-title">${esc(a.name)}</p><p>${esc(W.neaText(text))}</p><p class="muted">${esc(valid || "")}</p>`,
        "area-pin"
      ).addTo(layers.areas);
    }
    hydrateIcons(map.getPane("markerPane"));
  }

  // The grid for the ten minutes to the time on the scrubber, one WMS layer per
  // frame, made when first shown and kept so a replay comes from the cache.
  function drawCanadaLightning(t) {
    // Each frame is the ten minutes to its time and arrives a few minutes after,
    // so the newest can be twenty minutes behind the radar's.
    const frame = state.lightning && t != null && state.ltg ? at(state.ltg.frames, t, 20 * 60 * 1000) : null;
    for (const [iso, layer] of state.ltgLayers) layer.setOpacity(frame && iso === frame.iso ? 0.9 : 0);
    if (!frame || state.ltgLayers.has(frame.iso)) return;
    state.ltgLayers.set(frame.iso, L.tileLayer.wms(state.ltg.url, {
      layers: state.ltg.layer, format: "image/png", transparent: true, version: "1.3.0",
      TIME: frame.iso, pane: "lightning", opacity: 0.9, maxZoom: 18, attribution: ATTRIBUTION.lightning,
      crossOrigin: "anonymous",
    }).addTo(map));
  }

  function clearCanadaLightning() {
    for (const layer of state.ltgLayers.values()) layer.remove();
    state.ltgLayers.clear();
    state.ltg = null;
  }

  function drawStrikes(t) {
    layers.strikes.clearLayers();
    drawCanadaLightning(t);
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
    const near = nearSg();
    const wanted = radarFor()?.[0];
    const parts = [];
    const s = state.source;
    if (!s) parts.push("No radar right now");
    else if (wanted && s !== wanted) parts.push(`${SOURCE_NAMES[wanted]}'s radar isn't answering, so this is ${SOURCE_NAMES[s]}'s`);
    else if (s === "rainviewer") parts.push("Radar from RainViewer, the last 2 hours");
    else if (s === "owm" || s === "xweather") parts.push(`RainViewer isn't answering, so this is ${SOURCE_NAMES[s]}'s radar, now only`);
    else parts.push(`Radar from ${SOURCE_NAMES[s]}`);

    // Stations, forecast areas and lightning are NEA's, so away from Singapore
    // their controls step aside rather than showing nothing. The readings stay:
    // elsewhere they are the place's own, and England's gauges.
    $("#mapMetric").hidden = !near && !placeSeries().length && !state.gauges;
    $('#mapMetric [data-metric="forecast"]').hidden = !near;
    if (!near && state.metric === "forecast") {
      state.metric = "temp";
      pick($("#mapMetric"), "data-metric", state.metric);
    }
    $("#mapLightning").hidden = !near && !state.ltg;

    const tl = state.timeline;
    if (near) {
      if (state.failed.timeline) parts.push("station readings unavailable");
      // Before the collect cron has stored a few slots, only rainfall goes back.
      else if (tl?.source === "live" && state.index < state.steps.length - 1) parts.push("earlier times show rainfall only for now");
    } else if (state.gauges && state.metric === "rain") {
      parts.push("rain gauges from the Environment Agency");
    } else if (state.failed.gauges) {
      parts.push("rain gauges unavailable");
    }

    $("#mapStatusText").textContent = `${place.name}. ${parts.join(", ")}.`;
    // The legend's colours are NEA's, which the DWD images are drawn in too.
    $("#radarLegend").hidden = !["nea", "dwd"].includes(s) || !state.radar;
    $("#forecastNote").hidden = state.metric !== "forecast" || !sg?.forecast2h;
    if (sg?.forecast2h) {
      $("#forecastNote").textContent = state.timeline?.forecasts?.length
        ? `2-hour forecast as NEA issued it at the time on the scrubber.`
        : `2-hour forecast, ${sg.forecast2h.valid?.text || "now"}. Forecasts are for now only.`;
    }
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
    if (moved) forecast = null;
    if (!map) return;
    if (moved) {
      stop();
      state.live = true;
      clearRadar();
      clearCanadaLightning();
      state.source = null;
      state.neaRange = null;
      state.gauges = null;
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

  // The place's forecast arrived: its readings join the scrubber, and its
  // country may pick a different radar.
  function setForecast(data) {
    const countryWas = countryNow();
    forecast = data;
    if (!map) return;
    if (countryNow() !== countryWas) load();
    else buildSteps();
  }

  // Units or theme changed: the pins carry both.
  function redraw() {
    if (map) drawStep();
  }

  // Every five minutes while on screen, keeping to the latest if that's where it was.
  setInterval(() => {
    if (map && document.visibilityState === "visible" && document.body.classList.contains("view-map")) load();
  }, REFRESH_MS);

  window.UwuMap = { show, hide, setPlace, setSg, setForecast, redraw, refresh: () => load({ force: true }) };
})();
