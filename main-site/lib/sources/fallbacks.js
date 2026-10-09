// The keyed services, for when Open-Meteo does not answer: WeatherAPI.com,
// then OpenWeather, then Xweather. Each answer is reshaped into Open-Meteo's
// own (metric, unix times), so the page draws it without knowing the difference.
//
// All three are on free plans, so each call is counted against the budget in
// lib/cache.js first, and a provider over its budget is skipped, not waited on.
// Their answers are cached with the rest of the place (see lib/place.js), so a
// failing Open-Meteo costs one call per place per ten minutes, not one per visitor.

import { allow } from '../cache.js';
import { FIELDS } from './openmeteo.js';
import { fetchJSON, num, usAqiFromPm25, wordsToWmo } from '../wx.js';

const OWM_KEY = process.env.OPEN_WEATHER_KEY;
const WAPI_KEY = process.env.WEATHER_API_KEY;
const [XW_ID, XW_SECRET] = process.env.XWEATHER_CLIENT_ID && process.env.XWEATHER_CLIENT_SECRET
  ? [process.env.XWEATHER_CLIENT_ID, process.env.XWEATHER_CLIENT_SECRET]
  : (process.env.XWEATHER_KEY || '').split(':');

export const keyed = {
  weatherapi: Boolean(WAPI_KEY),
  openweather: Boolean(OWM_KEY),
  xweather: Boolean(XW_ID && XW_SECRET)
};

export const XWEATHER_AUTH = keyed.xweather ? { id: XW_ID, secret: XW_SECRET } : null;
export const OPEN_WEATHER_KEY = OWM_KEY;

// ---------- into Open-Meteo's shape ----------

// Daily rows are stamped at noon UTC on their date, which lands on that date in
// every zone from -11 to +11, so the page's dateKey(time, zone) agrees.
const noonOf = (date) => Date.parse(`${date}T12:00:00Z`) / 1000;

function columns(rows, fields) {
  const out = { time: rows.map((r) => r.time) };
  for (const f of fields) out[f] = rows.map((r) => r[f] ?? null);
  return out;
}

function shaped({ source, timezone, current, hours, days, alerts = [] }) {
  return {
    source,
    timezone,
    current,
    hourly: columns(hours, FIELDS.hourly),
    daily: columns(days, FIELDS.daily),
    alerts
  };
}

// Several readings a day, folded into one row per local date.
function foldDays(hours, offsetSeconds) {
  const byDate = new Map();
  for (const h of hours) {
    const date = new Date((h.time + offsetSeconds) * 1000).toISOString().slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(h);
  }
  const max = (xs) => (xs.length ? Math.max(...xs) : null);
  const min = (xs) => (xs.length ? Math.min(...xs) : null);
  const finite = (rows, k) => rows.map((r) => r[k]).filter(Number.isFinite);
  return [...byDate].map(([date, rows]) => ({
    time: noonOf(date),
    weather_code: max(finite(rows, 'weather_code')),
    temperature_2m_max: max(finite(rows, 'temperature_2m')),
    temperature_2m_min: min(finite(rows, 'temperature_2m')),
    precipitation_sum: finite(rows, 'precipitation').reduce((a, b) => a + b, 0),
    precipitation_probability_max: max(finite(rows, 'precipitation_probability')),
    wind_speed_10m_max: max(finite(rows, 'wind_speed_10m')),
    uv_index_max: max(finite(rows, 'uv_index'))
  }));
}

// ---------- WeatherAPI.com ----------

// Its condition codes, from weatherapi.com/docs/weather_conditions.json.
const WAPI_CODES = {
  1000: 0, 1003: 2, 1006: 3, 1009: 3, 1030: 45, 1063: 80, 1066: 85, 1069: 66, 1072: 56,
  1087: 95, 1114: 73, 1117: 75, 1135: 45, 1147: 48, 1150: 51, 1153: 51, 1168: 56, 1171: 57,
  1180: 61, 1183: 61, 1186: 63, 1189: 63, 1192: 65, 1195: 65, 1198: 66, 1201: 67, 1204: 66,
  1207: 67, 1210: 71, 1213: 71, 1216: 73, 1219: 73, 1222: 75, 1225: 75, 1237: 77, 1240: 80,
  1243: 81, 1246: 82, 1249: 85, 1252: 86, 1255: 85, 1258: 86, 1261: 77, 1264: 77, 1273: 95,
  1276: 95, 1279: 95, 1282: 95
};
const wapiCode = (c) => WAPI_CODES[c?.code] ?? wordsToWmo(c?.text);

async function weatherapi(lat, lon) {
  const params = new URLSearchParams({ key: WAPI_KEY, q: `${lat},${lon}`, days: '3', aqi: 'no', alerts: 'yes' });
  const j = await fetchJSON(`https://api.weatherapi.com/v1/forecast.json?${params}`, { label: 'WeatherAPI' });
  const c = j.current || {};
  const hours = (j.forecast?.forecastday || []).flatMap((d) => d.hour || []).map((h) => ({
    time: h.time_epoch,
    temperature_2m: h.temp_c,
    apparent_temperature: h.feelslike_c,
    precipitation_probability: Math.max(num(h.chance_of_rain) ?? 0, num(h.chance_of_snow) ?? 0),
    precipitation: h.precip_mm,
    weather_code: wapiCode(h.condition),
    is_day: h.is_day,
    uv_index: h.uv,
    relative_humidity_2m: h.humidity
  }));
  const days = (j.forecast?.forecastday || []).map((d) => ({
    time: noonOf(d.date),
    weather_code: wapiCode(d.day?.condition),
    temperature_2m_max: d.day?.maxtemp_c,
    temperature_2m_min: d.day?.mintemp_c,
    precipitation_sum: d.day?.totalprecip_mm,
    precipitation_probability_max: Math.max(num(d.day?.daily_chance_of_rain) ?? 0, num(d.day?.daily_chance_of_snow) ?? 0),
    wind_speed_10m_max: d.day?.maxwind_kph,
    uv_index_max: d.day?.uv
  }));
  return shaped({
    source: 'weatherapi',
    timezone: j.location?.tz_id,
    current: {
      time: c.last_updated_epoch,
      temperature_2m: c.temp_c,
      relative_humidity_2m: c.humidity,
      apparent_temperature: c.feelslike_c,
      precipitation: c.precip_mm,
      weather_code: wapiCode(c.condition),
      is_day: c.is_day,
      wind_speed_10m: c.wind_kph,
      wind_direction_10m: c.wind_degree,
      surface_pressure: c.pressure_mb
    },
    hours,
    days,
    alerts: (j.alerts?.alert || []).map((a) => ({
      title: a.headline || a.event,
      event: a.event,
      severity: a.severity,
      from: a.effective,
      until: a.expires,
      text: a.desc,
      source: 'WeatherAPI.com'
    }))
  });
}

// ---------- OpenWeather (the free 2.5 endpoints) ----------

function owmCode(w) {
  const id = w?.id;
  if (!Number.isFinite(id)) return null;
  if (id < 300) return 95;
  if (id < 400) return 53;
  if (id === 500) return 61;
  if (id === 501) return 63;
  if (id < 505) return 65;
  if (id === 511) return 66;
  if (id < 600) return id === 520 ? 80 : 81;
  if (id === 600) return 71;
  if (id === 601) return 73;
  if (id === 602) return 75;
  if (id < 620) return 66;
  if (id < 700) return 85;
  if (id < 800) return 45;
  return { 800: 0, 801: 1, 802: 2 }[id] ?? 3;
}

// OpenWeather gives the zone only as an offset. A whole number of hours has an
// IANA name the page can use; anything else falls back to UTC.
function zoneOf(offsetSeconds) {
  const h = offsetSeconds / 3600;
  if (!Number.isInteger(h)) return 'UTC';
  return h === 0 ? 'UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
}

async function openweather(lat, lon) {
  const q = new URLSearchParams({ lat, lon, units: 'metric', appid: OWM_KEY });
  const [now, ahead] = await Promise.all([
    fetchJSON(`https://api.openweathermap.org/data/2.5/weather?${q}`, { label: 'OpenWeather' }),
    fetchJSON(`https://api.openweathermap.org/data/2.5/forecast?${q}`, { label: 'OpenWeather' })
  ]);
  const offset = now.timezone ?? ahead.city?.timezone ?? 0;
  // Every three hours, for five days.
  const hours = (ahead.list || []).map((h) => ({
    time: h.dt,
    temperature_2m: h.main?.temp,
    apparent_temperature: h.main?.feels_like,
    precipitation_probability: Number.isFinite(h.pop) ? Math.round(h.pop * 100) : null,
    precipitation: (h.rain?.['3h'] ?? 0) + (h.snow?.['3h'] ?? 0),
    weather_code: owmCode(h.weather?.[0]),
    is_day: h.sys?.pod === 'n' ? 0 : 1,
    uv_index: null,
    relative_humidity_2m: h.main?.humidity,
    wind_speed_10m: Number.isFinite(h.wind?.speed) ? h.wind.speed * 3.6 : null
  }));
  return shaped({
    source: 'openweather',
    timezone: zoneOf(offset),
    current: {
      time: now.dt,
      temperature_2m: now.main?.temp,
      relative_humidity_2m: now.main?.humidity,
      apparent_temperature: now.main?.feels_like,
      precipitation: now.rain?.['1h'] ?? 0,
      weather_code: owmCode(now.weather?.[0]),
      is_day: now.dt > now.sys?.sunrise && now.dt < now.sys?.sunset ? 1 : 0,
      wind_speed_10m: Number.isFinite(now.wind?.speed) ? now.wind.speed * 3.6 : null,
      wind_direction_10m: now.wind?.deg,
      surface_pressure: now.main?.pressure
    },
    hours,
    days: foldDays(hours, offset)
  });
}

// ---------- Xweather ----------

// The last part of weatherPrimaryCoded, "coverage:intensity:weather".
const XW_WEATHER = {
  A: 96, BD: 45, BN: 45, BR: 45, BS: 75, F: 45, FR: 0, H: 45, IC: 77, IF: 48, IP: 66, K: 45,
  L: 53, R: 63, RW: 80, RS: 66, SI: 66, WM: 66, S: 73, SW: 85, T: 95, UP: 61, VA: 45, WP: 95,
  ZF: 48, ZL: 56, ZR: 66, CL: 0, FW: 1, SC: 2, BK: 3, OV: 3
};

function xwCode(coded, words) {
  const [, intensity, weather] = String(coded || '').split(':');
  let code = XW_WEATHER[weather];
  if (code === 63 && /L/.test(intensity || '')) code = 61;
  if (code === 63 && /H/.test(intensity || '')) code = 65;
  return code ?? wordsToWmo(words);
}

async function xw(path, params) {
  const q = new URLSearchParams({ ...params, client_id: XW_ID, client_secret: XW_SECRET });
  const j = await fetchJSON(`https://data.api.xweather.com/${path}?${q}`, { label: 'Xweather' });
  if (j.success === false) throw new Error(`Xweather: ${j.error?.description || j.error?.code || 'refused'}`);
  return Array.isArray(j.response) ? j.response[0] : j.response;
}

async function xweather(lat, lon) {
  const at = `${lat},${lon}`;
  const [now, hourly, daily] = await Promise.all([
    xw(`conditions/${at}`, {}),
    xw(`forecasts/${at}`, { filter: '1hr', limit: '48' }),
    xw(`forecasts/${at}`, { filter: 'day', limit: '7' })
  ]);
  const c = now?.periods?.[0] || {};
  const hours = (hourly?.periods || []).map((p) => ({
    time: p.timestamp,
    temperature_2m: p.tempC ?? p.avgTempC,
    apparent_temperature: p.feelslikeC,
    precipitation_probability: p.pop,
    precipitation: p.precipMM,
    weather_code: xwCode(p.weatherPrimaryCoded, p.weather),
    is_day: p.isDay ? 1 : 0,
    uv_index: p.uvi,
    relative_humidity_2m: p.humidity
  }));
  const zone = hourly?.profile?.tz || now?.profile?.tz;
  const days = (daily?.periods || []).map((p) => ({
    time: noonOf(String(p.dateTimeISO || new Date(p.timestamp * 1000).toISOString()).slice(0, 10)),
    weather_code: xwCode(p.weatherPrimaryCoded, p.weather),
    temperature_2m_max: p.maxTempC,
    temperature_2m_min: p.minTempC,
    precipitation_sum: p.precipMM,
    precipitation_probability_max: p.pop,
    wind_speed_10m_max: p.windSpeedMaxKPH ?? p.windSpeedKPH,
    uv_index_max: p.uvi
  }));
  return shaped({
    source: 'xweather',
    timezone: zone,
    current: {
      time: c.timestamp,
      temperature_2m: c.tempC,
      relative_humidity_2m: c.humidity,
      apparent_temperature: c.feelslikeC,
      precipitation: c.precipMM,
      weather_code: xwCode(c.weatherPrimaryCoded, c.weather),
      is_day: c.isDay ? 1 : 0,
      wind_speed_10m: c.windSpeedKPH,
      wind_direction_10m: c.windDirDEG,
      surface_pressure: c.pressureMB
    },
    hours,
    days
  });
}

// ---------- the chain ----------

const FORECASTS = [
  ['weatherapi', weatherapi, 1],
  ['openweather', openweather, 2],
  ['xweather', xweather, 3]
];

/** The first keyed service that answers within its budget, in Open-Meteo's shape. */
export async function fallbackForecast(lat, lon) {
  const reasons = [];
  for (const [name, fn, cost] of FORECASTS) {
    if (!keyed[name]) continue;
    if (!(await allow(name, cost))) {
      reasons.push(`${name} is over its free budget`);
      continue;
    }
    try {
      const out = await fn(lat, lon);
      if (!out.current || !Number.isFinite(out.current.temperature_2m)) throw new Error('no current reading');
      return out;
    } catch (err) {
      reasons.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`no fallback forecast (${reasons.join('; ') || 'no keys set'})`);
}

// ---------- air quality ----------

async function weatherapiAir(lat, lon) {
  const params = new URLSearchParams({ key: WAPI_KEY, q: `${lat},${lon}`, aqi: 'yes' });
  const j = await fetchJSON(`https://api.weatherapi.com/v1/current.json?${params}`, { label: 'WeatherAPI' });
  const pm25 = num(j.current?.air_quality?.pm2_5);
  return { aqi: usAqiFromPm25(pm25), pm25, time: j.current?.last_updated_epoch };
}

async function openweatherAir(lat, lon) {
  const q = new URLSearchParams({ lat, lon, appid: OWM_KEY });
  const j = await fetchJSON(`https://api.openweathermap.org/data/2.5/air_pollution?${q}`, { label: 'OpenWeather' });
  const row = j.list?.[0];
  const pm25 = num(row?.components?.pm2_5);
  return { aqi: usAqiFromPm25(pm25), pm25, time: row?.dt };
}

async function xweatherAir(lat, lon) {
  const r = await xw(`airquality/${lat},${lon}`, {});
  const p = r?.periods?.[0] || {};
  const pm = (p.pollutants || []).find((x) => /pm2\.?5/i.test(x.type || ''));
  const pm25 = num(pm?.valueUGM3);
  return { aqi: num(p.aqi) ?? usAqiFromPm25(pm25), pm25, time: p.timestamp };
}

const AIRS = [
  ['weatherapi', weatherapiAir],
  ['openweather', openweatherAir],
  ['xweather', xweatherAir]
];

/** US AQI and PM2.5 at the point, from the first keyed service that answers. */
export async function fallbackAir(lat, lon) {
  for (const [name, fn] of AIRS) {
    if (!keyed[name] || !(await allow(name))) continue;
    try {
      const out = await fn(lat, lon);
      if (Number.isFinite(out.aqi)) return { ...out, source: name };
    } catch (err) {
      console.warn(`air fallback ${name} failed:`, err.message);
    }
  }
  throw new Error('no fallback air quality');
}
