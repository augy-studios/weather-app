// Air quality for one point, in one shape whatever the source.
//
// Inside Singapore the reading is NEA's own: the 24-hour PSI and the one-hour
// PM2.5 for the nearest of its five regions, from data.gov.sg. Everywhere else,
// and in Singapore whenever data.gov.sg does not answer, it is the US AQI and
// PM2.5 from Open-Meteo's air quality model.
//
// Keep the outline, the bands and the shape in step with air_quality() in
// telegram-bot/weather.py.

const NEA_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';

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

export function inSingapore(lat, lon) {
  let inside = false;
  for (let i = 0, j = SG_OUTLINE.length - 1; i < SG_OUTLINE.length; j = i++) {
    const [xi, yi] = SG_OUTLINE[i];
    const [xj, yj] = SG_OUTLINE[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function band(value, bands) {
  const [, label, level] = bands.find(([max]) => value <= max);
  return { band: label, level };
}

async function nea(path) {
  const headers = process.env.DATA_GOV_KEY ? { 'x-api-key': process.env.DATA_GOV_KEY } : {};
  const res = await fetch(`${NEA_BASE}/${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`data.gov.sg ${path} answered ${res.status}`);
  const j = await res.json();
  if (j.code !== 0 || !j.data?.items?.length) throw new Error(`data.gov.sg ${path} had no reading`);
  return j.data;
}

async function fromNea(lat, lon) {
  const [psi, pm25] = await Promise.all([nea('psi'), nea('pm25')]);
  const readings = psi.items[0].readings;

  const nearest = psi.regionMetadata
    .filter(r => readings.psi_twenty_four_hourly?.[r.name] != null)
    .map(r => ({
      name: r.name,
      d: (r.labelLocation.latitude - lat) ** 2 + (r.labelLocation.longitude - lon) ** 2
    }))
    .sort((a, b) => a.d - b.d)[0];
  if (!nearest) throw new Error('data.gov.sg PSI had no regional reading');

  const value = readings.psi_twenty_four_hourly[nearest.name];
  return {
    source: 'nea',
    index: 'PSI',
    value,
    ...band(value, PSI_BANDS),
    pm25: pm25.items[0].readings?.pm25_one_hourly?.[nearest.name] ?? null,
    region: nearest.name[0].toUpperCase() + nearest.name.slice(1),
    time: psi.items[0].timestamp
  };
}

async function fromOpenMeteo(lat, lon) {
  const params = new URLSearchParams({ latitude: lat, longitude: lon, current: 'us_aqi,pm2_5' });
  const res = await fetch(`${OPEN_METEO_AQ}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo air quality answered ${res.status}`);
  const c = (await res.json()).current || {};
  if (c.us_aqi == null) throw new Error('Open-Meteo has no air quality for this point');
  return {
    source: 'open-meteo',
    index: 'US AQI',
    value: Math.round(c.us_aqi),
    ...band(c.us_aqi, US_AQI_BANDS),
    pm25: c.pm2_5 == null ? null : Math.round(c.pm2_5),
    region: null,
    time: c.time
  };
}

export default async function handler(req, res) {
  const lat = parseFloat(req.query.latitude);
  const lon = parseFloat(req.query.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }

  let body = null;
  if (inSingapore(lat, lon)) {
    try {
      body = await fromNea(lat, lon);
    } catch (err) {
      console.warn('NEA air quality failed, falling back to Open-Meteo:', err.message);
    }
  }
  try {
    body ??= await fromOpenMeteo(lat, lon);
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
