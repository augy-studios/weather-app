// Air quality for the country a point is in, as a low to high range, in one
// shape whatever the source. Served by api/air.js, which the Telegram bot reads
// too, and kept warm by the places cron.
//
// - Singapore: NEA's own, the 24-hour PSI and the one-hour PM2.5, each as the
//   islandwide range across its five regions, the way NEA reports them, with
//   the pollutants behind the PSI for the point's region. Read from the copy the
//   sg cron keeps (lib/nea.js), so a busy minute at data.gov.sg doesn't push
//   Singapore onto Open-Meteo's model.
// - Norway: NILU's measuring stations, or MET Norway's forecast, on the
//   Norwegian 1 to 4 index (lib/sources/norway.js).
// - Canada: the AQHI at the communities round the point (lib/sources/canada.js).
// - China: the US AQI at the monitoring stations round the point, from the World
//   Air Quality Index Project, with WAQI_TOKEN set (lib/sources/china.js).
// - Everywhere else: the US AQI and PM2.5 from Open-Meteo's air quality model,
//   read at a grid of sample points across the country (lib/build-countries.mjs).
//   A country too small for any sample point, or a point in no country at all,
//   gets the reading at the point itself.
// - When Open-Meteo fails: WeatherAPI, OpenWeather or Xweather at the point,
//   as a US AQI worked out from their PM2.5 where they give no index.
//
// Alongside the range come `regions`, one reading per region or station, and
// `region`, the one the point falls in or is nearest. `area` says what the range
// covers: "islandwide", "countrywide", "nearby" (stations round the point) or
// "here".

import { cached } from './cache.js';
import { countryFor } from './country.js';
import { latest } from './datagov.js';
import { readSg } from './nea.js';
import { inSingapore } from './singapore.js';
import { AQHI_BANDS, canadaAir } from './sources/canada.js';
import { chinaAir } from './sources/china.js';
import { fallbackAir } from './sources/fallbacks.js';
import { NORWAY_BANDS, norwayAir } from './sources/norway.js';

const OPEN_METEO_AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const MIN = 60 * 1000;

// Severity runs 1 to 6 on every scale so the client colours them alike.
const PSI_BANDS = [
  [50, 'Good', 1], [100, 'Moderate', 2], [200, 'Unhealthy', 4],
  [300, 'Very unhealthy', 5], [Infinity, 'Hazardous', 6]
];
const US_AQI_BANDS = [
  [50, 'Good', 1], [100, 'Moderate', 2], [150, 'Unhealthy for sensitive groups', 3],
  [200, 'Unhealthy', 4], [300, 'Very unhealthy', 5], [Infinity, 'Hazardous', 6]
];

// NEA's hourly PSI may be used for this long after its hour.
const NEA_MAX_AGE_MS = 3 * 3600 * 1000;

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

function range(values, digits = 0) {
  const k = 10 ** digits;
  const finite = values.filter(Number.isFinite).map(v => Math.round(v * k) / k);
  return finite.length ? { low: Math.min(...finite), high: Math.max(...finite) } : null;
}

// One region's entry, in the same shape as the top level range, or null when
// none of its readings came back.
function regionReading(name, indexValues, pm25Values, bands, digits = 0) {
  const index = range(indexValues, digits);
  return index && { name, ...index, ...band(index.low, index.high, bands), pm25: range(pm25Values) };
}

// NEA's order, which the compass regions follow too.
const REGION_ORDER = ['north', 'south', 'east', 'west', 'central'];

// Fewer sample points than this and a country is not split into regions.
const MIN_REGION_SAMPLES = 5;

// A central disc holding about a fifth of the points, like each of the other
// four. In a round country that is √0.2 of the radius, and the median distance
// is √0.5 of it, so the disc ends at about 0.63 of the median distance.
const CENTRAL_SHARE = 0.63;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Longitude difference folded into -180..180, so Russia's Chukotka sits east.
const dLon = (a, b) => ((a - b + 540) % 360) - 180;

// The region name of every sample point, in the same order. Measured from the
// median point rather than the middle of the bounding box, and scaled by the
// median distance, so outlying parts like Alaska or French Guiana fold into the
// region in their direction without dragging the centre or the scale with them.
const _compass = new Map();
function compassRegions(country) {
  if (_compass.has(country.code)) return _compass.get(country.code);
  const { samples } = country;
  const clat = median(samples.map(s => s[0]));
  const clon = median(samples.map(s => s[1]));
  const k = Math.cos((clat * Math.PI) / 180);
  const offsets = samples.map(([lat, lon]) => [dLon(lon, clon) * k, lat - clat]);
  const reach = median(offsets.map(([x, y]) => Math.hypot(x, y)));
  const names = offsets.map(([x, y]) => {
    if (Math.hypot(x, y) < CENTRAL_SHARE * reach) return 'central';
    if (Math.abs(y) >= Math.abs(x)) return y > 0 ? 'north' : 'south';
    return x > 0 ? 'east' : 'west';
  });
  _compass.set(country.code, names);
  return names;
}

// Index of the point nearest (lat, lon), on the same flattened scale.
function nearest(points, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  points.forEach(([plat, plon], i) => {
    const d = (dLon(plon, lon) * k) ** 2 + (plat - lat) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// ---------- Singapore: NEA ----------

// The pollutants behind the PSI, as NEA names and measures them.
const NEA_POLLUTANTS = [
  ['pm25_twenty_four_hourly', 'PM2.5', '24-hour mean', 'µg/m³'],
  ['pm10_twenty_four_hourly', 'PM10', '24-hour mean', 'µg/m³'],
  ['o3_eight_hour_max', 'Ozone', '8-hour max', 'µg/m³'],
  ['no2_one_hour_max', 'Nitrogen dioxide', '1-hour max', 'µg/m³'],
  ['so2_twenty_four_hourly', 'Sulphur dioxide', '24-hour mean', 'µg/m³'],
  ['co_eight_hour_max', 'Carbon monoxide', '8-hour max', 'mg/m³']
];

// The PSI and PM2.5 feeds: the sg cron's copy while it is recent, else asked now.
async function neaFeeds() {
  const kept = await readSg().catch(() => null);
  const fresh = (d) => d?.items?.[0]?.timestamp && Date.now() - Date.parse(d.items[0].timestamp) < NEA_MAX_AGE_MS;
  if (fresh(kept?.psi) && fresh(kept?.pm25)) return [kept.psi, kept.pm25];
  return Promise.all([latest('psi'), latest('pm25')]);
}

async function fromNea(lat, lon) {
  const [psi, pm25] = await neaFeeds();
  const readings = psi.items?.[0]?.readings || {};
  const psiBy = readings.psi_twenty_four_hourly || {};
  const pm25By = pm25.items?.[0]?.readings?.pm25_one_hourly || {};
  const index = range(Object.values(psiBy));
  if (!index) throw new Error('data.gov.sg PSI had no regional reading');

  // The point's region is the one whose label NEA places nearest to it.
  const located = (psi.regionMetadata || [])
    .map(({ name, labelLocation: at }) =>
      ({ at: [at?.latitude, at?.longitude], reading: regionReading(name, [psiBy[name]], [pm25By[name]], PSI_BANDS) }))
    .filter(r => r.reading && r.at.every(Number.isFinite));
  const here = located[nearest(located.map(r => r.at), lat, lon)]?.reading ?? null;

  return {
    source: 'nea',
    index: 'PSI',
    area: 'islandwide',
    ...index,
    ...band(index.low, index.high, PSI_BANDS),
    pm25: range(Object.values(pm25By)),
    time: psi.items[0].timestamp,
    region: here,
    regions: located.map(r => r.reading),
    pollutants: here ? NEA_POLLUTANTS
      .map(([key, name, period, unit]) => ({ name, period, unit, value: readings[key]?.[here.name] ?? null }))
      .filter(p => Number.isFinite(p.value)) : []
  };
}

// ---------- stations round the point: Norway, Canada, China ----------

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function fromStations({ source, stations }, lat, lon, { index, bands, digits = 0 }) {
  const ranked = stations
    .map(s => ({ ...s, km: distanceKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 6);
  const all = range(ranked.map(s => s.index), digits);
  if (!all) throw new Error('no station reading');
  const regions = ranked.map(s => regionReading(s.name, [s.index], [s.pm25], bands, digits)).filter(Boolean);
  return {
    source,
    index,
    area: ranked.length > 1 ? 'nearby' : 'here',
    regionKind: 'station',
    ...all,
    ...band(all.low, all.high, bands),
    pm25: range(ranked.map(s => s.pm25)),
    time: ranked[0].time,
    region: regions[0] ?? null,
    regions: ranked.length > 1 ? regions : []
  };
}

// ---------- Open-Meteo, countrywide ----------

// The raw reading at every point, kept so that places in the same country
// share it whichever region each one falls in.
async function readPoints(key, points) {
  const { data } = await cached(`air-om-${key}`, { fresh: 10 * MIN, stale: 3 * 60 * MIN }, async () => {
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
    return (Array.isArray(j) ? j : [j]).map(r => r.current || {});
  });
  return data;
}

async function fromOpenMeteo(lat, lon, country) {
  const countrywide = country?.samples.length > 0;
  const points = countrywide ? country.samples : [[lat, lon]];
  const current = await readPoints(
    countrywide ? country.code : `${lat.toFixed(2)},${lon.toFixed(2)}`, points);

  const aqi = range(current.map(c => c.us_aqi));
  if (!aqi) throw new Error('Open-Meteo has no air quality for this place');

  let regions = [];
  let region = null;
  if (countrywide && points.length >= MIN_REGION_SAMPLES) {
    const names = compassRegions(country);
    regions = REGION_ORDER
      .map(name => {
        const inRegion = current.filter((_, i) => names[i] === name);
        return regionReading(name, inRegion.map(c => c.us_aqi), inRegion.map(c => c.pm2_5), US_AQI_BANDS);
      })
      .filter(Boolean);
    // The region of the sample point nearest the place, among those that read.
    const reading = points.map((p, i) => Number.isFinite(current[i].us_aqi) ? p : [NaN, NaN]);
    const name = names[nearest(reading, lat, lon)];
    region = regions.find(r => r.name === name) ?? null;
  }

  return {
    source: 'open-meteo',
    index: 'US AQI',
    area: countrywide ? 'countrywide' : 'here',
    ...aqi,
    ...band(aqi.low, aqi.high, US_AQI_BANDS),
    pm25: range(current.map(c => c.pm2_5)),
    time: current[0].time,
    region,
    regions
  };
}

// ---------- the keyed fallbacks, at the point ----------

async function fromFallback(lat, lon) {
  // Half an hour per spot: these are the free tiers, and air moves slowly.
  const { data } = await cached(`air-fb-${lat.toFixed(1)},${lon.toFixed(1)}`, { fresh: 30 * MIN, stale: 6 * 60 * MIN }, () => fallbackAir(lat, lon));
  const aqi = range([data.aqi]);
  return {
    source: data.source,
    index: 'US AQI',
    area: 'here',
    ...aqi,
    ...band(aqi.low, aqi.high, US_AQI_BANDS),
    pm25: range([data.pm25]),
    time: Number.isFinite(data.time) ? new Date(data.time * 1000).toISOString() : data.time,
    region: null,
    regions: []
  };
}

// ---------- routing ----------

const NATIONAL = {
  NO: (lat, lon) => cached(`air-no-${lat.toFixed(2)},${lon.toFixed(2)}`, { fresh: 15 * MIN, stale: 3 * 60 * MIN }, () => norwayAir(lat, lon))
    .then(({ data }) => fromStations(data, lat, lon, { index: 'AQI', bands: NORWAY_BANDS, digits: 1 })),
  CA: (lat, lon) => cached(`air-ca-${lat.toFixed(1)},${lon.toFixed(1)}`, { fresh: 15 * MIN, stale: 3 * 60 * MIN }, () => canadaAir(lat, lon))
    .then(({ data }) => fromStations(data, lat, lon, { index: 'AQHI', bands: AQHI_BANDS })),
  // Without a token, China is Open-Meteo's countrywide range like anywhere else.
  ...process.env.WAQI_TOKEN && { CN: (lat, lon) => cached(`air-cn-${lat.toFixed(1)},${lon.toFixed(1)}`, { fresh: 15 * MIN, stale: 3 * 60 * MIN }, () => chinaAir(lat, lon))
    .then(({ data }) => fromStations(data, lat, lon, { index: 'US AQI', bands: US_AQI_BANDS })) }
};

/**
 * The air quality for a point, from the source meant for its country, or the
 * next one that answers. `intended` is false for a stand-in, which callers
 * should hold only briefly. Throws when nothing answers.
 */
export async function airFor(lat, lon, code) {
  // Singapore is too small for a sample point of its own, so when NEA fails it
  // falls back to the reading at the point, never to a neighbour's range.
  let body = null;
  let country = null;
  const sg = inSingapore(lat, lon);
  if (sg) {
    body = await fromNea(lat, lon).catch(err => {
      console.warn('NEA air quality failed, falling back:', err.message);
      return null;
    });
  } else {
    country = countryFor(code, lat, lon);
    const national = NATIONAL[country?.code];
    if (national) {
      body = await national(lat, lon).catch(err => {
        console.warn(`${country.code} air quality failed, falling back:`, err.message);
        return null;
      });
    }
  }
  body ??= await fromOpenMeteo(lat, lon, country).catch(err => {
    console.warn('Open-Meteo air quality failed:', err.message);
    return fromFallback(lat, lon);
  });

  const standIns = ['open-meteo', 'weatherapi', 'openweather', 'xweather'];
  const intended = sg ? body.source === 'nea'
    : NATIONAL[country?.code] ? !standIns.includes(body.source)
    : body.source === 'open-meteo';
  return { body, intended };
}
