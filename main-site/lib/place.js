// One place's weather, put together once and kept: the base forecast, the
// national weather service's readings laid over it, and the sea where there is
// one. /api/forecast serves it; the places cron (api/cron/places.js) rebuilds it
// ahead of anybody asking for every place looked at recently.
//
// The base is Open-Meteo, or when it fails WeatherAPI, OpenWeather or Xweather
// in its shape (lib/sources/fallbacks.js). The national services:
//
//   US  api.weather.gov            NO  api.met.no
//   CA  api.weather.gc.ca          DE  api.brightsky.dev, opendata.dwd.de
//   GB  environment.data.gov.uk    SG  NEA, drawn by the page from /api/sg
//   CN  api.seniverse.com, with its keys set
//
// A national value replaces Open-Meteo's for the same field and time; anything
// it leaves out stays Open-Meteo's. Everything is metric until present().

import { cached, peek, store } from './cache.js';
import { countryCode } from './country.js';
import { canada } from './sources/canada.js';
import { china } from './sources/china.js';
import { fallbackForecast } from './sources/fallbacks.js';
import { germany } from './sources/germany.js';
import { nearestFlash } from './sources/lightning-ca.js';
import { norway } from './sources/norway.js';
import { forecast as openMeteo, marine } from './sources/openmeteo.js';
import { unitedKingdom } from './sources/uk.js';
import { unitedStates } from './sources/us.js';
import { dateKey } from './wx.js';

export const FRESH_MS = 10 * 60 * 1000;

// A source may answer null when it isn't set up; the place is Open-Meteo's then.
const NATIONAL = { US: unitedStates, NO: norway, CA: canada, DE: germany, GB: unitedKingdom, CN: china };

// About a kilometre: close enough that two searches for one town share a copy.
export const placeKey = (lat, lon) => `place-${lat.toFixed(2)},${lon.toFixed(2)}`;
export const roundPlace = (lat, lon) => [Number(lat.toFixed(2)), Number(lon.toFixed(2))];

// ---------- laying a national service over the base ----------

const CURRENT_FIELDS = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation',
  'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'surface_pressure'
];
const HOURLY_FIELDS = ['temperature_2m', 'precipitation_probability', 'precipitation', 'weather_code', 'relative_humidity_2m'];
const DAILY_FIELDS = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'weather_code'];

function overlay(base, nat) {
  const used = new Set();
  const out = structuredClone(base);

  const c = nat.current;
  if (c) {
    for (const f of CURRENT_FIELDS) {
      if (c[f] != null && Number.isFinite(c[f])) {
        out.current[f] = c[f];
        used.add('current');
      }
    }
    // The base's feels like goes with the base's temperature. Shown beside a
    // national reading, it would disagree with it, so it is moved by the same
    // difference unless the service gave a feels like of its own.
    if (c.apparent_temperature == null && c.temperature_2m != null && Number.isFinite(base.current.apparent_temperature)) {
      out.current.apparent_temperature = base.current.apparent_temperature + (c.temperature_2m - base.current.temperature_2m);
    }
  }

  const hourIndex = new Map((out.hourly?.time || []).map((t, i) => [t, i]));
  for (const h of nat.hourly || []) {
    const i = hourIndex.get(h.time);
    if (i == null) continue;
    for (const f of HOURLY_FIELDS) {
      if (h[f] != null && Number.isFinite(h[f]) && out.hourly[f]) {
        out.hourly[f][i] = h[f];
        used.add('hourly');
      }
    }
  }

  const zone = out.timezone;
  const dayIndex = new Map((out.daily?.time || []).map((t, i) => [dateKey(t * 1000, zone), i]));
  for (const d of nat.daily || []) {
    const i = dayIndex.get(d.date);
    if (i == null) continue;
    for (const f of DAILY_FIELDS) {
      if (d[f] != null && Number.isFinite(d[f]) && out.daily[f]) {
        out.daily[f][i] = d[f];
        used.add('daily');
      }
    }
  }
  return { out, used: [...used] };
}

// ---------- building ----------

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms).unref?.())
]);

/** Everything about one place, in metric. Throws only when no base answered. */
export async function buildPlace(lat, lon, code) {
  const country = countryCode(code, lat, lon);
  const national = NATIONAL[country];

  const [om, nat, sea, flash] = await Promise.allSettled([
    openMeteo(lat, lon),
    national ? national(lat, lon) : Promise.resolve(null),
    marine(lat, lon),
    // Lightning near the place, where a national network reports it and the
    // page doesn't already have it: NEA's comes through /api/sg.
    // GeoMet can take half a minute; the forecast doesn't wait past a few seconds.
    country === 'CA' ? withTimeout(nearestFlash(lat, lon, 20), 6000) : Promise.resolve(null)
  ]);
  if (om.status === 'rejected') console.warn('Open-Meteo failed:', om.reason?.message);
  if (nat.status === 'rejected') console.warn(`${country} national service failed:`, nat.reason?.message);

  const base = om.status === 'fulfilled' ? om.value : await fallbackForecast(lat, lon);
  const { out, used } = nat.value ? overlay(base, nat.value) : { out: base, used: [] };

  const c = nat.value?.current;
  return {
    ...out,
    country,
    builtAt: Date.now(),
    national: nat.value ? {
      source: nat.value.source,
      name: nat.value.name,
      used,
      station: c?.station || null,
      stationLat: c?.stationLat ?? null,
      stationLon: c?.stationLon ?? null,
      stationKm: c?.stationKm ?? null,
      observedAt: c?.time ?? null
    } : null,
    alerts: [...(nat.value?.alerts || []), ...(base.alerts || [])]
      .filter((a) => !a.until || Date.parse(a.until) > Date.now()),
    history: nat.value?.history || null,
    marine: sea.status === 'fulfilled' ? sea.value : null,
    // { km, t } for the nearest lit cell within 20 km in the last ten minutes.
    lightning: flash.status === 'fulfilled' && flash.value?.nearest
      ? { ...flash.value.nearest, source: 'eccc' }
      : null
  };
}

/**
 * The place's bundle from the nearest copy: this instance, then Blob, then
 * built afresh. A copy up to a day old stands in when nothing answers.
 */
export function getPlace(lat, lon, code) {
  const [rlat, rlon] = roundPlace(lat, lon);
  return cached(placeKey(rlat, rlon), { fresh: FRESH_MS }, () => buildPlace(rlat, rlon, code));
}

/** For the cron: rebuild unless the stored copy is still fresh. */
export async function warmPlace(lat, lon, code, { freshMs = FRESH_MS } = {}) {
  const key = placeKey(lat, lon);
  const kept = await peek(key);
  if (kept && Date.now() - kept.savedAt < freshMs) return 'fresh';
  await store(key, await buildPlace(lat, lon, code));
  return 'built';
}

// ---------- serving, in the reader's units ----------

const F = (c) => (c == null ? c : Math.round((c * 1.8 + 32) * 10) / 10);
const MPH = (kmh) => (kmh == null ? kmh : Math.round(kmh * 0.621371 * 10) / 10);

const TEMP_FIELDS = ['temperature_2m', 'apparent_temperature', 'temperature_2m_max', 'temperature_2m_min'];
const WIND_FIELDS = ['wind_speed_10m', 'wind_speed_10m_max'];

function convertBlock(block) {
  if (!block) return block;
  const out = { ...block };
  for (const f of TEMP_FIELDS) {
    if (Array.isArray(out[f])) out[f] = out[f].map(F);
    else if (f in out) out[f] = F(out[f]);
  }
  for (const f of WIND_FIELDS) {
    if (Array.isArray(out[f])) out[f] = out[f].map(MPH);
    else if (f in out) out[f] = MPH(out[f]);
  }
  return out;
}

/** The bundle as the page reads it: metric, or imperial converted here. */
export function present(bundle, imperial) {
  if (!imperial) return { ...bundle, units: 'metric' };
  // Wave heights stay in metres here; the page turns them into feet.
  const marine = bundle.marine && {
    ...bundle.marine,
    seaTemperature: F(bundle.marine.seaTemperature),
    currentSpeed: MPH(bundle.marine.currentSpeed)
  };
  return {
    ...bundle,
    units: 'imperial',
    current: convertBlock(bundle.current),
    hourly: convertBlock(bundle.hourly),
    daily: convertBlock(bundle.daily),
    minutely_15: convertBlock(bundle.minutely_15),
    marine
  };
}
