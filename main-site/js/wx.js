// Weather helpers shared by every page: units, formatting in the place's own
// time zone, what a WMO code or an NEA forecast means and which icon it gets,
// where Singapore and NEA's radar are, and the bands for air, UV and heat.
// Plain script, not a module: published on window.UwuWx.

(function () {
  // ---------- units ----------

  const UNITS_KEY = "uwuweather.units";
  let units = "metric";
  try {
    units = localStorage.getItem(UNITS_KEY) === "imperial" ? "imperial" : "metric";
  } catch {}

  const isImperial = () => units === "imperial";
  function setUnits(next) {
    units = next === "imperial" ? "imperial" : "metric";
    try {
      localStorage.setItem(UNITS_KEY, units);
    } catch {}
  }

  const tempUnit = () => (isImperial() ? "°F" : "°C");
  const windUnit = () => (isImperial() ? "mph" : "km/h");

  // NEA reports in Celsius and knots; Open-Meteo is asked for the chosen units.
  const fromC = (c) => (c == null ? null : isImperial() ? c * 1.8 + 32 : c);
  const fromKnots = (kn) => (kn == null ? null : isImperial() ? kn * 1.15078 : kn * 1.852);
  const fromKmh = (kmh) => (kmh == null ? null : isImperial() ? kmh * 0.621371 : kmh);

  const fmtTemp = (v) => (v == null || !Number.isFinite(v) ? "--" : `${Math.round(v)}${tempUnit()}`);
  const fmtDeg = (v) => (v == null || !Number.isFinite(v) ? "--" : `${Math.round(v)}°`);
  const fmtPerc = (v) => (v == null || !Number.isFinite(v) ? "--" : `${Math.round(v)}%`);
  const fmtMM = (v) => (v == null || !Number.isFinite(v) ? "--" : `${(Math.round(v * 10) / 10).toString()} mm`);
  const fmtWind = (speed, dir) =>
    speed == null || !Number.isFinite(speed) ? "--" : `${Math.round(speed)} ${windUnit()}${dir == null ? "" : ` ${compass(dir)}`}`;

  // Meteorological direction (where the wind comes from) as a 16-point compass name.
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

  // "72 to 94", or one number when low and high agree.
  const fmtRange = (r) => (!r ? "--" : r.low === r.high ? `${r.low}` : `${r.low}–${r.high}`);

  // ---------- time, in the place's own zone ----------

  let zone = "Asia/Singapore";
  const setZone = (tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      zone = tz;
    } catch {
      zone = undefined;
    }
  };
  const getZone = () => zone;

  // "11pm", or "11:15pm" when it isn't on the hour.
  function time(t, tz = zone) {
    const parts = new Intl.DateTimeFormat("en-SG", { timeZone: tz || undefined, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(t));
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const minute = get("minute");
    return `${get("hour")}${minute && minute !== "00" ? `:${minute}` : ""}${get("dayPeriod").replace(/\W/g, "").toLowerCase()}`;
  }
  const weekday = (t, tz = zone) => new Intl.DateTimeFormat("en-SG", { timeZone: tz || undefined, weekday: "short" }).format(new Date(t));
  const dayLabel = (t, tz = zone) => new Intl.DateTimeFormat("en-SG", { timeZone: tz || undefined, weekday: "short", day: "numeric", month: "short" }).format(new Date(t));
  const dateKey = (t, tz = zone) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  // "11pm" today, "Mon 5 Oct, 11pm" otherwise.
  const when = (t, tz = zone) => (dateKey(t, tz) === dateKey(Date.now(), tz) ? time(t, tz) : `${dayLabel(t, tz)}, ${time(t, tz)}`);

  // "just now", "4 min ago", "2 h ago".
  function ago(t) {
    const min = Math.round((Date.now() - new Date(t).getTime()) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min ago` : `${h} h ago`;
  }

  // ---------- what the weather is called, and its icon ----------

  const WMO_TEXT = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
  };
  const wmoText = (code) => WMO_TEXT[code] || "--";

  function wmoIcon(code, isDay = 1) {
    if (code === 0) return isDay ? "clear" : "clear-night";
    if (code === 1 || code === 2) return isDay ? "partly-cloudy" : "partly-cloudy-night";
    if (code === 3) return "cloudy";
    if (code === 45 || code === 48) return "fog";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
    if ([95, 96, 99].includes(code)) return "thunderstorm";
    return "thermometer";
  }

  // NEA's forecast words, e.g. "Partly Cloudy (Night)" or "Heavy Thundery Showers".
  function neaIcon(text) {
    const t = String(text || "").toLowerCase();
    const night = t.includes("(night)");
    if (t.includes("thunder")) return "thunderstorm";
    if (t.includes("rain") || t.includes("shower")) return "rain";
    if (t.includes("haz") || t.includes("mist") || t.includes("fog")) return "fog";
    if (t.includes("windy")) return "wind";
    if (t.includes("partly")) return night ? "partly-cloudy-night" : "partly-cloudy";
    if (t.includes("cloudy")) return "cloudy";
    if (t.includes("fair")) return night ? "clear-night" : "clear";
    return "partly-cloudy";
  }
  // "Partly Cloudy (Night)" to "Partly cloudy".
  const neaText = (text) => {
    const t = String(text || "").replace(/\s*\((day|night)\)\s*/i, "").trim().toLowerCase();
    return t ? t[0].toUpperCase() + t.slice(1) : "--";
  };

  // ---------- where things are ----------

  // Same outline as lib/singapore.js, as [lon, lat]. Keep the two in step.
  const SG_OUTLINE = [
    [103.59, 1.19], [104.07, 1.19], [104.07, 1.43], [103.99, 1.44], [103.90, 1.44],
    [103.85, 1.47], [103.80, 1.46], [103.75, 1.455], [103.70, 1.45], [103.64, 1.35],
    [103.59, 1.30],
  ];
  function inSingapore(lat, lon) {
    let inside = false;
    for (let i = 0, j = SG_OUTLINE.length - 1; i < SG_OUTLINE.length; j = i++) {
      const [xi, yi] = SG_OUTLINE[i];
      const [xj, yj] = SG_OUTLINE[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Where lightning alerts can watch a place, and who detects it there. The
  // same list as LIGHTNING_COUNTRIES in lib/lightning.js; keep the two in step.
  const LIGHTNING_COUNTRIES = { SG: "NEA", CA: "Environment Canada" };

  // The covered country a saved place is in, or null: Singapore by its outline,
  // anywhere else by the label's country code ("Toronto, Ontario, CA"), or by
  // `known`, the country the forecast said, for a place like "My location".
  function lightningCountry(place, known = null) {
    const lat = Number(place?.lat);
    const lon = Number(place?.lon);
    if (inSingapore(lat, lon)) return "SG";
    const named = String(place?.name || "").match(/,\s*([A-Z]{2})$/)?.[1];
    const code = named && named !== "SG" ? named : known;
    return code !== "SG" && LIGHTNING_COUNTRIES[code] ? code : null;
  }

  // NEA's widest radar image, 480 km round the Changi radar. Inside it the map
  // shows NEA's radar; outside, RainViewer's.
  const NEA_RADAR_BOX = { south: -2.967382, west: 99.638609, north: 5.657912, east: 108.290871 };
  const inNeaRadar = (lat, lon) =>
    lat >= NEA_RADAR_BOX.south && lat <= NEA_RADAR_BOX.north && lon >= NEA_RADAR_BOX.west && lon <= NEA_RADAR_BOX.east;

  function km(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  /**
   * The nearest station with a value, from a station list ({id: [name, lat, lon]})
   * and one feed's values ({id: value}): { id, name, km, value }, or null.
   */
  function nearestStation(list, values, lat, lon) {
    let best = null;
    for (const [id, value] of Object.entries(values || {})) {
      const s = list?.[id];
      if (!s || !Number.isFinite(value)) continue;
      const d = km(lat, lon, s[1], s[2]);
      if (!best || d < best.km) best = { id, name: s[0], km: d, value };
    }
    return best;
  }

  // NEA's five regions, at the points NEA labels them, for picking a place's region.
  const REGIONS = { north: [1.41803, 103.82], south: [1.29587, 103.82], east: [1.35735, 103.94], west: [1.35735, 103.7], central: [1.35735, 103.82] };
  function regionOf(lat, lon) {
    let best = null;
    for (const [name, [rlat, rlon]] of Object.entries(REGIONS)) {
      const d = km(lat, lon, rlat, rlon);
      if (!best || d < best.d) best = { name, d };
    }
    return best.name;
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

  // ---------- bands ----------
  // `level` picks a fixed-meaning colour (--band-1 to --band-6 in style.css), so
  // the same severity looks alike whichever scale it came from. Always shown
  // beside the band's name, never as colour alone.

  const bandOf = (bands) => (v) => (Number.isFinite(v) ? bands.find((b) => v <= b.max) : null);

  // WHO's UV index categories.
  const uvBand = bandOf([
    { label: "Low", max: 2, level: 1 },
    { label: "Moderate", max: 5, level: 2 },
    { label: "High", max: 7, level: 3 },
    { label: "Very high", max: 10, level: 4 },
    { label: "Extreme", max: Infinity, level: 5 },
  ]);
  const UV_ADVICE = {
    Low: "No protection needed for most people.",
    Moderate: "Shade around midday, a hat and sunscreen if outdoors for long.",
    High: "Cover up, sunscreen, and shade between 11am and 3pm.",
    "Very high": "Avoid the midday sun. Shirt, hat, sunglasses and sunscreen.",
    Extreme: "Stay out of the sun where you can. Full protection outdoors.",
  };

  // NEA's heat stress bands for WBGT, in °C.
  const HEAT_LEVELS = { Low: 1, Moderate: 2, High: 4 };
  const HEAT_ADVICE = {
    Low: "Normal activity, with water and rest as usual.",
    Moderate: "Drink more often and take breaks from strenuous activity outdoors.",
    High: "Cut back strenuous outdoor activity. Rest in the shade and drink water regularly.",
  };

  window.UwuWx = {
    isImperial, setUnits, tempUnit, windUnit, fromC, fromKnots, fromKmh,
    fmtTemp, fmtDeg, fmtPerc, fmtMM, fmtWind, fmtRange, compass,
    setZone, getZone, time, weekday, dayLabel, dateKey, when, ago,
    wmoText, wmoIcon, neaIcon, neaText,
    inSingapore, inNeaRadar, NEA_RADAR_BOX, km, nearestStation, regionOf, cap,
    LIGHTNING_COUNTRIES, lightningCountry,
    uvBand, UV_ADVICE, HEAT_LEVELS, HEAT_ADVICE,
  };
})();
