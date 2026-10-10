// Switzerland: MeteoSwiss's open data.
//
// - The reading now: SwissMetNet, the automatic stations, every ten minutes.
//   One small file holds the latest values of every station (VQHA80.csv); the
//   stations' places come from the network's list, read once a week.
// - The forecast: MeteoSwiss's own ICON-CH1 and ICON-CH2 runs, through
//   Open-Meteo's MeteoSwiss API (models=meteoswiss_icon_seamless): about a
//   kilometre apart, hourly, five days ahead. MeteoSwiss's post-processed local
//   forecast is open too, but each of its files holds every point in the country
//   (up to 33 MB an hour each), which is a job for a cron of its own.
//
// Both files are semicolon separated, timestamps in UTC, "-" or nothing for a
// missing value. The station list is Windows-1252.
//
// Data: MeteoSwiss. Its terms ask for "Source: MeteoSwiss"; the page credits it.

import { cached } from '../cache.js';
import { dateKey, fetchJSON, HttpError, num, USER_AGENT } from '../wx.js';

const CURRENT = 'https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv';
const STATIONS = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ZONE = 'Europe/Zurich';
const HOUR = 3600 * 1000;

// A station further than this, or this much higher or lower than the place, is
// measuring somewhere else. In the Alps the second matters more than the first.
const MAX_KM = 20;
const MAX_CLIMB_M = 300;
// Without the place's height to compare, only a station close by will do.
const MAX_KM_UNKNOWN_HEIGHT = 8;

async function fetchCsv(url, label, encoding = 'latin1') {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new HttpError(`${label} answered ${res.status}`, res.status);
  const text = new TextDecoder(encoding).decode(await res.arrayBuffer());
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const names = head.split(';');
  return rows.map((line) => {
    const cells = line.split(';');
    return Object.fromEntries(names.map((n, i) => [n, cells[i]]));
  });
}

const missing = (v) => (v === '-' ? null : num(v));

async function stations() {
  const { data } = await cached('meteoswiss-stations', { fresh: 7 * 24 * HOUR, stale: 60 * 24 * HOUR }, async () =>
    (await fetchCsv(STATIONS, 'MeteoSwiss stations', 'windows-1252'))
      .map((s) => ({
        id: s.station_abbr,
        name: s.station_name,
        lat: num(s.station_coordinates_wgs84_lat),
        lon: num(s.station_coordinates_wgs84_lon),
        height: num(s.station_height_masl)
      }))
      .filter((s) => s.id && s.lat != null && s.lon != null));
  return data;
}

// Every station's latest values, kept five minutes: the file changes every ten.
async function latest() {
  const { data } = await cached('meteoswiss-now', { fresh: 5 * 60 * 1000, stale: HOUR, blob: false }, () =>
    fetchCsv(CURRENT, 'MeteoSwiss'));
  return data;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** The nearest SwissMetNet station's reading, at a like height, from the last hour. */
async function smnNow(lat, lon, elevation) {
  const [list, rows] = await Promise.all([stations(), latest()]);
  const byId = new Map(rows.map((r) => [r['Station/Location'], r]));
  const maxKm = elevation == null ? MAX_KM_UNKNOWN_HEIGHT : MAX_KM;
  const candidates = list
    .map((s) => ({ ...s, km: distanceKm(lat, lon, s.lat, s.lon), row: byId.get(s.id) }))
    .filter((s) => s.row && s.km <= maxKm &&
      (elevation == null || s.height == null || Math.abs(s.height - elevation) <= MAX_CLIMB_M))
    .sort((a, b) => a.km - b.km);

  for (const s of candidates) {
    const r = s.row;
    const d = r.Date || '';
    const time = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12));
    const temperature = missing(r.tre200s0);
    if (temperature == null || !(Date.now() - time < HOUR)) continue;
    return {
      time: time / 1000,
      temperature_2m: temperature,
      relative_humidity_2m: missing(r.ure200s0),
      wind_speed_10m: missing(r.fu3010z0),
      wind_direction_10m: missing(r.dkl010z0),
      // Reduced to sea level (QFF), as the other services give it.
      surface_pressure: missing(r.pp0qffs0),
      station: s.name,
      stationLat: s.lat,
      stationLon: s.lon,
      stationKm: Math.round(s.km * 10) / 10
    };
  }
  return null;
}

async function iconCh(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    models: 'meteoswiss_icon_seamless',
    timezone: ZONE,
    timeformat: 'unixtime',
    hourly: 'temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code',
    forecast_days: '6'
  });
  const j = await fetchJSON(`${FORECAST}?${params}`, { label: 'Open-Meteo MeteoSwiss' });
  const h = j.hourly || {};
  // The run ends before the sixth day does; its hours past that are nulls.
  const hours = (h.time || []).map((time, i) => ({
    time,
    temperature_2m: h.temperature_2m?.[i] ?? null,
    relative_humidity_2m: h.relative_humidity_2m?.[i] ?? null,
    precipitation: h.precipitation?.[i] ?? null,
    precipitation_probability: h.precipitation_probability?.[i] ?? null,
    weather_code: h.weather_code?.[i] ?? null
  })).filter((r) => r.temperature_2m != null);
  if (!hours.length) throw new Error('ICON-CH has no forecast here');
  return { hours, elevation: num(j.elevation) };
}

function daily(hours) {
  const days = new Map();
  for (const h of hours) {
    const date = dateKey(h.time * 1000, ZONE);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(h);
  }
  return [...days]
    .filter(([, rows]) => rows.length >= 20)
    .map(([date, rows]) => {
      const pick = (k) => rows.map((r) => r[k]).filter(Number.isFinite);
      const temps = pick('temperature_2m');
      const chance = pick('precipitation_probability');
      const codes = pick('weather_code');
      return {
        date,
        temperature_2m_max: Math.max(...temps),
        temperature_2m_min: Math.min(...temps),
        precipitation_sum: Math.round(pick('precipitation').reduce((a, b) => a + b, 0) * 10) / 10,
        precipitation_probability_max: chance.length ? Math.max(...chance) : null,
        // Open-Meteo's daily code is the day's worst weather; this matches it.
        weather_code: codes.length ? Math.max(...codes) : null
      };
    });
}

export async function switzerland(lat, lon) {
  const forecast = await iconCh(lat, lon).catch((err) => {
    console.warn('ICON-CH failed:', err.message);
    return null;
  });
  const now = await smnNow(lat, lon, forecast?.elevation ?? null).catch((err) => {
    console.warn('SwissMetNet failed:', err.message);
    return null;
  });
  if (!now && !forecast) throw new Error('MeteoSwiss sent nothing');
  const hours = forecast?.hours || [];
  return {
    source: 'meteoswiss',
    name: 'MeteoSwiss',
    current: now,
    hourly: hours,
    daily: daily(hours),
    alerts: []
  };
}
