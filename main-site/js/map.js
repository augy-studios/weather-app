// The Map page: MapLibre on OpenFreeMap's vector map, in 3D, with the rain radar
// and every other reading on one screen, and a scrubber along the bottom
// through the last three hours.
//
// - The base map, made in one place (baseStyle):
//   - OpenFreeMap's Liberty style in light mode and its Dark style in dark
//     mode, with the buildings standing up from zoom 14. Right drag (or ctrl
//     drag) tilts and turns the map, as does a two finger drag on a phone; the
//     compass puts it back.
//   - When OpenFreeMap doesn't answer (its style, or its tiles again and again,
//     or nothing at all for a while), OpenStreetMap's own tiles instead, for
//     the rest of the visit. Every layer over it stays.
//   - Offline, the service worker answers with what it kept, or with the
//     offline maps of countries and cities (js/offline.js). OpenStreetMap
//     is never kept, so offline the map doesn't fall back to it.
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
// The radar and lightning layers sit over the roads and under the 3D buildings
// and the labels. They are kept in `overlays` as well as on the map, so a new
// base style (the other mode, or the fallback) gets them back as they were.
// The pins are HTML markers, over everything.
//
// MapLibre's zoom levels are one below Leaflet's for the same scale (its tiles
// are 512 px), which is why the zooms here are a step lower than they were.
// Plain script, not a module: published on window.UwuMap. MapLibre is
// vendor/maplibre.

(function () {
  const W = window.UwuWx;
  const { esc, hydrateIcons } = window.UwuUI;
  const Charts = window.UwuCharts;
  const { t, onChange } = window.UwuI18n;

  const $ = (sel) => document.querySelector(sel);

  const OFM_STYLES = {
    light: "https://tiles.openfreemap.org/styles/liberty",
    dark: "https://tiles.openfreemap.org/styles/dark",
  };
  const OFM_ATTRIBUTION = '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
  const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
  const link = (href, name) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${name}</a>`;
  // Made when asked for, so a layer added after a language change has the new words.
  const attribution = (id) => ({
    nea: () => t("map.attribution.nea", { link: link("https://data.gov.sg/", "NEA") }),
    dwd: () => t("map.attribution.dwd", { link: link("https://www.dwd.de/", "DWD"), via: link("https://brightsky.dev/", "Bright Sky") }),
    msc: () => t("map.attribution.radar", { link: link("https://eccc-msc.github.io/open-data/", "ECCC") }),
    rainviewer: () => t("map.attribution.radar", { link: link("https://www.rainviewer.com/", "RainViewer") }),
    owm: () => t("map.attribution.radar", { link: link("https://openweathermap.org/", "OpenWeather") }),
    xweather: () => t("map.attribution.radar", { link: link("https://www.xweather.com/", "Xweather") }),
    gauges: () => t("map.attribution.gauges", { link: link("https://environment.data.gov.uk/", "Environment Agency") }),
    lightning: () => t("map.attribution.lightning", { link: link("https://eccc-msc.github.io/open-data/", "ECCC") }),
  })[id]();
  const sourceName = (id) => ({
    nea: () => t("map.source.nea"),
    dwd: () => t("map.source.dwd"),
    msc: () => t("map.source.msc"),
    rainviewer: () => t("map.source.rainviewer"),
    owm: () => t("map.source.owm"),
    xweather: () => t("map.source.xweather"),
  })[id]();
  const RV_INDEX = "https://api.rainviewer.com/public/weather-maps.json";

  const STEP_MS = 5 * 60 * 1000;
  const WINDOW_MS = 3 * 3600 * 1000;
  const STRIKE_WINDOW_MS = 30 * 60 * 1000;
  const REFRESH_MS = 5 * 60 * 1000;
  const PLAY_MS = 450;

  // How long OpenFreeMap's style may take, how many of its tiles may fail, and
  // how long the map may go without one, before OpenStreetMap stands in.
  const STYLE_TIMEOUT_MS = 8000;
  const BASE_FAILURES = 6;
  const BASE_TILE_TIMEOUT_MS = 15000;

  // NEA's three images, smallest first, with the box each covers.
  const NEA_RANGES = [
    { range: "70km", minZoom: 8, box: [[0.719515, 103.342685], [1.97854, 104.602315]] },
    { range: "240km", minZoom: 6, box: [[-0.809711, 101.810507], [3.506012, 106.130495]] },
    { range: "480km", minZoom: 0, box: [[W.NEA_RADAR_BOX.south, W.NEA_RADAR_BOX.west], [W.NEA_RADAR_BOX.north, W.NEA_RADAR_BOX.east]] },
  ];

  // Roughly where GeoMet's Canadian radar has anything to show.
  const CANADA_BOX = [[41, -142], [72, -50]];

  // The one radar image layer, for NEA's and the DWD's frames.
  const IMAGE = "uwu-image";

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
    imageSrc: null, // the frame and corners the image layer was last given
    rv: null, // { host, frames: [{ t, path }], fetchedAt }
    msc: null, // { url, layer, frames: [{ t }], fetchedAt }
    tileLayers: new Map(), // frame key -> overlay id, for RainViewer, GeoMet and the keyed tiles
    timeline: null, // Singapore's stations
    gauges: null, // England's rain gauges
    ltg: null, // Canada's lightning grid: { url, layer, frames: [{ t, iso }], fetchedAt }
    ltgLayers: new Map(), // frame time -> overlay id
    steps: [],
    index: -1,
    live: true,
    playing: null,
    lastLoad: 0,
    failed: { radar: false, timeline: false, gauges: false },
  };

  // The base map on screen.
  const base = {
    // "openfreemap", or "osm" once OpenFreeMap has failed, for the rest of the visit.
    kind: "openfreemap",
    mode: null, // the mode its style was made for
    asked: 0, // the latest call to useBase, so a slow style doesn't land over a newer one
    failures: 0,
    watchdog: null,
    offline: false, // on OpenStreetMap only because the connection was down
  };

  // The place's name as shown. script.js keeps "My location" in English as a
  // marker; it's shown in the page's language.
  const placeName = () => (place.name === "My location" ? t("places.my-location") : place.name);
  const countryNow = () => forecast?.country || place?.name?.match(/,\s*([A-Z]{2})$/)?.[1] || null;
  const nearSg = () => place && W.inNeaRadar(place.lat, place.lon);
  const modeNow = () => (document.documentElement.getAttribute("data-mode") === "dark" ? "dark" : "light");
  // The image source and its frames want whole URLs.
  const abs = (src) => new URL(src, location.href).href;

  // ---------- setup ----------

  function init() {
    map = new maplibregl.Map({
      container: "map",
      // Nothing until the base style arrives: the page's own background shows.
      style: { version: 8, sources: {}, layers: [] },
      center: place ? [place.lon, place.lat] : [103.8517, 1.2899],
      zoom: 7,
      minZoom: 2,
      maxZoom: 18,
      maxPitch: 60,
      // Right drag and ctrl drag tilt and turn; on a phone, two fingers dragged
      // up or down tilt, and twisted turn. MapLibre's own defaults, set here so
      // nobody turns them off by accident.
      dragRotate: true,
      pitchWithRotate: true,
      touchPitch: true,
      touchZoomRotate: true,
      attributionControl: false,
    });
    // Bottom right, the zoom buttons and compass over the attribution. The
    // compass turns the map back to north and lays it flat.
    // On a phone the attribution folds into its (i) button once the map moves.
    map.addControl(new maplibregl.AttributionControl({
      customAttribution: '<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>',
    }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), "bottom-right");
    // Measured again whenever the box changes: the update bar coming or going, a
    // phone turning, the scrubber growing a line.
    new ResizeObserver(() => map.resize()).observe(map.getContainer());
    // The scrubber's height, as --tl-h, so the zoom buttons and attribution sit
    // above it rather than under it.
    new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty("--tl-h", `${entry.target.offsetHeight}px`);
    }).observe($("#timeline"));

    layers = {
      stations: markers(),
      areas: markers(),
      strikes: markers(),
      place: markers(),
    };

    map.on("style.load", restyled);
    map.on("error", mapError);
    // A few of the styles' shop and amenity icons aren't in OpenFreeMap's
    // sprite; they go without rather than warning about it.
    map.on("styleimagemissing", (e) => {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    // A base tile arrived: OpenFreeMap is answering.
    map.on("sourcedata", (e) => {
      if (e.tile && !overlays.has(e.sourceId)) clearTimeout(base.watchdog);
    });
    map.on("moveend", () => {
      pickNeaRange();
      crowding();
    });
    // The other mode wants the other style.
    new MutationObserver(() => useBase()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    window.addEventListener("online", () => {
      if (!base.offline) return;
      base.offline = false;
      useBase({ force: true });
    });

    wireControls();
    useBase();
    if (place) centre();
  }

  // Zoomed out, labels give way so the pins don't pile up.
  function crowding() {
    const z = map.getZoom();
    map.getContainer().classList.toggle("map-wide", z < 11);
    map.getContainer().classList.toggle("map-far", z < 8.5);
  }

  function centre() {
    map.jumpTo({ center: [place.lon, place.lat], zoom: W.inSingapore(place.lat, place.lon) ? 10 : 7 });
    drawPlace(state.steps[state.index]);
    crowding();
  }

  // ---------- the base map ----------

  // The one place the base map's style is made: OpenFreeMap's for the mode,
  // or OpenStreetMap's tiles once it has failed. The offline maps slot in here.
  async function baseStyle(mode) {
    if (base.kind === "openfreemap") {
      try {
        return standUp(await fetchStyle(OFM_STYLES[mode]), mode);
      } catch (err) {
        // Offline with nothing kept: OpenStreetMap for now, and OpenFreeMap
        // again once the connection is back.
        if (!navigator.onLine) {
          base.offline = true;
          return osmStyle(mode);
        }
        console.warn("OpenFreeMap unavailable, so OpenStreetMap's tiles instead:", err);
        base.kind = "osm";
      }
    }
    return osmStyle(mode);
  }

  async function fetchStyle(url) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), STYLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`${url} replied ${res.status}`);
      const style = await res.json();
      if (!style?.sources || !style.layers?.length) throw new Error(`${url} sent no style`);
      return style;
    } finally {
      clearTimeout(timer);
    }
  }

  // The buildings in 3D. Liberty has them already; the Dark style gets the same
  // layer in its own colours, over the roads and under the labels. A building
  // with no height stands at none rather than filling the console.
  const HEIGHT = ["coalesce", ["get", "render_height"], 0];
  const BASE_HEIGHT = ["coalesce", ["get", "render_min_height"], 0];

  function standUp(style, mode) {
    const vector = Object.keys(style.sources).find((id) => style.sources[id].type === "vector");
    if (!vector) return style;
    style.sources[vector].attribution = OFM_ATTRIBUTION;
    const standing = style.layers.filter((l) => l.type === "fill-extrusion");
    for (const l of standing) Object.assign(l.paint, { "fill-extrusion-height": HEIGHT, "fill-extrusion-base": BASE_HEIGHT });
    if (standing.length) return style;
    const flat = style.layers.find((l) => l["source-layer"] === "building");
    if (!flat) return style;
    flat.maxzoom = 14;
    style.layers.splice(groundTop(style.layers), 0, {
      id: "building-3d",
      type: "fill-extrusion",
      source: vector,
      "source-layer": "building",
      minzoom: 14,
      filter: ["!", ["has", "hide_3d"]],
      paint: {
        "fill-extrusion-color": mode === "dark" ? "rgb(34,34,38)" : "hsl(35,8%,85%)",
        "fill-extrusion-height": HEIGHT,
        "fill-extrusion-base": BASE_HEIGHT,
        "fill-extrusion-opacity": 0.8,
      },
    });
    return style;
  }

  // Just above the last layer drawn flat on the ground: under the labels.
  function groundTop(list) {
    let top = 0;
    list.forEach((l, i) => {
      if (l.type !== "symbol" && l.type !== "fill-extrusion") top = i + 1;
    });
    return top;
  }

  // OpenStreetMap's own tiles. It has no dark style, so in dark mode they are
  // turned down to match: brightness the wrong way round inverts them, and a
  // half turn of hue puts the colours back.
  function osmStyle(mode) {
    return {
      version: 8,
      sources: {
        osm: { type: "raster", tiles: [OSM_URL], tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIBUTION },
      },
      layers: [{
        id: "osm",
        type: "raster",
        source: "osm",
        paint: mode === "dark"
          ? { "raster-brightness-min": 0.85, "raster-brightness-max": 0.05, "raster-hue-rotate": 180, "raster-contrast": -0.1 }
          : {},
      }],
    };
  }

  async function useBase({ force = false } = {}) {
    const mode = modeNow();
    if (!force && mode === base.mode) return;
    const asked = ++base.asked;
    base.mode = mode;
    const style = await baseStyle(mode);
    if (asked !== base.asked) return;
    clearTimeout(base.watchdog);
    base.failures = 0;
    styleReady = false;
    // Not diffed: a whole new style, which restyled() then lays the overlays on.
    map.setStyle(style, { diff: false });
  }

  function fallBack(why) {
    if (base.kind !== "openfreemap") return;
    console.warn(`OpenFreeMap ${why}, so OpenStreetMap's tiles instead.`);
    base.kind = "osm";
    useBase({ force: true });
  }

  // Nothing from OpenFreeMap for a while. Only while the map is on screen and
  // online: a hidden map asks for nothing, and offline OpenStreetMap can't help.
  function watch() {
    clearTimeout(base.watchdog);
    if (base.kind !== "openfreemap" || !map.getSource("openmaptiles")) return;
    base.watchdog = setTimeout(() => {
      if (document.body.classList.contains("view-map") && navigator.onLine) fallBack("sent no map for 15 seconds");
      else watch();
    }, BASE_TILE_TIMEOUT_MS);
  }

  function mapError(e) {
    const o = e.sourceId && overlays.get(e.sourceId);
    // Radar and lightning tiles that fail are left blank, as they always were;
    // the keyed tiles count theirs.
    if (o) return o.onError?.(e);
    const fromOfm = e.sourceId || String(e.error?.url || "").includes("openfreemap.org");
    if (base.kind === "openfreemap" && fromOfm) {
      if (navigator.onLine && ++base.failures >= BASE_FAILURES) fallBack("keeps failing");
      return;
    }
    if (!e.sourceId) console.warn("map:", e.error || e);
  }

  // ---------- overlays ----------

  // Every layer laid over the base map, by id, in the order drawn:
  // { kind: "radar" | "lightning", source, layer, attribution, onError }.
  const overlays = new Map();
  let styleReady = false;
  let anchor = null; // the base layer the overlays go under

  // A new base style is on: the overlays go back on it, radar under lightning,
  // both under the 3D buildings (or, where those come after the last flat
  // layer, the labels).
  function restyled() {
    const list = map.getStyle().layers;
    const standing = list.findIndex((l) => l.type === "fill-extrusion");
    anchor = list[standing >= 0 ? Math.min(standing, groundTop(list)) : groundTop(list)]?.id ?? null;
    styleReady = true;
    for (const kind of ["radar", "lightning"]) {
      for (const o of overlays.values()) if (o.kind === kind) put(o);
    }
    watch();
    drawStep();
  }

  function addOverlay(id, kind, { source, layer, attribution = null, onError = null }) {
    const o = { kind, source, layer: { ...layer, id, source: id }, attribution, onError };
    overlays.set(id, o);
    if (styleReady) put(o);
  }

  function put(o) {
    const id = o.layer.id;
    map.addSource(id, o.source);
    map.addLayer(o.layer, beforeOf(o.kind));
    // An image source has no attribution of its own; the control reads this.
    if (o.attribution) map.getSource(id).attribution = o.attribution;
  }

  // Radar under the lightning, both under the anchor.
  function beforeOf(kind) {
    if (kind === "radar") {
      for (const [id, o] of overlays) if (o.kind === "lightning" && map.getLayer(id)) return id;
    }
    return anchor && map.getLayer(anchor) ? anchor : undefined;
  }

  function removeOverlay(id) {
    if (!overlays.delete(id) || !styleReady) return;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }

  function setOpacity(id, value) {
    const o = overlays.get(id);
    if (!o || o.layer.paint["raster-opacity"] === value) return;
    o.layer.paint["raster-opacity"] = value;
    if (styleReady && map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", value);
  }

  // A tiled raster: RainViewer, GeoMet, the keyed tiles. Frames swap at once,
  // with no fade between them.
  function raster(tiles, { opacity, maxzoom, attribution, onError = null }) {
    return {
      source: { type: "raster", tiles: [tiles], tileSize: 256, maxzoom, attribution },
      layer: { type: "raster", paint: { "raster-opacity": opacity, "raster-opacity-transition": { duration: 0 } } },
      attribution,
      onError,
    };
  }

  // A GeoMet WMS layer at one time, as 256 px tiles in web mercator.
  function wms(url, layer, iso) {
    const params = new URLSearchParams({
      service: "WMS", request: "GetMap", version: "1.3.0", layers: layer, styles: "",
      format: "image/png", transparent: "true", width: "256", height: "256", crs: "EPSG:3857", TIME: iso,
    });
    return `${url}?${params}&bbox={bbox-epsg-3857}`;
  }

  // Leaflet's [[south, west], [north, east]] as the image source's four
  // corners, clockwise from the top left.
  const corners = ([[s, w], [n, e]]) => [[w, n], [e, n], [e, s], [w, s]];

  // ---------- pins ----------

  // A set of pins drawn together and cleared together.
  function markers() {
    const list = [];
    return {
      add(marker) {
        if (marker) list.push(marker.addTo(map));
        return marker;
      },
      clear() {
        for (const marker of list.splice(0)) marker.remove();
      },
    };
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
      console.warn(`${sourceName(source)} radar unavailable:`, err);
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
    for (const id of state.tileLayers.values()) removeOverlay(id);
    state.tileLayers.clear();
    removeOverlay(IMAGE);
    state.imageSrc = null;
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
    $("#tlPlay").setAttribute("aria-label", t("map.scrubber.pause"));
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
    $("#tlPlay").setAttribute("aria-label", t("map.scrubber.play"));
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
    const cur = state.steps[state.index];
    $("#tlTime").textContent = cur ? W.time(cur) : "--";
    $("#tlAgo").textContent = !cur ? t("map.scrubber.none") : state.live ? t("map.scrubber.latest") : W.ago(cur);
    $("#tlLive").disabled = state.live || !n;
    range.setAttribute("aria-valuetext", cur
      ? t("map.scrubber.value", { time: W.time(cur), ago: state.live ? t("map.scrubber.latest-short") : W.ago(cur) })
      : t("map.scrubber.value-none"));
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
    drawStatus();
  }

  function drawRadar(t) {
    const showing = state.radar && t != null;
    if (!showing) {
      setOpacity(IMAGE, 0);
      for (const id of state.tileLayers.values()) setOpacity(id, 0);
      return;
    }

    if (state.source === "nea" || state.source === "dwd") {
      const key = state.source === "nea" ? state.neaRange : "dwd";
      const entry = state.images[key];
      const frame = at(entry?.frames || [], t, 10 * 60 * 1000);
      if (!frame) {
        setOpacity(IMAGE, 0);
        return;
      }
      const bounds = corners(entry.bounds || NEA_RANGES.find((r) => r.range === state.neaRange)?.box);
      const wanted = JSON.stringify([frame.src, bounds]);
      // One image layer, given the next frame: the last stays on screen until
      // it has loaded, and the preloading above means it is usually cached.
      if (!overlays.has(IMAGE)) {
        addOverlay(IMAGE, "radar", {
          source: { type: "image", url: abs(frame.src), coordinates: bounds },
          layer: { type: "raster", paint: { "raster-opacity": 0.7, "raster-fade-duration": 0, "raster-opacity-transition": { duration: 0 } } },
          attribution: attribution(state.source),
        });
      } else if (state.imageSrc !== wanted) {
        const o = overlays.get(IMAGE);
        o.source.url = abs(frame.src);
        o.source.coordinates = bounds;
        if (styleReady) map.getSource(IMAGE)?.updateImage({ url: o.source.url, coordinates: bounds });
      }
      setOpacity(IMAGE, 0.7);
      state.imageSrc = wanted;
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
          make: () => raster(`${state.rv.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
            opacity: 0.75, maxzoom: 7, attribution: attribution("rainviewer"),
          }),
        };
      },
      msc: () => {
        const frame = at(state.msc?.frames || [], t, 12 * 60 * 1000);
        return frame && {
          key: `msc:${frame.iso}`,
          make: () => raster(wms(state.msc.url, state.msc.layer, frame.iso), {
            opacity: 0.75, maxzoom: 18, attribution: attribution("msc"),
          }),
        };
      },
      owm: () => keyedTiles("owm"),
      xweather: () => keyedTiles("xweather"),
    }[state.source];
    const want = tiled?.();
    for (const [key, id] of state.tileLayers) setOpacity(id, want && key === want.key ? 0.75 : 0);
    if (want && !state.tileLayers.has(want.key)) {
      const id = `uwu-radar-${++overlaySeq}`;
      addOverlay(id, "radar", want.make());
      state.tileLayers.set(want.key, id);
    }
  }

  let overlaySeq = 0;

  // Now only, so there is one layer. Too many failed tiles and the other
  // provider takes over.
  function keyedTiles(p) {
    return {
      key: `keyed:${p}`,
      make: () => {
        let failures = 0;
        return raster(`${location.origin}/api/tiles?p=${p}&z={z}&x={x}&y={y}`, {
          opacity: 0.75, maxzoom: 7, attribution: attribution(p),
          onError: () => {
            if (++failures === 6 && p === "owm" && state.source === "owm") {
              // Out of the map's own error handling before its source goes.
              setTimeout(() => {
                switchTo("xweather");
                buildSteps();
              });
            }
          },
        });
      },
    };
  }

  const arrowSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 18 15h-4.5v6h-3v-6H6z"/></svg>';

  // An HTML pin. The outer element sits on the point with no size of its own;
  // the pill inside centres on it, as the CSS says.
  function pin(lat, lon, html, title, popup, className = "station-pin") {
    const el = document.createElement("div");
    el.className = className;
    el.innerHTML = html;
    el.title = title;
    el.setAttribute("aria-label", title);
    hydrateIcons(el);
    const marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([lon, lat]);
    // With a popup it is a button, focusable, opened by Enter as well as a tap.
    if (popup) marker.setPopup(new maplibregl.Popup({ offset: 16, maxWidth: "260px", focusAfterOpen: false }).setHTML(popup));
    else el.setAttribute("role", "img");
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
        t("map.pin.wind-title", { name, speed: Math.round(speed), unit: W.windUnit(), dir: W.compass(dir) }),
        `<p class="popup-title">${esc(name)}</p><p>${t("map.popup.wind", { speed: `<strong>${Math.round(speed)}</strong>`, unit: W.windUnit(), dir: W.compass(dir) })}</p><p class="muted">${knots ? t("map.popup.knots", { knots: v, when }) : when}</p>`);
    }
    if (metric === "rain") {
      if (!Number.isFinite(v)) return null;
      const mm = Math.round(v * 10) / 10;
      const step = Charts.rainStep(mm * (15 / minutes)); // on the fifteen minute scale
      const wet = mm > 0;
      return pin(lat, lon,
        `<span class="pin rain${wet ? "" : " dry"}"><span class="rain-dot" style="background:var(${step.token})"></span>${wet ? `<span>${mm}</span>` : ""}</span>`,
        t("map.pin.rain-title", { name, mm, minutes }),
        `<p class="popup-title">${esc(name)}</p><p>${t("map.popup.rain", { mm: `<strong>${mm}</strong>`, minutes, when })}</p>`);
    }
    if (!Number.isFinite(v)) return null;
    const fmt = metric === "temp" ? (x) => W.fmtDeg(x) : (x) => W.fmtPerc(x);
    const kind = metric === "temp" ? "temp" : "humidity";
    return pin(lat, lon,
      `<span class="pin value"><strong>${fmt(v)}</strong><span>${esc(name)}</span></span>`,
      t(kind === "temp" ? "map.pin.temp-title" : "map.pin.humidity-title", { name, value: fmt(v) }),
      `<p class="popup-title">${esc(name)}</p><p>${t(kind === "temp" ? "map.popup.temp" : "map.popup.humidity", { value: `<strong>${fmt(v)}</strong>` })}</p><p class="muted">${when}</p>`);
  }

  function drawStations(t) {
    layers.stations.clear();
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
        layers.stations.add(readingPin(metric, s[1], s[2], s[0], value, when, { dir: slot.windDir?.[id], knots: true }));
      }
    }

    // England's gauges: rain only.
    const g = state.gauges;
    const gslot = g && metric === "rain" && at(g.slots, t, 20 * 60 * 1000);
    if (gslot) {
      const when = W.time(gslot.t + g.slotMinutes * 60 * 1000);
      for (const [id, mm] of Object.entries(gslot.rain || {})) {
        const s = g.stations[id];
        if (s) layers.stations.add(readingPin("rain", s[1], s[2], s[0], mm, when, { minutes: g.slotMinutes }));
      }
    }
  }

  // The place itself: its pin, carrying the forecast's own reading for the time
  // on the scrubber. In Singapore the stations say it better, so it stays a pin.
  // Either way it sits over the other pins.
  function drawPlace(t) {
    if (!map || !place) return;
    layers.place.clear();
    const metric = state.metric;
    const reading = !nearSg() && t != null && !["none", "forecast"].includes(metric)
      ? at(placeSeries(), t, 15 * 60 * 1000)
      : null;
    // The series is in the units the page asked for, so no conversion here.
    const value = reading && { temp: reading.temp, humidity: reading.humidity, rain: reading.rain, wind: reading.windSpeed }[metric];
    const marker = (reading && Number.isFinite(value)
      ? readingPin(metric, place.lat, place.lon, placeName(), value, W.time(reading.t), { dir: reading.windDir, minutes: 15 })
      : null) || pin(place.lat, place.lon, '<span class="pin place"><span data-icon="pin"></span></span>', placeName(), null, "place-pin");
    marker.getElement().classList.add("on-top");
    layers.place.add(marker);
  }

  // NEA's 2-hour forecast for each area, as it stood at the time on the
  // scrubber when the sg cron has kept it, else the one in force now.
  function drawAreas(t) {
    layers.areas.clear();
    if (state.metric !== "forecast") return;
    const f = sg?.forecast2h;
    if (!f) return;
    const then = t != null && !state.live ? at(state.timeline?.forecasts || [], t, 3 * 3600 * 1000) : null;
    const textOf = (a) => then?.areas?.[a.name] || a.text;
    const valid = then ? then.valid : f.valid?.text;
    for (const a of f.areas) {
      const text = textOf(a);
      layers.areas.add(pin(a.lat, a.lon,
        `<span class="pin area"><span data-icon="${W.neaIcon(text)}"></span><span>${esc(a.name)}</span></span>`,
        `${a.name}: ${W.neaText(text)}`,
        `<p class="popup-title">${esc(a.name)}</p><p>${esc(W.neaText(text))}</p><p class="muted">${esc(valid || "")}</p>`,
        "area-pin"
      ));
    }
  }

  // The grid for the ten minutes to the time on the scrubber, one WMS layer per
  // frame, made when first shown and kept so a replay comes from the cache.
  function drawCanadaLightning(t) {
    // Each frame is the ten minutes to its time and arrives a few minutes after,
    // so the newest can be twenty minutes behind the radar's.
    const frame = state.lightning && t != null && state.ltg ? at(state.ltg.frames, t, 20 * 60 * 1000) : null;
    for (const [iso, id] of state.ltgLayers) setOpacity(id, frame && iso === frame.iso ? 0.9 : 0);
    if (!frame || state.ltgLayers.has(frame.iso)) return;
    const id = `uwu-lightning-${++overlaySeq}`;
    addOverlay(id, "lightning", raster(wms(state.ltg.url, state.ltg.layer, frame.iso), {
      opacity: 0.9, maxzoom: 18, attribution: attribution("lightning"),
    }));
    state.ltgLayers.set(frame.iso, id);
  }

  function clearCanadaLightning() {
    for (const id of state.ltgLayers.values()) removeOverlay(id);
    state.ltgLayers.clear();
    state.ltg = null;
  }

  function drawStrikes(time) {
    layers.strikes.clear();
    drawCanadaLightning(time);
    const strikes = state.timeline?.strikes;
    if (!state.lightning || !strikes?.length || time == null) return;
    for (const s of strikes) {
      const age = time - s.t;
      if (age < 0 || age > STRIKE_WINDOW_MS) continue;
      // Newest at full strength, half an hour old at a quarter.
      const fade = 1 - (age / STRIKE_WINDOW_MS) * 0.75;
      layers.strikes.add(pin(s.lat, s.lon,
        `<span class="strike${s.type === "ground" ? " ground" : ""}" style="opacity:${fade.toFixed(2)}"><span data-icon="bolt"></span></span>`,
        t(s.type === "ground" ? "map.strike.title-ground" : "map.strike.title-cloud", { time: W.time(s.t) }),
        `<p class="popup-title">${t("map.strike.popup-title")}</p><p>${t(s.type === "ground" ? "map.strike.ground" : "map.strike.cloud")}</p><p class="muted">${W.time(s.t)}, ${W.ago(s.t)}</p>`,
        "strike-pin"
      ));
    }
  }

  function drawStatus() {
    const near = nearSg();
    const wanted = radarFor()?.[0];
    const parts = [];
    const s = state.source;
    if (!s) parts.push(t("map.status.none"));
    else if (wanted && s !== wanted) parts.push(t("map.status.fallback", { wanted: sourceName(wanted), source: sourceName(s) }));
    else if (s === "rainviewer") parts.push(t("map.status.rainviewer"));
    else if (s === "owm" || s === "xweather") parts.push(t("map.status.keyed", { source: sourceName(s) }));
    else parts.push(t("map.status.radar", { source: sourceName(s) }));

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
      if (state.failed.timeline) parts.push(t("map.status.stations-unavailable"));
      // Before the collect cron has stored a few slots, only rainfall goes back.
      else if (tl?.source === "live" && state.index < state.steps.length - 1) parts.push(t("map.status.earlier-rain-only"));
    } else if (state.gauges && state.metric === "rain") {
      parts.push(t("map.status.gauges"));
    } else if (state.failed.gauges) {
      parts.push(t("map.status.gauges-unavailable"));
    }

    $("#mapStatusText").textContent = t("map.status.line", { place: placeName(), parts: parts.join(t("map.status.separator")) });
    // The legend's colours are NEA's, which the DWD images are drawn in too.
    $("#radarLegend").hidden = !["nea", "dwd"].includes(s) || !state.radar;
    $("#forecastNote").hidden = state.metric !== "forecast" || !sg?.forecast2h;
    if (sg?.forecast2h) {
      $("#forecastNote").textContent = state.timeline?.forecasts?.length
        ? t("map.forecast.note-issued")
        : t("map.forecast.note-now", { valid: sg.forecast2h.valid?.text || t("map.forecast.now") });
    }
  }

  // ---------- public ----------

  // Called when the Map tab is shown. MapLibre measures its container, so it is
  // only built once the container is on screen.
  function show() {
    if (!map) {
      init();
      load();
    } else {
      map.resize();
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

  // A new language: the scrubber, pins, popups and status are made again from
  // what is already loaded.
  onChange(() => {
    if (!map) return;
    $("#tlPlay").setAttribute("aria-label", state.playing ? t("map.scrubber.pause") : t("map.scrubber.play"));
    drawScrubber();
    drawStep();
  });

  window.UwuMap = { show, hide, setPlace, setSg, setForecast, redraw, refresh: () => load({ force: true }) };
})();
