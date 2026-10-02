// Air quality for the country a point is in, as a low to high range, in one
// shape whatever the source. The Telegram bot reads it from here too.
//
// Inside Singapore the reading is NEA's own, from data.gov.sg: the 24-hour PSI
// and the one-hour PM2.5, each as the islandwide range across its five regions,
// the way NEA reports them. Everywhere else, and in Singapore whenever
// data.gov.sg does not answer, it is the US AQI and PM2.5 from Open-Meteo's air
// quality model, read at a grid of sample points across the country (see
// lib/build-countries.mjs). A country too small for any sample point, or a point
// in no country at all, gets the reading at the point itself.

import COUNTRIES from '../lib/countries.js';

const NEA_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TTL_MS = 10 * 60 * 1000;

// The CDN caches by URL, so two places in one country are two misses there.
// This keeps one countrywide reading per warm instance instead, so they share it.
const _cache = new Map();

// A coarse outline of Singapore as [lon, lat]. A box would take in Johor Bahru,
// which sits under a kilometre across the strait, so the north edge follows the
// water from Tuas round to Pulau Tekong.
const SG_OUTLINE = [
  [103.59, 1.19], [104.07, 1.19], [104.07, 1.43], [103.99, 1.44], [103.90, 1.44],
  [103.85, 1.47], [103.80, 1.46], [103.75, 1.455], [103.70, 1.45], [103.64, 1.35],
  [103.59, 1.30]
];

// Severity runs 1 to 6 on both scales so the client colours them alike.
const PSI_BANDS = [
  [50, 'Good', 1], [100, 'Moderate', 2], [200, 'Unhealthy', 4],
  [300, 'Very unhealthy', 5], [Infinity, 'Hazardous', 6]
];
const US_AQI_BANDS = [
  [50, 'Good', 1], [100, 'Moderate', 2], [150, 'Unhealthy for sensitive groups', 3],
  [200, 'Unhealthy', 4], [300, 'Very unhealthy', 5], [Infinity, 'Hazardous', 6]
];

// Even-odd over every ring given, which handles holes too.
function inRings(rings, lat, lon) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export const inSingapore = (lat, lon) => inRings([SG_OUTLINE], lat, lon);

// About 80 km. A coastal city outside every simplified outline still belongs to
// the country with a sample point this close.
const NEAREST_SAMPLE_DEG = 0.75;

// The country named by the place's label when there is one. Otherwise,
// whichever outline holds the point, and failing that, whichever country has a
// sample point close by.
export function countryFor(code, lat, lon) {
  const named = /^[A-Z]{2}$/.test(code || '') && COUNTRIES.find(c => c.code === code);
  if (named) return named;

  const holder = COUNTRIES.find(({ bbox: [w, s, e, n], polygons }) =>
    lon >= w && lon <= e && lat >= s && lat <= n && inRings(polygons.flat(), lat, lon));
  if (holder) return holder;

  let nearest = null;
  let best = NEAREST_SAMPLE_DEG ** 2;
  for (const country of COUNTRIES) {
    for (const [slat, slon] of country.samples) {
      const d = (slat - lat) ** 2 + (slon - lon) ** 2;
      if (d < best) { best = d; nearest = country; }
    }
  }
  return nearest;
}

// A range that crosses a band boundary names both ends, "Good to moderate",
// and takes the worse end's severity.
function band(low, high, bands) {
  const at = value => bands.find(([max]) => value <= max);
  const [, lowLabel] = at(low);
  const [, highLabel, level] = at(high);
  return {
    band: lowLabel === highLabel ? highLabel : `${lowLabel} to ${highLabel.toLowerCase()}`,
    level
  };
}

function range(values) {
  const finite = values.filter(Number.isFinite).map(Math.round);
  return finite.length ? { low: Math.min(...finite), high: Math.max(...finite) } : null;
}

async function nea(path) {
  const headers = process.env.DATA_GOV_KEY ? { 'x-api-key': process.env.DATA_GOV_KEY } : {};
  const res = await fetch(`${NEA_BASE}/${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`data.gov.sg ${path} answered ${res.status}`);
  const j = await res.json();
  if (j.code !== 0 || !j.data?.items?.length) throw new Error(`data.gov.sg ${path} had no reading`);
  return j.data;
}

async function fromNea() {
  const [psi, pm25] = await Promise.all([nea('psi'), nea('pm25')]);
  const index = range(Object.values(psi.items[0].readings?.psi_twenty_four_hourly || {}));
  if (!index) throw new Error('data.gov.sg PSI had no regional reading');

  return {
    source: 'nea',
    index: 'PSI',
    area: 'islandwide',
    ...index,
    ...band(index.low, index.high, PSI_BANDS),
    pm25: range(Object.values(pm25.items[0].readings?.pm25_one_hourly || {})),
    time: psi.items[0].timestamp
  };
}

async function fromOpenMeteo(lat, lon, country) {
  const countrywide = country?.samples.length > 0;
  const points = countrywide ? country.samples : [[lat, lon]];

  const key = countrywide ? country.code : `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = _cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.body;

  // One request for every point: Open-Meteo takes comma separated lists and
  // answers with an array, or a lone object for a single point.
  const params = new URLSearchParams({
    latitude: points.map(p => p[0]).join(','),
    longitude: points.map(p => p[1]).join(','),
    current: 'us_aqi,pm2_5'
  });
  const res = await fetch(`${OPEN_METEO_AQ}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo air quality answered ${res.status}`);
  const j = await res.json();
  const current = (Array.isArray(j) ? j : [j]).map(r => r.current || {});

  const aqi = range(current.map(c => c.us_aqi));
  if (!aqi) throw new Error('Open-Meteo has no air quality for this place');

  const body = {
    source: 'open-meteo',
    index: 'US AQI',
    area: countrywide ? 'countrywide' : 'here',
    ...aqi,
    ...band(aqi.low, aqi.high, US_AQI_BANDS),
    pm25: range(current.map(c => c.pm2_5)),
    time: current[0].time
  };
  _cache.set(key, { body, expires: Date.now() + TTL_MS });
  if (_cache.size > 500) {
    for (const [k, v] of _cache) if (v.expires <= Date.now()) _cache.delete(k);
  }
  return body;
}

export default async function handler(req, res) {
  const lat = parseFloat(req.query.latitude);
  const lon = parseFloat(req.query.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }

  // Singapore is too small for a sample point of its own, so when NEA fails it
  // falls back to the reading at the point, never to a neighbour's range.
  let body = null;
  let country = null;
  if (inSingapore(lat, lon)) {
    try {
      body = await fromNea();
    } catch (err) {
      console.warn('NEA air quality failed, falling back to Open-Meteo:', err.message);
    }
  } else {
    country = countryFor(req.query.country, lat, lon);
  }
  try {
    body ??= await fromOpenMeteo(lat, lon, country);
  } catch (err) {
    console.warn('Air quality failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'No air quality reading for this place right now' });
    return;
  }

  // NEA publishes on the hour, Open-Meteo hourly too, so the forecast's
  // lifetime is plenty fresh.
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.status(200).json(body);
}
