// UwU Weather: the page. Wires the tray and its four pages (Now, Map, Forecast,
// Air & heat), the place bar, the theme, sync, share and alerts panels, and draws
// each page from three sources:
//
// - Open-Meteo, through /api/forecast, everywhere: current conditions, hourly,
//   daily and fifteen-minute rain.
// - NEA, through /api/sg, in Singapore: the nearest stations' readings, the
//   2-hour, 24-hour and 4-day forecasts, UV, heat stress and lightning. Each
//   part that NEA can't give right now falls back to Open-Meteo's.
// - /api/air, everywhere: NEA's PSI in Singapore, Open-Meteo's US AQI elsewhere.
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

  function buildThemeModal() {
    const grid = $("#swatchGrid");
    grid.innerHTML = Theme.COLOR_THEMES.map(
      (t) => `
        <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
          <span class="swatch-dot"></span>
          <span class="swatch-label">${t.label}</span>
        </button>`
    ).join("");

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
        note.textContent = `Following the clock. Currently ${resolvedMode}.`;
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

  const TRAY_KEY = "uwuweather.trayOpen";

  function setTray(open, { save = true } = {}) {
    $("#tray").classList.toggle("collapsed", !open);
    $("#trayTab").setAttribute("aria-expanded", String(open));
    $("#trayTab").setAttribute("aria-label", open ? "Hide menu" : "Show menu");
    // Off screen buttons must not take focus.
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
      const prefix = it.name === "My location"
        ? '<span data-icon="crosshair" aria-hidden="true"></span>'
        : flagFromLabel(it.name) || '<span data-icon="pin" aria-hidden="true"></span>';
      const here = samePlace(it, current) ? ' aria-current="true"' : "";
      return `<span class="chip"${here}>
        <button type="button" data-go="${i}">${prefix} <span>${esc(it.name)}</span></button>
        <button type="button" data-remove="${i}" aria-label="Remove ${esc(it.name)}" title="Remove"><span data-icon="close" aria-hidden="true"></span></button>
      </span>`;
    }).join("");
    hydrateIcons(wrap);
    const saved = list.some((it) => samePlace(it, current));
    $("#btn-save").setAttribute("aria-pressed", String(saved));
    $("#btn-save").setAttribute("aria-label", saved ? "Remove this place from saved" : "Save this place");
    $("#btn-save").title = saved ? "Saved. Press to remove" : "Save this place";
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
        status("No place by that name. Try a different spelling.", true);
      }
    });

    $("#btn-current").addEventListener("click", () => {
      if (!navigator.geolocation) return status("This browser can't share its location. Search for a place instead.", true);
      $("#btn-current").classList.add("busy");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          $("#btn-current").classList.remove("busy");
          loadPlace(pos.coords.latitude, pos.coords.longitude, "My location");
        },
        (err) => {
          $("#btn-current").classList.remove("busy");
          status({
            1: "Location is blocked for this site. Allow it in your browser's settings, or search for a place.",
            2: "Your location isn't available right now. Try again in a moment.",
            3: "Finding your location took too long. Try again.",
          }[err.code] || "Couldn't get your location. Search for a place instead.", true);
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

  async function getJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${url.split("?")[0]} replied ${res.status}`);
    return res.json();
  }

  function forecastUrl() {
    const params = new URLSearchParams({
      latitude: current.lat,
      longitude: current.lon,
      timezone: "auto",
      timeformat: "unixtime",
      current: [
        "temperature_2m", "relative_humidity_2m", "apparent_temperature", "precipitation",
        "weather_code", "is_day", "wind_speed_10m", "wind_direction_10m", "surface_pressure",
      ].join(","),
      hourly: [
        "temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation",
        "weather_code", "is_day", "uv_index",
      ].join(","),
      daily: [
        "weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
        "precipitation_probability_max", "wind_speed_10m_max", "uv_index_max",
      ].join(","),
      minutely_15: "precipitation",
      forecast_minutely_15: "9",
      forecast_days: "7",
      temperature_unit: W.isImperial() ? "fahrenheit" : "celsius",
      wind_speed_unit: W.isImperial() ? "mph" : "kmh",
    });
    return `/api/forecast?${params}`;
  }

  // The label's trailing country code, when it has one, names the country the
  // air quality range covers. "My location" has none, and the route works it out.
  function airUrl() {
    const params = new URLSearchParams({ latitude: current.lat, longitude: current.lon });
    const country = current.name.match(/,\s*([A-Z]{2})$/)?.[1];
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

  async function load({ force = false } = {}) {
    const ticket = ++loading;
    const place = { ...current };
    const stale = () => ticket !== loading || place.lat !== current.lat || place.lon !== current.lon;
    $("#refreshBtn").classList.add("busy");
    status("Loading the weather.");
    lastLoad = Date.now();

    // Each source draws as soon as it lands; none waits on another.
    const forecast = getJSON(forecastUrl()).then((j) => {
      if (stale()) return;
      om = j;
      W.setZone(j.timezone);
      renderAll();
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
      sg = null;
    }
    if (q.status === "rejected") {
      console.warn("air quality unavailable:", q.reason);
      air = null;
      renderAir();
      renderNowAir();
    }
    loadFailed = f.status === "rejected" && !om;
    $("#refreshBtn").classList.remove("busy");
    if (om) renderAll();
    renderStatus();
  }

  // ---------- status ----------

  function status(text, bad = false) {
    $("#statusText").textContent = text;
    $("#status").dataset.tone = bad ? "bad" : "";
  }

  function renderStatus() {
    if (!om) {
      return status(loadFailed
        ? "Couldn't load the weather. Check your connection, then tap refresh."
        : "Loading the weather.", loadFailed);
    }
    // The reader's own clock: "updated" is about when they looked, not the place.
    const parts = [`Updated ${W.time(lastLoad, null)}.`];
    if (W.inSingapore(current.lat, current.lon)) {
      if (!sg) parts.push("NEA isn't answering, so this is Open-Meteo's forecast for now.");
      else if (["stations", "forecast2h"].some((k) => !sg[k])) parts.push("Some of NEA's readings are missing; Open-Meteo fills the gaps.");
    }
    status(parts.join(" "));
  }

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

  const distance = (km) => (km < 1 ? "under 1 km away" : `${Math.round(km)} km away`);

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

    const t = nearest("temp");
    out.temp = t ? W.fromC(t.value) : c.temperature_2m;
    const h = nearest("humidity");
    out.humidity = h ? h.value : c.relative_humidity_2m;
    const ws = nearest("windSpeed");
    const wd = ws && sg.stations.windDir?.[ws.id];
    out.wind = ws ? W.fmtWind(W.fromKnots(ws.value), wd) : W.fmtWind(c.wind_speed_10m, c.wind_direction_10m);
    const r = nearest("rain");
    out.rain = r ? { mm: r.value, span: "last 5 min" } : { mm: c.precipitation, span: "last 15 min" };
    out.apparent = c.apparent_temperature;

    const area = nearestArea();
    out.summary = area ? W.neaText(area.text) : W.wmoText(c.weather_code);
    out.icon = area ? W.neaIcon(area.text) : W.wmoIcon(c.weather_code, c.is_day);

    out.notes = {
      temp: t ? t.name : "",
      humidity: h && h.id !== t?.id ? h.name : "",
      wind: ws && ws.id !== t?.id ? ws.name : "",
    };
    if (t) out.sources.push(`Temperature from NEA's ${t.name} station, ${distance(t.km)}`);
    if (area) out.sources.push(`conditions from NEA's 2-hour forecast for ${area.name}`);
    out.neaUsed = Boolean(t || area);
    return out;
  }

  function renderNow() {
    if (!om) return;
    const n = nowReadings();
    $("#place-label").textContent = current.name;
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

    const sources = n.sources.length
      ? `${n.sources.join("; ")}. Feels like from Open-Meteo.`
      : "From Open-Meteo.";
    $("#now-source").textContent = sources;

    // NEA's 2-hour forecast for the area.
    const area = nearestArea();
    $("#nowcast-card").hidden = !area;
    if (area) {
      $("#nowcast-text").textContent = W.neaText(area.text);
      $("#nowcast-icon").dataset.icon = W.neaIcon(area.text);
      $("#nowcast-area").textContent = `For ${area.name}, the nearest of NEA's forecast areas.`;
      $("#nowcast-valid").textContent = sg.forecast2h.valid?.text || "";
      hydrateIcons($("#nowcast-card"));
    }

    renderNowLightning();
  }

  function renderNowLightning() {
    const strikes = (inSg() && sg?.lightning?.strikes) || [];
    let near = null;
    for (const s of strikes) {
      if (Date.now() - Date.parse(s.t) > LIGHTNING_RECENT_MS) continue;
      const d = W.km(current.lat, current.lon, s.lat, s.lon);
      if (d <= LIGHTNING_NEAR_KM && (!near || d < near.km)) near = { ...s, km: d };
    }
    $("#lightning-card").hidden = !near;
    if (!near) return;
    $("#lightning-title").textContent = `Lightning ${distance(near.km)}`;
    $("#lightning-text").textContent =
      `${near.type === "ground" ? "Cloud to ground" : "Cloud to cloud"}, ${W.time(Date.parse(near.t))}. ` +
      "Head indoors, and wait 30 minutes after the last flash before going back out.";
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
    $("#aqi-label").textContent = region ? `Air, ${region.name}` : "Air quality";
    $("#aqi-band").textContent = shown ? shown.band : "";
  }

  // ---------- Forecast ----------

  function renderForecast() {
    if (!om) return;
    if (view === "forecast") renderRainChart();
    renderHourly();
    renderNea24();
    renderDaily();
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
      $("#rain-summary").textContent = "No fifteen-minute rain forecast for this place right now.";
      $("#rain-range").textContent = "";
      return;
    }
    const chart = Charts.rain($("#rainChart"), points);
    $("#rain-summary").textContent = chart.canvas.getAttribute("aria-label").replace(/^Rain, every fifteen minutes\. /, "");
    $("#rain-range").textContent = `${points[0].label} to ${W.time(points[points.length - 1].t + 15 * 60 * 1000)}`;
  }

  function renderHourly() {
    const h = om.hourly || {};
    const t = h.time || [];
    const start = hourIndex();
    const cells = [];
    for (let i = start; i < t.length && cells.length < 24; i++) {
      const prob = h.precipitation_probability?.[i];
      cells.push(`
        <div class="pill">
          <div class="muted">${i === start ? "Now" : W.time(t[i] * 1000)}</div>
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
    $("#nea24-title").textContent = `Next 24 hours, ${W.cap(region)} region`;
    $("#nea24-time").textContent = `NEA, ${W.time(Date.parse(f.time), "Asia/Singapore")}`;
    const t = f.temp || {};
    const hum = f.humidity || {};
    const lowC = W.fromC(t.low);
    const highC = W.fromC(t.high);
    $("#nea24-general").textContent =
      `${W.neaText(f.text)}. ${W.fmtDeg(lowC)} to ${W.fmtDeg(highC)}, humidity ${hum.low ?? "--"} to ${hum.high ?? "--"}%, ` +
      `wind ${f.wind?.dir || ""} ${Math.round(W.fromKmh(f.wind?.low) ?? 0)} to ${Math.round(W.fromKmh(f.wind?.high) ?? 0)} ${W.windUnit()}.`;
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
        extra: day.wind?.dir ? `Wind ${day.wind.dir} ${Math.round(W.fromKmh(day.wind.low) ?? 0)}–${Math.round(W.fromKmh(day.wind.high) ?? 0)} ${W.windUnit()}` : "",
        source: "NEA",
      }));
    }
    (d.time || []).forEach((t, i) => {
      const key = W.dateKey(t * 1000);
      // Today is always Open-Meteo's: NEA's outlook starts tomorrow.
      if (covered.has(key)) return;
      const prob = d.precipitation_probability_max?.[i];
      rows.push(dayRow({
        when: t * 1000,
        icon: W.wmoIcon(d.weather_code?.[i]),
        text: W.wmoText(d.weather_code?.[i]),
        low: d.temperature_2m_min?.[i],
        high: d.temperature_2m_max?.[i],
        extra: `${prob == null ? "--" : `${prob}%`} chance of rain, ${W.fmtMM(d.precipitation_sum?.[i] ?? 0)}`,
        source: neaDays.length ? "Open-Meteo" : "",
      }));
    });
    rows.sort((a, b) => a.when - b.when);
    $("#daily").innerHTML = rows.map((r) => r.html).join("");
    $("#daily-source").textContent = neaDays.length ? "NEA, then Open-Meteo" : "Open-Meteo";
    hydrateIcons($("#daily"));
  }

  function dayRow({ when, zone, icon, text, low, high, extra, source }) {
    const today = W.dateKey(when, zone) === W.dateKey(Date.now(), zone);
    return {
      when,
      html: `<li>
        <span class="day-name">${today ? "Today" : esc(W.weekday(when, zone))}<small>${esc(W.dayLabel(when, zone).replace(/^\w+,?\s*/, ""))}</small></span>
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
      $("#air-note").textContent = "No air quality reading for this place right now.";
      $("#air-pm25").textContent = "--";
      $("#air-regions").innerHTML = "";
      $("#air-time").textContent = "";
    } else {
      const region = air.region;
      const shown = region || air;
      $("#air-title").textContent = air.index === "PSI" ? "Air quality, 24-hour PSI" : "Air quality, US AQI";
      $("#air-range").textContent = W.fmtRange(shown);
      $("#air-index").textContent = air.index;
      chip($("#air-band"), shown.band, shown.level);
      $("#air-note").textContent = region
        ? `In the ${region.name} region. ${air.area === "islandwide" ? "Islandwide" : "Countrywide"} ${W.fmtRange(air)}.`
        : air.area === "here" ? "At this place." : `The range ${air.area}.`;
      $("#air-pm25").textContent = W.fmtRange(shown.pm25);
      // NEA's time carries +08:00; Open-Meteo's is UTC with no zone on it.
      const t = air.time && (/[zZ]|[+-]\d\d:?\d\d$/.test(air.time) ? air.time : `${air.time}Z`);
      $("#air-time").textContent = t ? W.when(Date.parse(t)) : "";
      $("#air-regions").innerHTML = (air.regions || []).map((r) => `
        <li${region && r.name === region.name ? ' aria-current="true"' : ""}>
          <span class="region-name">${esc(W.cap(r.name))}</span>
          <span>${dot(r.level)}${W.fmtRange(r)}</span>
          <span class="muted">${esc(r.band)}</span>
        </li>`).join("");
    }

    if (!om) return;
    renderUv();
    renderHeat();
  }

  function renderUv() {
    const uv = uvNow();
    const band = W.uvBand(uv?.value);
    $("#uv-value").textContent = uv ? String(Math.round(uv.value)) : "--";
    chip($("#uv-band"), band?.label, band?.level);
    $("#uv-advice").textContent = band ? W.UV_ADVICE[band.label] : "";
    $("#uv-source").textContent = uv?.source === "nea"
      ? "NEA's reading, averaged over the hour before. Later hours from Open-Meteo."
      : "Open-Meteo's forecast for each hour.";
    $("#uv-time").textContent = W.time(Date.now());

    // Today's daylight hours: NEA's readings so far, Open-Meteo's for the rest.
    const h = om.hourly || {};
    const today = W.dateKey(Date.now());
    const neaHours = (inSg() && sg?.uv?.hours) || [];
    const neaByHour = new Map(neaHours.map((x) => [Math.floor(Date.parse(x.t) / 3600000), x.value]));
    const hours = [];
    (h.time || []).forEach((t, i) => {
      if (W.dateKey(t * 1000) !== today) return;
      const v = neaByHour.get(Math.floor(t / 3600)) ?? h.uv_index?.[i];
      if (!Number.isFinite(v)) return;
      const hourOfDay = Number(new Intl.DateTimeFormat("en-GB", { timeZone: W.getZone(), hour: "numeric", hourCycle: "h23" }).format(new Date(t * 1000)));
      if (hourOfDay < 7 || hourOfDay > 19) return;
      hours.push({ label: W.time(t * 1000), value: v, band: W.uvBand(v) });
    });
    if (view === "air" && hours.length) Charts.uv($("#uvChart"), hours);
  }

  function renderHeat() {
    const w = inSg() && sg?.wbgt;
    $("#heat-sg").hidden = !w;
    $("#heat-elsewhere").hidden = Boolean(w);
    $("#heat-feels").textContent = W.fmtTemp(om?.current?.apparent_temperature);
    if (!w) {
      $("#heat-time").textContent = "";
      return;
    }
    const ranked = w.stations
      .map((s) => ({ ...s, km: W.km(current.lat, current.lon, s.lat, s.lon) }))
      .sort((a, b) => a.km - b.km);
    const near = ranked[0];
    const level = W.HEAT_LEVELS[near.stress] ?? "";
    // WBGT stays in Celsius: NEA's bands are set in it.
    $("#heat-value").textContent = near.wbgt.toFixed(1);
    chip($("#heat-band"), near.stress ? `${near.stress} heat stress` : null, level);
    $("#heat-advice").textContent = W.HEAT_ADVICE[near.stress] || "";
    $("#heat-station").textContent = `At NEA's ${near.name} station, ${distance(near.km)}.`;
    $("#heat-time").textContent = `NEA, ${W.time(Date.parse(w.time), "Asia/Singapore")}`;
    $("#heat-list").innerHTML = ranked.slice(1, 6).map((s) => `
      <li>
        <span class="region-name">${esc(s.town || s.name)}</span>
        <span>${dot(W.HEAT_LEVELS[s.stress])}${s.wbgt.toFixed(1)}°C</span>
        <span class="muted">${esc(s.stress || "")}</span>
      </li>`).join("");
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

  function buildShareURL() {
    if (!current.name || current.name === "My location") return location.origin;
    const params = new URLSearchParams({ q: current.name });
    return `${location.origin}/?${params}`;
  }

  function updateShare() {
    if (!om) return;
    const n = nowReadings();
    $("#share-place").textContent = current.name;
    $("#share-temp").textContent = W.fmtTemp(n.temp);
    $("#share-summary").textContent = n.summary;
    const shown = air?.region || air;
    $("#share-extra").textContent = [
      W.fmtPerc(n.humidity),
      n.wind,
      shown && `${air.index} ${W.fmtRange(shown)}`,
    ].filter(Boolean).join(" · ");
    $("#share-source").textContent = n.neaUsed || air?.source === "nea" ? "Data: NEA, Open-Meteo" : "Data: Open-Meteo";
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
    return `${$("#share-temp").textContent}, ${$("#share-summary").textContent} in ${current.name}.`;
  }

  function wireShare() {
    $("#save-image").addEventListener("click", saveShareImage);
    $("#share-device").addEventListener("click", async () => {
      try {
        const blob = await saveShareImage();
        const file = new File([blob], "uwuweather.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ title: `Weather in ${current.name}`, text: shareText(), files: [file] });
        } else if (navigator.share) {
          await navigator.share({ title: `Weather in ${current.name}`, text: shareText(), url: buildShareURL() });
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

  function syncMessage(text, tone = "good") {
    const el = $("#sync-message");
    el.textContent = text || "";
    el.dataset.tone = tone;
    el.hidden = !text;
  }

  function renderSyncState() {
    const { linked, username, backupCodesLeft } = Sync.state;
    $("#sync-status").textContent = linked
      ? (username
        ? `Linked to @${username}. One list, kept the same in both places.`
        : "This browser is linked. One list, kept the same in both places.")
      : "Not linked. Saved places stay in this browser only.";
    $("#sync-setup").hidden = linked;
    $("#sync-linked").hidden = !linked;
    $("#sync-backup-status").textContent = backupCodesLeft
      ? `${backupCodesLeft} unused code${backupCodesLeft === 1 ? "" : "s"}. Making a new set retires them.`
      : "None yet.";
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
      syncMessage("Linked. Your saved places are now shared with the bot.");
      return;
    }
    syncMessage(state === "denied"
      ? "That request was rejected in Telegram. Nothing was shared."
      : "That request ran out of time. Please start again.", "bad");
  }

  async function onBackupSettled(state, id) {
    if (state !== "approved") {
      syncMessage(state === "rejected"
        ? "That request was rejected in Telegram. No codes were created."
        : "That request ran out of time. Nothing was created, please ask again.", "bad");
      return;
    }
    const res = await Sync.collectBackupCodes(id);
    if (res.error) return syncMessage(res.error, "bad");
    showBackupCodes(res.codes);
    renderSyncState();
    syncMessage("Approved. These are shown once, so save them now.");
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
      syncMessage("Asking for approval. Check your Telegram chat.");
      const res = await Sync.requestBackupCodes(onBackupSettled);
      if (res.error) syncMessage(res.error, "bad");
    });

    $("#sync-copy-codes").addEventListener("click", async () => {
      const codes = [...$("#sync-code-list").children].map((li) => li.textContent);
      try {
        await navigator.clipboard.writeText(codes.join("\n"));
        syncMessage("Copied. Paste them somewhere that does not need Telegram to open.");
      } catch {
        syncMessage("Copying was blocked. Select the codes and copy them by hand.", "bad");
      }
    });

    $("#sync-open-telegram").addEventListener("click", async () => {
      syncMessage("Opening Telegram. Confirm there and this page follows along.");
      const res = await Sync.startDeepLink(onSyncSettled);
      if (res.error) syncMessage(res.error, "bad");
    });

    $("#sync-use-code").addEventListener("click", async () => {
      const field = $("#sync-code");
      if (!field.value.trim()) return;
      syncMessage("Checking that code.");
      const res = await Sync.useCode(field.value);
      if (res.error) return syncMessage(res.error, "bad");
      field.value = "";
      linkedNow();
      syncMessage(res.backup_codes_left === undefined
        ? "Linked. Your saved places are now shared with the bot."
        : `Linked with a backup code. ${res.backup_codes_left} of them left.`);
    });

    $("#sync-unlink").addEventListener("click", async () => {
      await Sync.unlink();
      renderSyncState();
      Alerts.refreshTelegram();
      syncMessage("This browser has stopped syncing. Your saved places are still here.");
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
    Alerts.init();
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
