// UwU Weather: the page. Wires the tray and its four pages (Now, Map, Forecast,
// Air & heat), the place bar, the theme, sync, share and alerts panels, and draws
// each page from three sources:
//
// - /api/forecast, everywhere: Open-Meteo's forecast in its own shape, with the
//   national weather service's readings already laid over it (the US, Norway,
//   Canada, Germany, England, Ireland, Switzerland, China), MeteoGate's
//   stations and warnings across Europe, the sea, and a keyed service standing
//   in when Open-Meteo is down. See lib/place.js.
// - NEA, through /api/sg, in Singapore: the nearest stations' readings, the
//   2-hour, 24-hour and 4-day forecasts, UV, heat stress and lightning. Each
//   part that NEA can't give right now falls back to the forecast's.
// - /api/air, everywhere: NEA's PSI in Singapore, the Norwegian index in
//   Norway, the AQHI in Canada, WAQI's stations in China, Open-Meteo's US AQI
//   elsewhere.
//
// The last answer of each is kept in localStorage too, and drawn straight away
// on the next visit, so the page has something to show before the network
// answers, and offline even where the service worker isn't running. Saved
// places are fetched in the background now and then, so they work offline too.
//
// Plain script, not a module, like everything under js/.

(function () {
  const W = window.UwuWx;
  const { hydrateIcons, openModal, closeModal, esc } = window.UwuUI;
  const Theme = window.UwuTheme;
  const Sync = window.UwuSync;
  const Charts = window.UwuCharts;
  const Map_ = window.UwuMap;
  const Alerts = window.UwuAlerts;
  const { t, onChange } = window.UwuI18n;

  const $ = (sel) => document.querySelector(sel);

  const VIEWS = ["now", "map", "forecast", "air"];
  const REFRESH_MS = 5 * 60 * 1000;
  const SG_TTL_MS = 60 * 1000;
  const DEFAULT_PLACE = { lat: 1.2899, lon: 103.8517, name: "Singapore, SG" };
  // How near a lightning strike must be to say so on the Now page.
  const LIGHTNING_NEAR_KM = 20;
  const LIGHTNING_RECENT_MS = 30 * 60 * 1000;

  let view = "now";
  let current = { ...DEFAULT_PLACE };
  let om = null;
  let air = null;
  let sg = null;
  let sgAt = 0;
  let lastLoad = 0;
  let loadFailed = false;
  let loading = 0;

  // ---------- theme (uwuapps-theme.md, section 6) ----------

  // The swatches, drawn again when the language changes.
  function renderSwatches() {
    $("#swatchGrid").innerHTML = Theme.COLOR_THEMES.map((theme) => {
      const label = esc(t(`theme.swatch.${theme.id}`));
      return `
        <button class="swatch" data-theme-id="${theme.id}" style="--swatch-color:${theme.hex}" type="button" aria-label="${label}">
          <span class="swatch-dot"></span>
          <span class="swatch-label">${label}</span>
        </button>`;
    }).join("");
  }

  function buildThemeModal() {
    const grid = $("#swatchGrid");
    renderSwatches();
    syncThemeModalState();

    grid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-theme-id]");
      if (!btn) return;
      Theme.applyColorTheme(btn.dataset.themeId);
      syncThemeModalState();
      repaintThemed();
    });

    $("#modeToggle").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mode]");
      if (!btn) return;
      Theme.applyMode(btn.dataset.mode);
      syncThemeModalState();
      repaintThemed();
    });

    // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
    // modal so the note and pressed state stay in step, and the charts and
    // share art, which bake their colours in.
    document.addEventListener("uwu:modechange", () => {
      syncThemeModalState();
      repaintThemed();
    });
  }

  function syncThemeModalState() {
    const activeTheme = Theme.getStoredColorTheme();
    const activePreference = Theme.getModePreference();
    const resolvedMode = Theme.getStoredMode();

    document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
      el.classList.toggle("active", el.dataset.themeId === activeTheme);
    });
    document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
      const isActive = el.dataset.mode === activePreference;
      el.classList.toggle("active", isActive);
      el.setAttribute("aria-pressed", String(isActive));
    });

    const note = $("#modeNote");
    if (note) {
      note.hidden = activePreference !== "time";
      if (activePreference === "time") {
        note.textContent = resolvedMode === "dark" ? t("theme.clock-note.dark") : t("theme.clock-note.light");
      }
    }

    updateThemeButtonIcon();
  }

  function updateThemeButtonIcon() {
    const span = $("#themeBtn [data-icon]");
    span.setAttribute("data-icon", Theme.getStoredMode() === "dark" ? "moon" : "sun");
    hydrateIcons($("#themeBtn"));
  }

  function repaintThemed() {
    Charts.redrawAll();
    if (om) updateShare();
  }

  function wireModals() {
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
    });
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach((m) => closeModal(m.id));
    });
    $("#themeBtn").addEventListener("click", () => openModal("themeModal"));
    $("#alertsBtn").addEventListener("click", () => {
      openModal("alertsModal");
      Alerts.refreshTelegram();
    });
    $("#shareBtn").addEventListener("click", () => {
      if (om) updateShare();
      openModal("shareModal");
    });
  }

  // ---------- pages and the tray (sg-psi's) ----------

  function showView(name, { focus = false } = {}) {
    if (!VIEWS.includes(name)) name = "now";
    const leaving = view;
    view = name;
    for (const v of VIEWS) {
      const tab = $(`#tab-${v}`);
      const on = v === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`#view-${v}`).hidden = !on;
      // The Map page fills the screen; style.css keys that off this class.
      document.body.classList.toggle(`view-${v}`, on);
    }
    if (focus) $(`#tab-${name}`).focus();
    if (name !== "map") window.scrollTo({ top: 0 });

    // The address stays plain. A hash only ever arrives from outside (a
    // notification, the manifest's shortcuts) to pick the first page, and is
    // cleared once it has.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);

    if (leaving === "map" && name !== "map") Map_.hide();
    if (name === "map") Map_.show();
    // Chart.js sizes a chart to its box, and a hidden page's box is empty.
    if (name === "forecast" && om) renderRainChart();
    if (name === "air" && om) renderUv();
  }

  // Keep in step with the head script in index.html, which reads it before paint.
  const TRAY_KEY = "uwuweather.trayOpen";

  // The tray to edge-tray-spec.md.
  function setTray(open, { save = true } = {}) {
    $("#tray").classList.toggle("collapsed", !open);
    $("#trayTab").setAttribute("aria-expanded", String(open));
    $("#trayTab").setAttribute("aria-label", open ? t("tray.tab.hide") : t("tray.tab.show"));
    // Off screen buttons must not take focus or clicks.
    $("#trayButtons").inert = !open;
    document.body.classList.toggle("tray-open", open);
    if (save) {
      try {
        localStorage.setItem(TRAY_KEY, open ? "1" : "0");
      } catch {
        // Remembered for this page view only.
      }
    }
  }

  function initTray() {
    let open = true;
    try {
      open = localStorage.getItem(TRAY_KEY) !== "0";
    } catch {}
    setTray(open, { save: false });
    // The head script drew a collapsed tray without transitions; from the next
    // frame on, toggles animate.
    requestAnimationFrame(() => document.documentElement.classList.remove("tray-start-collapsed"));
    $("#trayTab").addEventListener("click", () => setTray($("#tray").classList.contains("collapsed")));
  }

  function wireTabs() {
    const tabs = $(".tray-views");
    tabs.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-view]");
      if (tab) showView(tab.dataset.view);
    });
    // Arrow keys move between tabs, as a tab list should.
    tabs.addEventListener("keydown", (e) => {
      const i = VIEWS.indexOf(view);
      const next = { ArrowUp: i - 1, ArrowLeft: i - 1, ArrowDown: i + 1, ArrowRight: i + 1, Home: 0, End: VIEWS.length - 1 }[e.key];
      if (next == null) return;
      e.preventDefault();
      showView(VIEWS[(next + VIEWS.length) % VIEWS.length], { focus: true });
    });
    window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
  }

  // ---------- saved places ----------

  const loadSaved = () => Sync.readLocal();

  function saveSaved(list) {
    try {
      localStorage.setItem("uwuweather.saved", JSON.stringify(list));
    } catch {}
    renderSaved();
    Alerts.placesChanged();
    // Fire and forget. A failed push is corrected by the merge on next load,
    // so a flaky network never blocks a save.
    Sync.push(list);
  }

  const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

  // "My location" is stored in English, as a marker; it is shown in the reader's language.
  const MY_LOCATION = "My location";
  const placeName = (name) => (name === MY_LOCATION ? t("places.my-location") : name);

  // Country flags stay as emoji by design: they are data-derived, one per
  // country, so they cannot come from the fixed icon set.
  function flagFromLabel(label) {
    const m = label.match(/,\s*([A-Z]{2})$/);
    if (!m) return "";
    return [...m[1]].map((c) => String.fromCodePoint(0x1f1e6 + (c.charCodeAt(0) - 65))).join("");
  }

  function renderSaved() {
    const wrap = $("#saved");
    const list = loadSaved();
    wrap.innerHTML = list.map((it, i) => {
      const prefix = it.name === MY_LOCATION
        ? '<span data-icon="crosshair" aria-hidden="true"></span>'
        : flagFromLabel(it.name) || '<span data-icon="pin" aria-hidden="true"></span>';
      const here = samePlace(it, current) ? ' aria-current="true"' : "";
      const name = placeName(it.name);
      return `<span class="chip"${here}>
        <button type="button" data-go="${i}">${prefix} <span>${esc(name)}</span></button>
        <button type="button" data-remove="${i}" aria-label="${esc(t("places.remove.label", { name }))}" title="${esc(t("places.remove.title"))}"><span data-icon="close" aria-hidden="true"></span></button>
      </span>`;
    }).join("");
    hydrateIcons(wrap);
    const saved = list.some((it) => samePlace(it, current));
    $("#btn-save").setAttribute("aria-pressed", String(saved));
    $("#btn-save").setAttribute("aria-label", saved ? t("places.unsave.label") : t("places.save.label"));
    $("#btn-save").title = saved ? t("places.unsave.title") : t("places.save.label");
  }

  function wireSaved() {
    $("#saved").addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      const remove = e.target.closest("[data-remove]");
      const list = loadSaved();
      if (go) {
        const it = list[Number(go.dataset.go)];
        if (it) loadPlace(it.lat, it.lon, it.name);
      } else if (remove) {
        list.splice(Number(remove.dataset.remove), 1);
        saveSaved(list);
      }
    });
    $("#btn-save").addEventListener("click", () => {
      const list = loadSaved();
      const i = list.findIndex((it) => samePlace(it, current));
      if (i >= 0) list.splice(i, 1);
      else list.unshift({ name: current.name, lat: current.lat, lon: current.lon });
      saveSaved(list.slice(0, 24));
    });
  }

  // ---------- search, location, units ----------

  function parseQuery(q) {
    const parts = q.split(",").map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1] || "";
    return {
      name: parts[0] ?? "",
      admin1: parts.length >= 2 ? parts[1] : "",
      countryCode: /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : "",
    };
  }

  async function searchCity(q) {
    const { name, admin1, countryCode } = parseQuery(q);
    if (!name) return [];
    const params = new URLSearchParams({ name, count: "8", language: "en", format: "json" });
    if (countryCode) params.set("countryCode", countryCode);
    const res = await fetch(`/api/geocode?${params}`);
    if (!res.ok) return [];
    let results = (await res.json()).results || [];
    if (admin1) {
      const a1 = admin1.toLowerCase();
      const filtered = results.filter((r) => (r.admin1 || "").toLowerCase().startsWith(a1));
      if (filtered.length) results = filtered;
    }
    return results.map((r) => ({
      name: `${r.name}${r.admin1 ? `, ${r.admin1}` : ""}, ${r.country_code}`,
      lat: r.latitude,
      lon: r.longitude,
    }));
  }

  function wirePlaceBar() {
    $("#searchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#query").value.replace(/\s+/g, " ").trim();
      if (!q) return;
      const results = await searchCity(q);
      $("#suggestions").innerHTML = results.map((r) => `<option value="${esc(r.name)}"></option>`).join("");
      if (results[0]) {
        loadPlace(results[0].lat, results[0].lon, results[0].name);
        $("#query").blur();
      } else {
        status(() => t("search.no-match.error"), true);
      }
    });

    $("#btn-current").addEventListener("click", () => {
      if (!navigator.geolocation) return status(() => t("search.location.unsupported-error"), true);
      $("#btn-current").classList.add("busy");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          $("#btn-current").classList.remove("busy");
          loadPlace(pos.coords.latitude, pos.coords.longitude, MY_LOCATION);
        },
        (err) => {
          $("#btn-current").classList.remove("busy");
          status(() => ({
            1: t("search.location.blocked-error"),
            2: t("search.location.unavailable-error"),
            3: t("search.location.timeout-error"),
          }[err.code] || t("search.location.failed-error")), true);
        },
        { enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 }
      );
    });

    $("#btn-units").addEventListener("click", () => {
      W.setUnits(W.isImperial() ? "metric" : "imperial");
      updateUnitsLabel();
      Map_.redraw();
      load({ force: true });
    });
    updateUnitsLabel();
  }

  function updateUnitsLabel() {
    $("#units-label").textContent = W.tempUnit();
  }

  // ---------- loading ----------

  function loadPlace(lat, lon, name) {
    current = { lat, lon, name: name || current.name };
    try {
      localStorage.setItem("uwuweather.last", JSON.stringify(current));
    } catch {}
    om = null;
    air = null;
    renderSaved();
    Map_.setPlace(current);
    load();
  }

  // ---------- offline copies ----------
  // The last answer for each URL, with when it came. A handful of places'
  // worth; the oldest go first when there are too many or storage is full.

  const COPY_PREFIX = "uwuweather.copy.";
  const MAX_COPIES = 24;

  function copyKeys() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(COPY_PREFIX)) keys.push(k);
      }
    } catch {}
    return keys;
  }

  function pruneCopies(keep) {
    const aged = copyKeys().map((k) => {
      let at = 0;
      try {
        at = JSON.parse(localStorage.getItem(k))?.at || 0;
      } catch {}
      return [k, at];
    }).sort((a, b) => b[1] - a[1]);
    for (const [k] of aged.slice(keep)) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
  }

  function keepCopy(url, data) {
    const value = JSON.stringify({ at: Date.now(), data });
    try {
      localStorage.setItem(COPY_PREFIX + url, value);
    } catch {
      // Full: make room and try once more.
      pruneCopies(Math.floor(MAX_COPIES / 2));
      try {
        localStorage.setItem(COPY_PREFIX + url, value);
      } catch {}
    }
    if (copyKeys().length > MAX_COPIES) pruneCopies(MAX_COPIES);
  }

  function copyOf(url) {
    try {
      return JSON.parse(localStorage.getItem(COPY_PREFIX + url) || "null");
    } catch {
      return null;
    }
  }

  async function getJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${url.split("?")[0]} replied ${res.status}`);
    const data = await res.json();
    keepCopy(url, data);
    return data;
  }

  // The label's trailing country code, when it has one, names the country the
  // weather service and the air quality range come from. "My location" has
  // none, and the routes work it out.
  const countryOf = (place) => place.name?.match(/,\s*([A-Z]{2})$/)?.[1];

  function forecastUrl(place = current) {
    const params = new URLSearchParams({
      latitude: place.lat,
      longitude: place.lon,
      units: W.isImperial() ? "imperial" : "metric",
    });
    const country = countryOf(place);
    if (country) params.set("country", country);
    return `/api/forecast?${params}`;
  }

  function airUrl(place = current) {
    const params = new URLSearchParams({ latitude: place.lat, longitude: place.lon });
    const country = countryOf(place);
    if (country) params.set("country", country);
    return `/api/air?${params}`;
  }

  // NEA's bundle is the same for every place in Singapore, so it is kept a minute.
  async function loadSg({ force = false } = {}) {
    if (!W.inNeaRadar(current.lat, current.lon)) return null;
    if (sg && !force && Date.now() - sgAt < SG_TTL_MS) return sg;
    sg = await getJSON("/api/sg");
    sgAt = Date.now();
    Map_.setSg(sg);
    return sg;
  }

  // What was last seen for this place, drawn before the network answers.
  // `copyAt` says how old it is, for the status line.
  let copyAt = 0;

  function drawCopies() {
    const f = copyOf(forecastUrl());
    const a = copyOf(airUrl());
    const s = W.inNeaRadar(current.lat, current.lon) ? copyOf("/api/sg") : null;
    if (f && !om) {
      om = f.data;
      copyAt = f.at;
      W.setZone(om.timezone);
      Map_.setForecast(om);
    }
    if (a && !air) air = a.data;
    if (s && !sg) {
      sg = s.data;
      Map_.setSg(sg);
    }
    if (om) renderAll();
  }

  // ---------- saved places, ready for offline ----------
  // Every half hour at most, while online and idle, each saved place's weather
  // is fetched once, quietly: that leaves a copy here and in the service
  // worker's cache, so opening one later works without a connection.

  const PREFETCH_EVERY_MS = 30 * 60 * 1000;
  let prefetchedAt = 0;

  function prefetchSaved() {
    if (!navigator.onLine || Date.now() - prefetchedAt < PREFETCH_EVERY_MS) return;
    prefetchedAt = Date.now();
    const places = loadSaved().filter((p) => !samePlace(p, current)).slice(0, 12);
    const urls = places.flatMap((p) => [forecastUrl(p), airUrl(p)]);
    if (places.some((p) => W.inNeaRadar(p.lat, p.lon))) urls.push("/api/sg");
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    const next = () => {
      const url = urls.shift();
      // Done: every saved place now has a kept forecast, so the bell knows
      // each one's country.
      if (!url) return Alerts.redraw();
      if (!navigator.onLine) return;
      getJSON(url).catch(() => {}).finally(() => idle(next));
    };
    idle(next);
  }

  async function load({ force = false } = {}) {
    const ticket = ++loading;
    const place = { ...current };
    const stale = () => ticket !== loading || place.lat !== current.lat || place.lon !== current.lon;
    $("#refreshBtn").classList.add("busy");
    lastLoad = Date.now();
    // Last time's answer first, while this time's is on its way.
    drawCopies();
    if (!om) status(() => t("app.status.loading"));

    // Each source draws as soon as it lands; none waits on another.
    const forecast = getJSON(forecastUrl()).then((j) => {
      if (stale()) return;
      om = j;
      copyAt = 0;
      W.setZone(j.timezone);
      Map_.setForecast(om);
      renderAll();
      // This place's country is now known, which may bring the bell back.
      Alerts.redraw();
    });
    const nea = loadSg({ force }).then(() => !stale() && om && renderAll());
    const quality = getJSON(airUrl()).then((j) => {
      if (stale()) return;
      air = j;
      renderAir();
      renderNowAir();
    });

    const [f, n, q] = await Promise.allSettled([forecast, nea, quality]);
    if (stale()) return;
    if (f.status === "rejected") console.warn("forecast unavailable:", f.reason);
    if (n.status === "rejected") {
      console.warn("NEA unavailable:", n.reason);
      // Offline, NEA's last bundle is still the best there is; online, a
      // failure means NEA is down and the forecast should fill in.
      if (navigator.onLine) sg = null;
    }
    if (q.status === "rejected") {
      console.warn("air quality unavailable:", q.reason);
      // A kept copy stays on screen rather than a blank.
      if (!air) {
        renderAir();
        renderNowAir();
      }
    }
    loadFailed = f.status === "rejected";
    $("#refreshBtn").classList.remove("busy");
    if (om) renderAll();
    renderStatus();
    if (f.status === "fulfilled") prefetchSaved();
  }

  // ---------- status ----------

  // `make` builds the text, and is kept, so a change of language can say it again.
  let lastStatus = null;

  function status(make, bad = false) {
    lastStatus = { make, bad };
    $("#statusText").textContent = make();
    $("#status").dataset.tone = bad ? "bad" : "";
  }

  function renderStatus() {
    if (!om) {
      return status(() => (loadFailed ? t("app.status.load-error") : t("app.status.loading")), loadFailed);
    }
    status(statusLine, Boolean(copyAt && loadFailed));
  }

  function statusLine() {
    if (!om) return t("app.status.loading");
    // The reader's own clock: "updated" is about when they looked, not the place.
    const parts = [];
    const savedAt = copyAt || (om.stale ? om.savedAt : 0);
    if (copyAt && loadFailed) {
      parts.push(navigator.onLine
        ? t("app.status.server-copy-note", { when: W.when(copyAt, null) })
        : t("app.status.offline-copy-note", { when: W.when(copyAt, null) }));
    } else if (savedAt) {
      parts.push(t("app.status.updated-from-copy-note", { time: W.time(lastLoad, null), ago: W.ago(savedAt) }));
    } else {
      parts.push(t("app.status.updated-note", { time: W.time(lastLoad, null) }));
    }
    const standIn = FALLBACK_NAMES[om.source];
    if (standIn) parts.push(t("app.status.stand-in-note", { service: standIn }));
    if (W.inSingapore(current.lat, current.lon)) {
      if (!sg) parts.push(t("app.status.nea-down-note", { service: baseName() }));
      else if (["stations", "forecast2h"].some((k) => !sg[k])) parts.push(t("app.status.nea-partial-note", { service: baseName() }));
    }
    return parts.join(" ");
  }

  // The services that stand in for Open-Meteo, by the name /api/forecast gives them.
  const FALLBACK_NAMES = { weatherapi: "WeatherAPI.com", openweather: "OpenWeather", xweather: "Xweather" };
  const baseName = () => FALLBACK_NAMES[om?.source] || "Open-Meteo";

  // Who measured the air, by the name /api/air gives them.
  const AIR_NAMES = {
    nea: "NEA", nilu: "NILU", "met-norway": "MET Norway", eccc: "Environment Canada",
    waqi: "WAQI", "open-meteo": "Open-Meteo", ...FALLBACK_NAMES,
  };

  // ---------- helpers for NEA readings near the place ----------

  const inSg = () => W.inSingapore(current.lat, current.lon);

  // The nearest NEA station with a reading of one feed, or null outside
  // Singapore, or when the feed is missing.
  function nearest(feed) {
    const st = sg?.stations;
    if (!inSg() || !st?.[feed]) return null;
    return W.nearestStation(st.list, st[feed], current.lat, current.lon);
  }

  function nearestArea() {
    const f = sg?.forecast2h;
    if (!inSg() || !f) return null;
    let best = null;
    for (const a of f.areas) {
      const d = W.km(current.lat, current.lon, a.lat, a.lon);
      if (!best || d < best.km) best = { ...a, km: d };
    }
    return best;
  }

  const distance = (km) => (km < 1 ? t("now.distance.under-one-note") : t("now.distance.km-note", { km: Math.round(km) }));

  // The hourly index for the hour now, in the place's own time.
  function hourIndex() {
    const t = om?.hourly?.time || [];
    const now = Date.now() / 1000;
    let i = t.findIndex((x) => x > now) - 1;
    if (i < 0) i = 0;
    return i;
  }

  // ---------- Now ----------

  function renderAll() {
    renderNow();
    renderForecast();
    renderAir();
    renderSaved();
    renderStatus();
    updateShare();
  }

  // What the Now page shows, worked out once, for the page and the share card.
  function nowReadings() {
    const c = om?.current || {};
    const out = { sources: [] };

    const tp = nearest("temp");
    out.temp = tp ? W.fromC(tp.value) : c.temperature_2m;
    const h = nearest("humidity");
    out.humidity = h ? h.value : c.relative_humidity_2m;
    const ws = nearest("windSpeed");
    const wd = ws && sg.stations.windDir?.[ws.id];
    out.wind = ws ? W.fmtWind(W.fromKnots(ws.value), wd) : W.fmtWind(c.wind_speed_10m, c.wind_direction_10m);
    const r = nearest("rain");
    out.rain = r ? { mm: r.value, span: t("now.rain-span.last-5-min-note") } : { mm: c.precipitation, span: t("now.rain-span.last-15-min-note") };
    out.apparent = c.apparent_temperature;

    const area = nearestArea();
    out.summary = area ? W.neaText(area.text) : W.wmoText(c.weather_code);
    out.icon = area ? W.neaIcon(area.text) : W.wmoIcon(c.weather_code, c.is_day);

    out.notes = {
      temp: tp ? tp.name : "",
      humidity: h && h.id !== tp?.id ? h.name : "",
      wind: ws && ws.id !== tp?.id ? ws.name : "",
    };
    if (tp) out.sources.push(t("now.source.nea-temp-note", { station: tp.name, distance: distance(tp.km) }));
    if (area) out.sources.push(t("now.source.nea-area-note", { area: area.name }));
    out.neaUsed = Boolean(tp || area);
    return out;
  }

  function renderNow() {
    if (!om) return;
    const n = nowReadings();
    $("#place-label").textContent = placeName(current.name);
    $("#now-time").textContent = W.time(Date.now());
    $("#temp").textContent = W.fmtTemp(n.temp);
    $("#summary").textContent = n.summary;
    $("#icon").dataset.icon = n.icon;
    $("#icon").setAttribute("aria-label", n.summary);
    hydrateIcons($("#view-now"));

    $("#apparent").textContent = W.fmtTemp(n.apparent);
    $("#apparent-note").textContent = "";
    $("#humidity").textContent = W.fmtPerc(n.humidity);
    $("#humidity-note").textContent = n.notes.humidity;
    $("#wind").textContent = n.wind;
    $("#wind-note").textContent = n.notes.wind;
    $("#rain-now").textContent = W.fmtMM(n.rain.mm);
    $("#rain-note").textContent = n.rain.span;

    renderNowUv();
    renderNowAir();

    $("#now-source").textContent = nowSource(n);

    // NEA's 2-hour forecast for the area.
    const area = nearestArea();
    $("#nowcast-card").hidden = !area;
    if (area) {
      $("#nowcast-text").textContent = W.neaText(area.text);
      $("#nowcast-icon").dataset.icon = W.neaIcon(area.text);
      $("#nowcast-area").textContent = t("now.nowcast.area-note", { area: area.name });
      $("#nowcast-valid").textContent = sg.forecast2h.valid?.text || "";
      hydrateIcons($("#nowcast-card"));
    }

    renderNowLightning();
    renderWarnings();
    renderSea();
  }

  // Where the Now page's numbers came from, in one line.
  function nowSource(n) {
    const base = baseName();
    if (n.sources.length) return t("now.source.nea-note", { sources: n.sources.join("; "), base });
    const nat = om.national;
    if (!nat?.used?.includes("current")) {
      return nat?.used?.length ? t("now.source.base-national-note", { base, national: nat.name }) : t("now.source.base-note", { base });
    }
    const away = nat.stationLat != null ? distance(W.km(current.lat, current.lon, nat.stationLat, nat.stationLon)) : nat.stationKm != null ? distance(nat.stationKm) : "";
    // A station passed on by MeteoGate is named as such, not as the forecaster's.
    let where = !nat.station ? nat.name
      : nat.stationBy || nat.source === "meteogate" ? t("now.source.meteogate-station-note", { station: nat.station })
      : t("now.source.national-station-note", { national: nat.name, station: nat.station });
    if (nat.station && away) where = t("now.source.station-distance-note", { station: where, distance: away });
    const forecast = nat.used.some((u) => u !== "current")
      ? t("now.source.forecast-both-note", { national: nat.name, base })
      : t("now.source.forecast-base-note", { base });
    return t("now.source.station-note", { where, forecast });
  }

  // Warnings in force, from the national service or the stand-in.
  function renderWarnings() {
    const list = (om?.alerts || []).filter((a) => !a.until || Date.parse(a.until) > Date.now());
    $("#warnings-card").hidden = !list.length;
    if (!list.length) return;
    $("#warnings-title").textContent = t("now.warnings.title", { count: list.length });
    $("#warnings").innerHTML = list.map((a) => {
      const until = a.until && Date.parse(a.until) ? t("now.warnings.until-note", { when: W.when(Date.parse(a.until)) }) : "";
      const from = a.from && Date.parse(a.from) > Date.now() ? t("now.warnings.from-note", { when: W.when(Date.parse(a.from)) }) : "";
      const when = [from, until, a.source].filter(Boolean).join(" · ");
      const more = a.text || a.url
        ? `<details><summary>${esc(t("now.warnings.details.label"))}</summary>${a.text ? `<p>${esc(a.text)}</p>` : ""}${a.url ? `<p><a class="link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(t("now.warnings.full.link"))}</a></p>` : ""}</details>`
        : "";
      return `<li><span class="warning-title">${esc(a.title)}</span><span class="warning-when">${esc(when)}</span>${more}</li>`;
    }).join("");
  }

  // Wave heights in metres, or feet for imperial.
  const fmtWave = (m) => (m == null || !Number.isFinite(m) ? "--" : W.isImperial() ? `${(m * 3.28084).toFixed(1)} ft` : `${m.toFixed(1)} m`);

  function renderSea() {
    const s = om?.marine;
    $("#sea-card").hidden = !s || s.waveHeight == null;
    if (!s || s.waveHeight == null) return;
    $("#sea-waves").textContent = fmtWave(s.waveHeight);
    $("#sea-waves-note").textContent = s.waveDirection == null ? "" : t("now.sea.from-note", { direction: W.compass(s.waveDirection) });
    $("#sea-period").textContent = s.wavePeriod == null ? "--" : `${Math.round(s.wavePeriod)} s`;
    $("#sea-temp").textContent = W.fmtTemp(s.seaTemperature);
    // Lakes have waves in the model but no surface temperature.
    $("#sea-temp").parentElement.hidden = s.seaTemperature == null;
    $("#sea-time").textContent = W.time(Date.now());
    // The highest waves in the next 24 hours.
    const now = Date.now() / 1000;
    const ahead = (s.hourly || []).filter((h) => h.t >= now && h.t < now + 86400 && Number.isFinite(h.waveHeight));
    const peak = ahead.reduce((best, h) => (!best || h.waveHeight > best.waveHeight ? h : best), null);
    // A current's direction is the way it flows, unlike the wind's.
    const speed = { speed: Math.round(s.currentSpeed), unit: W.windUnit() };
    const currentNote = !(Number.isFinite(s.currentSpeed) && s.currentSpeed >= 0.5) ? ""
      : s.currentDirection == null ? t("now.sea.current-note", speed)
      : t("now.sea.current-towards-note", { ...speed, direction: W.compass(s.currentDirection) });
    const peakNote = peak ? t("now.sea.outlook-note", { height: fmtWave(peak.waveHeight), time: W.time(peak.t * 1000) }) : "";
    $("#sea-outlook").textContent = [peakNote, currentNote].filter(Boolean).join(" ");
  }

  function renderNowLightning() {
    const strikes = (inSg() && sg?.lightning?.strikes) || [];
    let near = null;
    for (const s of strikes) {
      if (Date.now() - Date.parse(s.t) > LIGHTNING_RECENT_MS) continue;
      const d = W.km(current.lat, current.lon, s.lat, s.lon);
      if (d <= LIGHTNING_NEAR_KM && (!near || d < near.km)) near = { ...s, km: d };
    }
    // Canada's grid counts flashes in each ten minutes, and comes with the forecast.
    const grid = !inSg() && om?.lightning;
    if (!near && grid && Date.now() - Date.parse(grid.t) < LIGHTNING_RECENT_MS) near = { ...grid, type: "grid" };
    $("#lightning-card").hidden = !near;
    if (!near) return;
    const time = W.time(Date.parse(near.t));
    const what = near.type === "grid" ? t("now.lightning.grid-note", { time })
      : near.type === "ground" ? t("now.lightning.ground-note", { time })
      : t("now.lightning.cloud-note", { time });
    $("#lightning-title").textContent = t("now.lightning.title", { distance: distance(near.km) });
    $("#lightning-text").textContent = t("now.lightning.advice-note", { what });
  }

  // NEA's last hourly UV reading while it is fresh (it stops at 7pm), else Open-Meteo's for the hour.
  function uvNow() {
    const hours = inSg() && sg?.uv?.hours;
    const last = hours?.[hours.length - 1];
    if (last && Date.now() - Date.parse(last.t) < 2 * 3600 * 1000) return { value: last.value, source: "nea" };
    const v = om?.hourly?.uv_index?.[hourIndex()];
    return Number.isFinite(v) ? { value: v, source: "open-meteo" } : null;
  }

  function renderNowUv() {
    const uv = uvNow();
    const band = W.uvBand(uv?.value);
    $("#uv-now").textContent = uv ? String(Math.round(uv.value)) : "--";
    $("#uv-now").dataset.level = band?.level ?? "";
    $("#uv-now-band").textContent = band?.label ?? "";
  }

  function renderNowAir() {
    const region = air?.region;
    const shown = region || air;
    const wide = air && air.area !== "here" ? air.area : "";
    $("#aqi").textContent = shown ? `${W.fmtRange(shown)} ${air.index}` : "--";
    $("#aqi").dataset.level = shown?.level ?? "";
    // A region by name ("Air quality, East"); a station's name is too long for the tile.
    $("#aqi-label").textContent = region && air.regionKind !== "station"
      ? t("now.air.region-label", { region: W.cap(region.name) })
      : t("now.air.label");
    $("#aqi-band").textContent = shown ? shown.band : "";
  }

  // ---------- Forecast ----------

  function renderForecast() {
    if (!om) return;
    if (view === "forecast") renderRainChart();
    renderHourly();
    renderNea24();
    renderDaily();
    renderHistory();
  }

  // The nearest gauge's daily totals. Hydrology loads once a day, so the newest
  // day is usually yesterday, and the card says whose gauge and how far.
  function renderHistory() {
    const h = om?.history;
    $("#history-card").hidden = !h?.days?.length;
    if (!h?.days?.length) return;
    const most = Math.max(...h.days.map((d) => d.mm), 1);
    const total = h.days.reduce((sum, d) => sum + d.mm, 0);
    const fmtMm = (mm) => (W.isImperial() ? `${(mm / 25.4).toFixed(2)} in` : W.fmtMM(mm));
    $("#history-total").textContent = t("forecast.history.total-note", { amount: fmtMm(total), count: h.days.length });
    $("#history").innerHTML = h.days.map((d) => {
      const when = Date.parse(`${d.date}T12:00:00Z`);
      return `<li>
        <span class="muted">${esc(W.weekday(when, "UTC"))} ${esc(W.dayLabel(when, "UTC").replace(/^\w+,?\s*/, ""))}</span>
        <span class="history-bar${d.mm > 0 ? "" : " dry"}" style="width:${Math.max(2, Math.round((d.mm / most) * 100))}%"></span>
        <span class="history-mm">${d.mm > 0 ? fmtMm(d.mm) : esc(t("forecast.history.dry-label"))}</span>
      </li>`;
    }).join("");
    $("#history-source").textContent = t("forecast.history.source-note", { station: h.station, distance: distance(h.km) });
  }

  function rainPoints() {
    const t = om.minutely_15?.time || [];
    const p = om.minutely_15?.precipitation || [];
    const from = Date.now() / 1000 - 15 * 60;
    const out = [];
    for (let i = 0; i < t.length && out.length < 8; i++) {
      if (t[i] < from) continue;
      out.push({ t: t[i] * 1000, label: W.time(t[i] * 1000), mm: p[i] ?? 0 });
    }
    return out;
  }

  function renderRainChart() {
    const points = rainPoints();
    if (!points.length) {
      $("#rain-summary").textContent = t("forecast.rain.empty");
      $("#rain-range").textContent = "";
      return;
    }
    const chart = Charts.rain($("#rainChart"), points);
    // The chart's label is js/charts.js's "chart.rain.label" around the summary; keep the summary.
    const label = chart.canvas.getAttribute("aria-label");
    const [before, after = ""] = t("chart.rain.label", { summary: "\u0000" }).split("\u0000");
    $("#rain-summary").textContent = label.startsWith(before) && label.endsWith(after)
      ? label.slice(before.length, label.length - after.length)
      : label;
    $("#rain-range").textContent = t("forecast.rain.range-note", { from: points[0].label, to: W.time(points[points.length - 1].t + 15 * 60 * 1000) });
  }

  function renderHourly() {
    const h = om.hourly || {};
    const times = h.time || [];
    const start = hourIndex();
    const cells = [];
    for (let i = start; i < times.length && cells.length < 24; i++) {
      const prob = h.precipitation_probability?.[i];
      cells.push(`
        <div class="pill">
          <div class="muted">${i === start ? esc(t("forecast.hourly.now-label")) : W.time(times[i] * 1000)}</div>
          <span class="wx-icon" data-icon="${W.wmoIcon(h.weather_code?.[i], h.is_day?.[i])}" role="img" aria-label="${esc(W.wmoText(h.weather_code?.[i]))}"></span>
          <div class="pill-temp">${W.fmtDeg(h.temperature_2m?.[i])}</div>
          <div class="wx-line"><span data-icon="droplet" aria-hidden="true"></span>${prob == null ? "--" : `${prob}%`}</div>
        </div>`);
    }
    $("#hourly").innerHTML = cells.join("");
    hydrateIcons($("#hourly"));
  }

  function renderNea24() {
    const f = inSg() && sg?.forecast24h;
    $("#nea24-card").hidden = !f;
    if (!f) return;
    const region = W.regionOf(current.lat, current.lon);
    $("#nea24-title").textContent = t("forecast.nea24.title", { region: W.cap(region) });
    $("#nea24-time").textContent = t("forecast.nea24.time-note", { time: W.time(Date.parse(f.time), "Asia/Singapore") });
    const temps = f.temp || {};
    const hum = f.humidity || {};
    const lowC = W.fromC(temps.low);
    const highC = W.fromC(temps.high);
    $("#nea24-general").textContent = t("forecast.nea24.general-note", {
      text: W.neaText(f.text),
      low: W.fmtDeg(lowC),
      high: W.fmtDeg(highC),
      humidityLow: hum.low ?? "--",
      humidityHigh: hum.high ?? "--",
      windDir: f.wind?.dir || "",
      windLow: Math.round(W.fromKmh(f.wind?.low) ?? 0),
      windHigh: Math.round(W.fromKmh(f.wind?.high) ?? 0),
      unit: W.windUnit(),
    });
    $("#nea24-periods").innerHTML = f.periods.map((p) => {
      const text = p.regions?.[region] || Object.values(p.regions || {})[0];
      return `<li>
        <span class="wx-icon" data-icon="${W.neaIcon(text)}" aria-hidden="true"></span>
        <span class="period-when">${esc(p.label || "")}</span>
        <span class="period-text">${esc(W.neaText(text))}</span>
      </li>`;
    }).join("");
    hydrateIcons($("#nea24-periods"));
  }

  function renderDaily() {
    const d = om.daily || {};
    const rows = [];
    const neaDays = (inSg() && sg?.outlook4d?.days) || [];
    const covered = new Set();

    for (const day of neaDays) {
      const key = W.dateKey(Date.parse(day.date), "Asia/Singapore");
      covered.add(key);
      rows.push(dayRow({
        when: Date.parse(day.date),
        zone: "Asia/Singapore",
        icon: W.neaIcon(day.text),
        text: day.summary || W.neaText(day.text),
        low: W.fromC(day.low),
        high: W.fromC(day.high),
        extra: day.wind?.dir ? t("forecast.daily.wind-note", {
          dir: day.wind.dir,
          low: Math.round(W.fromKmh(day.wind.low) ?? 0),
          high: Math.round(W.fromKmh(day.wind.high) ?? 0),
          unit: W.windUnit(),
        }) : "",
        source: "NEA",
      }));
    }
    (d.time || []).forEach((ts, i) => {
      const key = W.dateKey(ts * 1000);
      // Today is always Open-Meteo's: NEA's outlook starts tomorrow.
      if (covered.has(key)) return;
      const prob = d.precipitation_probability_max?.[i];
      rows.push(dayRow({
        when: ts * 1000,
        icon: W.wmoIcon(d.weather_code?.[i]),
        text: W.wmoText(d.weather_code?.[i]),
        low: d.temperature_2m_min?.[i],
        high: d.temperature_2m_max?.[i],
        extra: t("forecast.daily.rain-note", { chance: prob == null ? "--" : `${prob}%`, amount: W.fmtMM(d.precipitation_sum?.[i] ?? 0) }),
        source: neaDays.length ? baseName() : "",
      }));
    });
    rows.sort((a, b) => a.when - b.when);
    $("#daily").innerHTML = rows.map((r) => r.html).join("");
    const nat = om.national?.used?.includes("daily") ? om.national.name.replace(/^the /, "") : "";
    $("#daily-source").textContent = neaDays.length ? t("forecast.daily.source-nea-note", { base: baseName() })
      : nat ? t("forecast.daily.source-national-note", { national: nat, base: baseName() })
      : baseName();
    hydrateIcons($("#daily"));
  }

  function dayRow({ when, zone, icon, text, low, high, extra, source }) {
    const today = W.dateKey(when, zone) === W.dateKey(Date.now(), zone);
    return {
      when,
      html: `<li>
        <span class="day-name">${esc(today ? t("forecast.daily.today-label") : W.weekday(when, zone))}<small>${esc(W.dayLabel(when, zone).replace(/^\w+,?\s*/, ""))}</small></span>
        <span class="wx-icon" data-icon="${icon}" aria-hidden="true"></span>
        <span class="day-text">${esc(text)}<small>${esc(extra)}${source ? ` · ${source}` : ""}</small></span>
        <span class="day-temps"><strong>${W.fmtDeg(high)}</strong> <span class="muted">${W.fmtDeg(low)}</span></span>
      </li>`,
    };
  }

  // ---------- Air & heat ----------

  const dot = (level) => `<span class="band-dot" data-level="${level ?? ""}"></span>`;

  function chip(el, label, level) {
    el.hidden = !label;
    if (label) el.innerHTML = `${dot(level)}${esc(label)}`;
  }

  function renderAir() {
    // Air quality
    if (!air) {
      $("#air-range").textContent = "--";
      $("#air-index").textContent = "";
      chip($("#air-band"), null);
      $("#air-note").textContent = t("air.quality.empty");
      $("#air-pm25").textContent = "--";
      $("#air-pm25-row").hidden = false;
      $("#air-regions").innerHTML = "";
      $("#air-pollutants-box").hidden = true;
      $("#air-time").textContent = "";
      $("#air-source").textContent = "";
    } else {
      const region = air.region;
      const shown = region || air;
      const stations = air.regionKind === "station";
      $("#air-title").textContent = AIR_TITLES[air.index]?.() || t("air.quality.index-title", { index: air.index });
      $("#air-range").textContent = W.fmtRange(shown);
      $("#air-index").textContent = air.index;
      chip($("#air-band"), shown.band, shown.level);
      $("#air-note").textContent = airNote(region, stations);
      // Canada's AQHI comes without PM2.5, so the line goes rather than reading "--".
      $("#air-pm25-row").hidden = !shown.pm25 && !air.pm25;
      $("#air-pm25").textContent = W.fmtRange(shown.pm25 || air.pm25);
      // NEA's time carries +08:00; Open-Meteo's is UTC with no zone on it.
      const stamp = air.time && (/[zZ]|[+-]\d\d:?\d\d$/.test(air.time) ? air.time : `${air.time}Z`);
      $("#air-time").textContent = stamp ? W.when(Date.parse(stamp)) : "";
      $("#air-regions").innerHTML = (air.regions || []).map((r) => `
        <li${region && r.name === region.name ? ' aria-current="true"' : ""}>
          <span class="region-name">${esc(stations ? r.name : W.cap(r.name))}</span>
          <span>${dot(r.level)}${W.fmtRange(r)}</span>
          <span class="muted">${esc(r.band)}</span>
        </li>`).join("");

      // NEA's pollutants behind the PSI, for the place's region.
      const pollutants = air.pollutants || [];
      $("#air-pollutants-box").hidden = !pollutants.length;
      $("#air-pollutants-title").textContent = region
        ? t("air.pollutants.region-title", { region: W.cap(region.name) })
        : t("air.pollutants.title");
      $("#air-pollutants").innerHTML = pollutants.map((p) => `
        <li>
          <span class="region-name">${esc(p.name)}</span>
          <span class="ink">${esc(String(p.value))} ${esc(p.unit)}</span>
          <span class="muted">${esc(p.period)}</span>
        </li>`).join("");
      $("#air-source").textContent = AIR_SOURCES[air.source]?.() || t("air.source.other-note", { name: AIR_NAMES[air.source] || air.source });
    }

    if (!om) return;
    renderUv();
    renderHeat();
  }

  // Looked up when drawn, so they follow the language.
  const AIR_TITLES = {
    PSI: () => t("air.quality.psi-title"),
    "US AQI": () => t("air.quality.us-aqi-title"),
    AQHI: () => t("air.quality.aqhi-title"),
    AQI: () => t("air.quality.norway-title"),
  };

  const AIR_SOURCES = {
    nea: () => t("air.source.nea-note"),
    nilu: () => t("air.source.nilu-note"),
    "met-norway": () => t("air.source.met-norway-note"),
    eccc: () => t("air.source.eccc-note"),
    waqi: () => t("air.source.waqi-note"),
    "open-meteo": () => t("air.source.open-meteo-note"),
  };

  function airNote(region, stations) {
    const range = W.fmtRange(air);
    if (stations) {
      return air.area === "nearby"
        ? t("air.note.nearest-station-note", { station: region.name, range })
        : region ? t("air.note.station-note", { station: region.name }) : t("air.note.here-note");
    }
    if (region) {
      return air.area === "islandwide"
        ? t("air.note.region-islandwide-note", { region: region.name, range })
        : t("air.note.region-countrywide-note", { region: region.name, range });
    }
    if (air.area === "here") {
      return FALLBACK_NAMES[air.source] ? t("air.note.stand-in-note", { service: FALLBACK_NAMES[air.source] }) : t("air.note.here-note");
    }
    return t("air.note.range-note", { area: air.area });
  }

  function renderUv() {
    const uv = uvNow();
    const band = W.uvBand(uv?.value);
    $("#uv-value").textContent = uv ? String(Math.round(uv.value)) : "--";
    chip($("#uv-band"), band?.label, band?.level);
    $("#uv-advice").textContent = band ? W.UV_ADVICE[band.label] : "";
    $("#uv-source").textContent = uv?.source === "nea" ? t("air.uv.source-nea-note") : t("air.uv.source-open-meteo-note");
    $("#uv-time").textContent = W.time(Date.now());

    // Today's daylight hours: NEA's readings so far, Open-Meteo's for the rest.
    const h = om.hourly || {};
    const today = W.dateKey(Date.now());
    const neaHours = (inSg() && sg?.uv?.hours) || [];
    const neaByHour = new Map(neaHours.map((x) => [Math.floor(Date.parse(x.t) / 3600000), x.value]));
    const hours = [];
    (h.time || []).forEach((ts, i) => {
      if (W.dateKey(ts * 1000) !== today) return;
      const v = neaByHour.get(Math.floor(ts / 3600)) ?? h.uv_index?.[i];
      if (!Number.isFinite(v)) return;
      const hourOfDay = Number(new Intl.DateTimeFormat("en-GB", { timeZone: W.getZone(), hour: "numeric", hourCycle: "h23" }).format(new Date(ts * 1000)));
      if (hourOfDay < 7 || hourOfDay > 19) return;
      hours.push({ label: W.time(ts * 1000), value: v, band: W.uvBand(v) });
    });
    if (view === "air" && hours.length) Charts.uv($("#uvChart"), hours);
  }

  function renderHeat() {
    const w = inSg() && sg?.wbgt;
    $("#heat-sg").hidden = !w;
    $("#heat-elsewhere").hidden = Boolean(w);
    if (!w) {
      // No WBGT to show: the feels like temperature, big, in its place.
      const c = om?.current || {};
      $("#heat-feels").textContent = W.fmtTemp(c.apparent_temperature);
      $("#heat-feels-note").textContent = Number.isFinite(c.temperature_2m)
        ? t("air.heat.feels-like-note", { temp: W.fmtTemp(c.temperature_2m), humidity: W.fmtPerc(c.relative_humidity_2m), source: feelsLikeSource() })
        : "";
      $("#heat-time").textContent = W.time(Date.now());
      return;
    }
    const ranked = w.stations
      .map((s) => ({ ...s, km: W.km(current.lat, current.lon, s.lat, s.lon) }))
      .sort((a, b) => a.km - b.km);
    const near = ranked[0];
    const level = W.HEAT_LEVELS[near.stress] ?? "";
    // WBGT stays in Celsius: NEA's bands are set in it.
    $("#heat-value").textContent = near.wbgt.toFixed(1);
    chip($("#heat-band"), near.stress ? t("air.heat.stress-label", { level: near.stress }) : null, level);
    $("#heat-advice").textContent = W.HEAT_ADVICE[near.stress] || "";
    $("#heat-station").textContent = t("air.heat.station-note", { station: near.name, distance: distance(near.km) });
    $("#heat-time").textContent = t("air.heat.time-note", { time: W.time(Date.parse(w.time), "Asia/Singapore") });
    $("#heat-list").innerHTML = ranked.slice(1, 6).map((s) => `
      <li>
        <span class="region-name">${esc(s.town || s.name)}</span>
        <span>${dot(W.HEAT_LEVELS[s.stress])}${s.wbgt.toFixed(1)}°C</span>
        <span class="muted">${esc(s.stress || "")}</span>
      </li>`).join("");
  }

  // The NWS and MSC give a heat index, humidex or wind chill of their own;
  // otherwise it is the base forecast's.
  function feelsLikeSource() {
    const nat = om?.national;
    if (nat && ["nws", "eccc"].includes(nat.source) && nat.used?.includes("current")) return nat.name;
    return baseName();
  }

  // ---------- share ----------

  function weatherSVG(icon) {
    // html2canvas rasterises this node, so the colours are resolved here rather
    // than left to inherit from a custom property. The art sits on a brand tint,
    // so it strokes in --on-brand.
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--on-brand").trim();
    const svg = window.UwuIcons.icon(icon) || window.UwuIcons.icon("clear");
    return svg.replace(/currentColor/g, ink).replace(/stroke-width="1.8"/, 'stroke-width="1.4"');
  }

  const NATIONAL_SHORT = {
    nws: "NWS", "met-norway": "MET Norway", eccc: "Environment Canada", dwd: "DWD", "environment-agency": "Environment Agency",
    seniverse: "Seniverse", "met-eireann": "Met Éireann", meteoswiss: "MeteoSwiss", meteogate: "MeteoGate",
  };

  function buildShareURL() {
    if (!current.name || current.name === MY_LOCATION) return location.origin;
    const params = new URLSearchParams({ q: current.name });
    return `${location.origin}/?${params}`;
  }

  function updateShare() {
    if (!om) return;
    const n = nowReadings();
    $("#share-place").textContent = placeName(current.name);
    $("#share-temp").textContent = W.fmtTemp(n.temp);
    $("#share-summary").textContent = n.summary;
    const shown = air?.region || air;
    $("#share-extra").textContent = [
      W.fmtPerc(n.humidity),
      n.wind,
      shown && `${air.index} ${W.fmtRange(shown)}`,
    ].filter(Boolean).join(" · ");
    const credits = new Set();
    if (n.neaUsed || air?.source === "nea") credits.add("NEA");
    if (om.national?.used?.length) credits.add(NATIONAL_SHORT[om.national.source] || om.national.name);
    if (om.national?.stationBy) credits.add(om.national.stationBy);
    if (air && AIR_NAMES[air.source] && air.source !== "open-meteo") credits.add(AIR_NAMES[air.source]);
    credits.add(baseName());
    $("#share-source").textContent = t("share.card.data-note", { sources: [...credits].join(", ") });
    $("#share-time").textContent = `${W.dayLabel(Date.now())}, ${W.time(Date.now())}`;
    $("#share-art").innerHTML = weatherSVG(n.icon);
  }

  async function saveShareImage() {
    const node = $("#share-card");
    const canvas = await window.html2canvas(node, { backgroundColor: null, scale: 2 });
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `UwU-Weather-${current.name.replace(/\W+/g, "_")}.png`;
    a.click();
    URL.revokeObjectURL(url);
    return blob;
  }

  function shareText() {
    return t("share.message.text", { temp: $("#share-temp").textContent, summary: $("#share-summary").textContent, place: placeName(current.name) });
  }

  function wireShare() {
    $("#save-image").addEventListener("click", saveShareImage);
    $("#share-device").addEventListener("click", async () => {
      try {
        const blob = await saveShareImage();
        const file = new File([blob], "uwuweather.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ title: t("share.message.title", { place: placeName(current.name) }), text: shareText(), files: [file] });
        } else if (navigator.share) {
          await navigator.share({ title: t("share.message.title", { place: placeName(current.name) }), text: shareText(), url: buildShareURL() });
        }
      } catch (err) {
        // Cancelling the share sheet lands here too; the image is saved either way.
        console.warn(err);
      }
    });
    document.querySelectorAll("[data-share]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = encodeURIComponent(shareText());
        const url = encodeURIComponent(buildShareURL());
        const links = {
          tg: `https://t.me/share/url?url=${url}&text=${text}`,
          x: `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
          wa: `https://wa.me/?text=${text}%20${url}`,
          fb: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
        };
        if (links[btn.dataset.share]) window.open(links[btn.dataset.share], "_blank", "noopener");
      });
    });
  }

  // ---------- sync panel ----------

  // `make` builds the text, and is kept, so a change of language can say it again.
  // Errors from js/sync.js come as text already, and are kept as they came.
  let lastSyncMessage = null;

  function syncMessage(make, tone = "good") {
    lastSyncMessage = { make, tone };
    const text = typeof make === "function" ? make() : make;
    const el = $("#sync-message");
    el.textContent = text || "";
    el.dataset.tone = tone;
    el.hidden = !text;
  }

  // Until the first answer, the panel's own "Checking" line stays.
  let syncShown = false;

  function renderSyncState() {
    syncShown = true;
    const { linked, username, backupCodesLeft } = Sync.state;
    $("#sync-status").textContent = linked
      ? (username
        ? t("sync.panel.linked-user-note", { username })
        : t("sync.panel.linked-note"))
      : t("sync.panel.not-linked-note");
    $("#sync-setup").hidden = linked;
    $("#sync-linked").hidden = !linked;
    $("#sync-backup-status").textContent = backupCodesLeft
      ? t("sync.panel.backup-left-note", { count: backupCodesLeft })
      : t("sync.panel.backup-none-note");
  }

  // Codes are put in the DOM and nowhere else. They are never written to
  // storage, so closing the panel or reloading is enough to be rid of them.
  function showBackupCodes(codes) {
    $("#sync-code-list").innerHTML = codes.map((c) => `<li>${esc(c)}</li>`).join("");
    $("#sync-codes").hidden = false;
  }

  function hideBackupCodes() {
    $("#sync-code-list").innerHTML = "";
    $("#sync-codes").hidden = true;
  }

  function linkedNow() {
    renderSyncState();
    renderSaved();
    Alerts.placesChanged();
  }

  async function onSyncSettled(state) {
    if (await Sync.settle(state)) {
      linkedNow();
      syncMessage(() => t("sync.panel.linked-message"));
      return;
    }
    syncMessage(() => (state === "denied" ? t("sync.panel.link-denied-error") : t("sync.panel.link-expired-error")), "bad");
  }

  async function onBackupSettled(state, id) {
    if (state !== "approved") {
      syncMessage(() => (state === "rejected" ? t("sync.panel.codes-denied-error") : t("sync.panel.codes-expired-error")), "bad");
      return;
    }
    const res = await Sync.collectBackupCodes(id);
    if (res.error) return syncMessage(res.error, "bad");
    showBackupCodes(res.codes);
    renderSyncState();
    syncMessage(() => t("sync.panel.codes-approved-message"));
  }

  function wireSync() {
    $("#syncBtn").addEventListener("click", async () => {
      openModal("syncModal");
      syncMessage("");
      hideBackupCodes();
      await Sync.refresh();
      renderSyncState();
    });

    $("#sync-backup-new").addEventListener("click", async () => {
      hideBackupCodes();
      syncMessage(() => t("sync.panel.codes-asking-message"));
      const res = await Sync.requestBackupCodes(onBackupSettled);
      if (res.error) syncMessage(res.error, "bad");
    });

    $("#sync-copy-codes").addEventListener("click", async () => {
      const codes = [...$("#sync-code-list").children].map((li) => li.textContent);
      try {
        await navigator.clipboard.writeText(codes.join("\n"));
        syncMessage(() => t("sync.panel.codes-copied-message"));
      } catch {
        syncMessage(() => t("sync.panel.codes-copy-error"), "bad");
      }
    });

    $("#sync-open-telegram").addEventListener("click", async () => {
      syncMessage(() => t("sync.panel.opening-telegram-message"));
      const res = await Sync.startDeepLink(onSyncSettled);
      if (res.error) syncMessage(res.error, "bad");
    });

    $("#sync-use-code").addEventListener("click", async () => {
      const field = $("#sync-code");
      if (!field.value.trim()) return;
      syncMessage(() => t("sync.panel.checking-code-message"));
      const res = await Sync.useCode(field.value);
      if (res.error) return syncMessage(res.error, "bad");
      field.value = "";
      linkedNow();
      syncMessage(() => (res.backup_codes_left === undefined
        ? t("sync.panel.linked-message")
        : t("sync.panel.linked-backup-message", { count: res.backup_codes_left })));
    });

    $("#sync-unlink").addEventListener("click", async () => {
      await Sync.unlink();
      renderSyncState();
      Alerts.refreshTelegram();
      syncMessage(() => t("sync.panel.unlinked-message"));
    });

    $("#sync-code").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#sync-use-code").click();
    });

    // A merge brought places in from the bot.
    Sync.onChange(() => {
      renderSaved();
      Alerts.placesChanged();
    });
  }

  // ---------- refreshing ----------

  function wireRefresh() {
    $("#refreshBtn").addEventListener("click", () => {
      load({ force: true });
      if (view === "map") Map_.refresh();
    });
    setInterval(() => {
      if (document.visibilityState === "visible") load({ force: true });
    }, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastLoad > 60 * 1000) load({ force: true });
    });
    window.addEventListener("online", () => load({ force: true }));
  }

  // ---------- language ----------

  // A new language redraws everything this file wrote, from what it last drew;
  // nothing is fetched again. The markup's own text is i18n's to redo.
  function wireLanguage() {
    onChange(() => {
      const said = lastStatus;
      setTray(!$("#tray").classList.contains("collapsed"), { save: false });
      renderSwatches();
      syncThemeModalState();
      if (om) {
        renderAll();
      } else {
        renderAir();
        renderNowAir();
        renderSaved();
      }
      if (syncShown) renderSyncState();
      if (lastSyncMessage) syncMessage(lastSyncMessage.make, lastSyncMessage.tone);
      // Whatever the status line said last, said again: an error from a search stays put.
      if (said) status(said.make, said.bad);
    });
  }

  // ---------- boot ----------

  async function firstPlace() {
    const q = new URLSearchParams(location.search).get("q");
    if (q) {
      const results = await searchCity(q.trim()).catch(() => []);
      if (results[0]) {
        $("#query").value = results[0].name;
        return results[0];
      }
    }
    try {
      const last = JSON.parse(localStorage.getItem("uwuweather.last") || "null");
      if (Number.isFinite(last?.lat) && Number.isFinite(last?.lon)) return last;
    } catch {}
    return DEFAULT_PLACE;
  }

  async function boot() {
    Theme.initTheme();
    hydrateIcons();
    updateThemeButtonIcon();
    buildThemeModal();
    wireModals();
    initTray();
    wireTabs();
    wirePlaceBar();
    wireSaved();
    wireShare();
    wireSync();
    wireRefresh();
    wireLanguage();
    // For a saved place whose label names no country, the one its kept forecast gave.
    Alerts.init({ countryOf: (p) => copyOf(forecastUrl(p))?.data?.country ?? null });
    renderSaved();

    // Pull the account's list in the background. When this browser is linked,
    // the merge brings back anything saved on the bot.
    Sync.refresh().then(() => {
      renderSyncState();
      Alerts.refreshTelegram();
    });

    const place = await firstPlace();
    current = { lat: place.lat, lon: place.lon, name: place.name };
    Map_.setPlace(current);
    showView(location.hash.slice(1));
    load();
  }

  boot();
})();
