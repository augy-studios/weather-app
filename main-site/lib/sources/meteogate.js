// Europe: EUMETNET's MeteoGate (api.meteogate.eu), the gateway to the national
// weather services' open data. Two of its APIs are used:
//
// - Surface observations: the nearest station's latest reading, for European
//   countries whose own service isn't read here for one. Hourly at most
//   stations, every ten minutes at some.
// - Warnings: MeteoAlarm's, the national services' warnings in one place.
//   Its API is asked only by the time a warning was sent, under a day at a
//   time, and lists each warning area by area, with its text and exact shape
//   behind links that expire within the hour. So /api/cron/warnings
//   (ingestWarnings below) takes in what was sent since its last run every ten
//   minutes, and keeps every warning still in force, its text and its areas'
//   shapes, in one Blob file per country. A place then reads its country's file
//   and keeps the warnings whose areas hold it.
//
// METEOGATE_KEY is sent as `apikey`. Without it MeteoGate answers too, but
// allows 50 requests an hour; with it, 500 for the warnings.
//
// Data: EUMETNET's members via MeteoGate, CC BY 4.0. The page credits it.

import { getJSON } from '../blob.js';
import { peek, store } from '../cache.js';
import { inRings } from '../singapore.js';
import { fetchJSON, num } from '../wx.js';

const GATE = 'https://api.meteogate.eu';
const OBSERVATIONS = `${GATE}/eu-eumetnet-surface-observations/collections/observations`;
const WARNINGS = `${GATE}/warnings/collections/warnings/locations/ALL`;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const withKey = (url) => {
  const key = process.env.METEOGATE_KEY;
  return key ? `${url}${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}` : url;
};

// MeteoGate's members and cooperating states, by ISO code. MeteoAlarm says "UK".
export const EUROPE = new Set([
  'AD', 'AT', 'BA', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME',
  'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'SM', 'UA', 'XK'
]);
const isoCode = (code) => (code === 'UK' ? 'GB' : code);

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// ---------- the nearest station ----------

// Stations report no height, so distance alone has to do; closer than the
// national services' limits, for the hills.
const OBS_KM = 15;
// Hourly stations report a few minutes past the hour, and arrive later.
const OBS_MAX_AGE = 90 * MIN;

// Each parameter is "standard_name:level:method:duration". Instant values,
// near the ground, and what each may plausibly be. Some stations send
// placeholders (-273 °C, 0 % humidity) in their ten-minute series, which the
// instant reading and the bounds keep out.
const FIELDS = {
  temperature_2m: { name: 'air_temperature', ok: (v) => v > -60 && v < 60, level: [1, 2.5], duration: 'PT0S' },
  relative_humidity_2m: { name: 'relative_humidity', ok: (v) => v > 0 && v <= 100, level: [1, 2.5], duration: 'PT0S' },
  wind_speed_10m: { name: 'wind_speed', ok: (v) => v >= 0 && v < 80, scale: 3.6 },
  wind_direction_10m: { name: 'wind_from_direction', ok: (v) => v >= 0 && v <= 360 },
  surface_pressure: { name: 'air_pressure_at_mean_sea_level', ok: (v) => v > 850 && v < 1090 }
};

function reading(coverage) {
  const times = (coverage.domain?.axes?.t?.values || []).map((t) => Date.parse(t));
  const out = {};
  let newest = 0;
  for (const [field, want] of Object.entries(FIELDS)) {
    for (const [id, range] of Object.entries(coverage.ranges || {})) {
      const [name, level, method, duration] = id.split(':');
      if (name !== want.name || method !== 'point') continue;
      if (want.duration && duration !== want.duration) continue;
      if (want.level && !(num(level) >= want.level[0] && num(level) <= want.level[1])) continue;
      const values = range.values || [];
      for (let i = values.length - 1; i >= 0; i--) {
        const v = num(values[i]);
        if (v == null || !want.ok(v) || !(Date.now() - times[i] < OBS_MAX_AGE)) continue;
        out[field] = Math.round(v * (want.scale || 1) * 10) / 10;
        if (field === 'temperature_2m') newest = times[i];
        break;
      }
      if (out[field] != null) break;
    }
  }
  return out.temperature_2m == null ? null : { time: newest / 1000, ...out };
}

// "DUBLIN_AIRPORT" → "Dublin Airport". Names already in mixed case are left.
const prettyName = (name) => (/[a-z]/.test(name || '')
  ? name
  : String(name || '').toLowerCase().replace(/_/g, ' ').replace(/(^|[\s(-])\p{L}/gu, (c) => c.toUpperCase()));

async function stationNames(lat, lon) {
  const box = [lon - 0.25, lat - 0.2, lon + 0.25, lat + 0.2].map((v) => v.toFixed(3)).join(',');
  const j = await fetchJSON(withKey(`${OBSERVATIONS}/locations?bbox=${box}`), { label: 'MeteoGate stations', timeout: 10000 });
  return new Map((j.features || []).map((f) => [f.id, prettyName(f.properties?.name)]));
}

/** The nearest station's latest reading within 15 km, or null. */
export async function observation(lat, lon) {
  const since = new Date(Date.now() - 2 * HOUR).toISOString().replace(/\.\d+Z$/, 'Z');
  const params = new URLSearchParams({
    coords: `POINT(${lon.toFixed(4)} ${lat.toFixed(4)})`,
    within: String(OBS_KM),
    datetime: `${since}/..`,
    standard_name: Object.values(FIELDS).map((f) => f.name).join(',')
  });
  const [data, names] = await Promise.all([
    fetchJSON(withKey(`${OBSERVATIONS}/radius?${params}`), { label: 'MeteoGate observations', timeout: 10000 }),
    stationNames(lat, lon).catch(() => new Map())
  ]);
  const stations = (data.coverages || (data.type === 'Coverage' ? [data] : []))
    .map((c) => {
      const sLat = num(c.domain?.axes?.y?.values?.[0]);
      const sLon = num(c.domain?.axes?.x?.values?.[0]);
      return { c, sLat, sLon, km: distanceKm(lat, lon, sLat, sLon) };
    })
    .filter((s) => Number.isFinite(s.km))
    .sort((a, b) => a.km - b.km);
  for (const { c, sLat, sLon, km } of stations) {
    const r = reading(c);
    if (!r) continue;
    const id = c['metocean:wigosId'];
    return {
      ...r,
      station: names.get(id) || id || 'a nearby',
      stationLat: sLat,
      stationLon: sLon,
      stationKm: Math.round(km * 10) / 10
    };
  }
  return null;
}

// ---------- warnings: kept by the cron ----------

const STATE_KEY = 'meteogate-warnings-state';
const countryKey = (cc) => `meteogate-warnings-${cc}`;

// The DWD's own warnings are read in Germany (lib/sources/germany.js), and are
// most of MeteoAlarm's traffic by far, so they aren't kept twice.
const SKIP = new Set(['DE']);
// Every language MeteoAlarm's members publish English in. The filter is exact.
const LANGUAGES = ['en-GB', 'en'];
// A warning is often sent a day or two before it starts. The first run, or one
// after a long gap, goes back this far.
const BACKFILL_MS = 48 * HOUR;
// The API wants windows under a day.
const WINDOW_MS = 23 * HOUR;
// A warning can reach the hub a while after the time it says it was sent, so
// each run starts this far before the last one ended. Repeats are recognised.
const OVERLAP_MS = HOUR;
const LEVELS = { 2: 'Yellow', 3: 'Orange', 4: 'Red' };

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** Every area-feature sent in [from, to), for one language, all pages. */
async function sentBetween(from, to, language) {
  const url = (page) => withKey(`${WARNINGS}?datetime=${iso(from)}/${iso(to)}&language=${language}&page=${page}`);
  const first = await fetchJSON(url(1), { label: 'MeteoGate warnings', timeout: 30000 }).catch((err) => {
    // No content: nothing was sent.
    if (/answered 204/.test(err.message) || err instanceof SyntaxError) return { features: [] };
    throw err;
  });
  const features = [...(first.features || [])];
  const pages = num(first.metadata?.total_pages) || 1;
  await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 4, async (page) => {
    const j = await fetchJSON(url(page), { label: 'MeteoGate warnings', timeout: 30000 });
    features.push(...(j.features || []));
  });
  return features;
}

// Rounded to about 100 m and thinned to at most 300 points a ring: plenty for
// telling which side of a county line a town is on, at a fraction of the size.
function simplify(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length <= 300) return out;
  const step = Math.ceil(out.length / 300);
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}

const ringArea = (ring) => Math.abs(ring.reduce((sum, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return sum + x * ny - nx * y;
}, 0)) / 2;

// A coast can come with hundreds of islands. The largest rings are kept first,
// up to 2,000 points a shape; the islets past that are left out.
const SHAPE_POINTS = 2000;

function ringsOf(geometry) {
  const rings = geometry?.type === 'Polygon' ? geometry.coordinates
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates.flat()
      : [];
  const kept = [];
  let points = 0;
  for (const ring of rings.map(simplify).sort((a, b) => ringArea(b) - ringArea(a))) {
    if (points + ring.length > SHAPE_POINTS && kept.length) break;
    kept.push(ring);
    points += ring.length;
  }
  return kept;
}

function bboxOf(rings) {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x); e = Math.max(e, x);
      s = Math.min(s, y); n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

const levelOf = (info) => {
  const p = (info.parameter || []).find((x) => x.valueName === 'awareness_level');
  return num(String(p?.value || '').split(';')[0]);
};

// CAP's references: "sender,identifier,sent" triples, space separated.
const referenced = (cap) => String(cap.references || '').split(/\s+/).map((r) => r.split(',')[1]).filter(Boolean);

const fixed = (text) => (text && text.trim() !== 'None' ? text.trim() : '');

/**
 * Take in the warnings sent since the last run. Stops starting new windows
 * once `budgetMs` has passed, and carries on from there next time.
 */
export async function ingestWarnings({ budgetMs = 200 * 1000 } = {}) {
  const started = Date.now();
  const state = (await peek(STATE_KEY))?.data || {};
  const seen = new Map(Object.entries(state.seen || {}));
  const countries = new Map();
  const loading = new Map();
  // Messages an update or cancellation has replaced in this run, in case the
  // original is handled after its replacement.
  const replaced = new Set();
  const tally = { windows: 0, features: 0, alerts: 0, cancelled: 0, shapes: 0, failed: 0 };

  // Once per country, however many messages ask at the same moment.
  // A country's file: its warnings, and the shapes of the areas they name,
  // each kept once however many warnings name it. A region warned again isn't
  // fetched again.
  const load = (cc) => {
    if (!loading.has(cc)) {
      loading.set(cc, peek(countryKey(cc)).then((entry) => {
        const c = { alerts: entry?.data?.alerts || {}, shapes: entry?.data?.shapes || {}, changed: false };
        countries.set(cc, c);
        return c;
      }));
    }
    return loading.get(cc);
  };
  for (const cc of state.countries || []) await load(cc);
  const areaKey = (area) => `${area.areaDesc}|${(area.geocode || []).map((g) => g.value).sort().join(',')}`;

  const now = Date.now();
  let from = Math.max(state.until ? Date.parse(state.until) - OVERLAP_MS : 0, now - BACKFILL_MS);

  while (from < now && Date.now() - started < budgetMs) {
    const to = Math.min(from + WINDOW_MS, now);
    const features = (await Promise.all(LANGUAGES.map((l) => sentBetween(from, to, l)))).flat();
    tally.windows++;
    tally.features += features.length;

    // One message per alertId; its features are its areas.
    const messages = new Map();
    for (const f of features) {
      const p = f.properties || {};
      const cc = isoCode(p.countryCode);
      if (!p.alertId || seen.has(p.alertId) || SKIP.has(cc) || !EUROPE.has(cc) || p.supersededAt) continue;
      const links = Object.fromEntries((f.links || []).map((l) => [l.rel, l.href]));
      if (!messages.has(p.alertId)) messages.set(p.alertId, { cc, json: links.json, features: [] });
      messages.get(p.alertId).features.push({ indexInfo: num(p.indexInfo), indexArea: num(p.indexArea), geometry: links.geometry });
    }

    await pool([...messages], 8, async ([alertId, m]) => {
      try {
        await take(m);
        seen.set(alertId, Date.now());
      } catch (err) {
        // Not marked as seen: the overlap brings it round again next run.
        tally.failed++;
        console.warn(`MeteoGate warning ${alertId} failed:`, err.message);
      }
    });

    // Saved window by window, so a run cut short loses nothing it finished.
    for (const [cc, c] of countries) {
      for (const [id, a] of Object.entries(c.alerts)) {
        if (replaced.has(id) || !(Date.parse(a.until) > Date.now())) {
          delete c.alerts[id];
          c.changed = true;
        }
      }
      if (!c.changed) continue;
      // Shapes no warning names any more go with the last of them.
      const named = new Set(Object.values(c.alerts).flatMap((a) => a.areas));
      for (const key of Object.keys(c.shapes)) if (!named.has(key)) delete c.shapes[key];
      await store(countryKey(cc), { alerts: c.alerts, shapes: c.shapes });
      c.changed = false;
    }
    for (const [id, at] of seen) if (Date.now() - at > BACKFILL_MS) seen.delete(id);
    await store(STATE_KEY, {
      until: iso(to),
      countries: [...countries.keys()],
      seen: Object.fromEntries(seen)
    });
    from = to;
  }
  return { ...tally, until: iso(from), ms: Date.now() - started };

  // One message: its text from the CAP JSON, its areas' shapes.
  async function take(m) {
    const cap = await fetchJSON(m.json, { label: 'MeteoAlarm message', timeout: 15000 });
    const country = await load(m.cc);
    // An update or cancellation replaces what it refers to.
    for (const id of referenced(cap)) {
      replaced.add(id);
      if (country.alerts[id]) {
        delete country.alerts[id];
        country.changed = true;
      }
    }
    if (cap.msgType === 'Cancel') {
      tally.cancelled++;
      return;
    }
    const info = cap.info?.[m.features[0].indexInfo] || cap.info?.find((i) => /^en/.test(i.language || ''));
    const level = info && levelOf(info);
    if (cap.status !== 'Actual' || !info || !(level >= 2) || !(Date.parse(info.expires) > Date.now())) return;
    if (replaced.has(cap.identifier)) return;

    // The same area can come once per language, hence a set.
    const areas = new Set();
    await pool(m.features, 6, async (f) => {
      const area = info.area?.[f.indexArea];
      if (!area) return;
      const key = areaKey(area);
      if (!country.shapes[key] && f.geometry) {
        const g = await fetchJSON(f.geometry, { label: 'MeteoAlarm shape', timeout: 15000 }).catch(() => null);
        const rings = ringsOf(g?.geometry).filter((r) => r.length >= 4);
        if (rings.length) {
          country.shapes[key] = { name: area.areaDesc, bbox: bboxOf(rings), rings };
          tally.shapes++;
        }
      }
      if (country.shapes[key]) areas.add(key);
    });
    if (!areas.size) return;

    country.alerts[cap.identifier] = {
      level,
      // Some events already say their colour ("Yellow Wind Warning").
      title: fixed(info.headline) || (/^(yellow|orange|red)\b/i.test(info.event || '') ? info.event : `${LEVELS[level]} warning: ${info.event}`),
      event: info.event,
      severity: LEVELS[level],
      from: info.onset || info.effective || cap.sent,
      until: info.expires,
      text: [fixed(info.description), fixed(info.instruction)].filter(Boolean).join('\n\n'),
      source: info.senderName || 'MeteoAlarm',
      url: info.web || null,
      areas: [...areas]
    };
    country.changed = true;
    tally.alerts++;
  }
}

// ---------- warnings: read by a place ----------

const kept = new Map();

// The cron rewrites each file every ten minutes at most; five here keeps an
// instance from reading Blob on every place it builds.
async function countryFile(cc) {
  const hit = kept.get(cc);
  if (hit && Date.now() - hit.at < 5 * MIN) return hit.data;
  const entry = await getJSON(`cache/${countryKey(cc)}.json`);
  const data = { alerts: Object.values(entry?.data?.alerts || {}), shapes: entry?.data?.shapes || {} };
  kept.set(cc, { at: Date.now(), data });
  return data;
}

/** The warnings in force whose areas hold the point, worst first. */
export async function warningsAt(lat, lon, country) {
  if (!EUROPE.has(country) || SKIP.has(country)) return [];
  const { alerts, shapes } = await countryFile(country);
  const holds = (key) => {
    const shape = shapes[key];
    if (!shape) return false;
    const [w, s, e, n] = shape.bbox;
    return lon >= w && lon <= e && lat >= s && lat <= n && inRings(shape.rings, lat, lon);
  };
  return alerts
    .filter((a) => Date.parse(a.until) > Date.now())
    .map((a) => ({ a, here: a.areas.find(holds) }))
    .filter(({ here }) => here)
    .sort((x, y) => y.a.level - x.a.level)
    .map(({ a: { areas, level, ...a }, here }) => ({ ...a, area: shapes[here].name }));
}
