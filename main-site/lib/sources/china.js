// China: Seniverse (心知天气, api.seniverse.com) for the weather, and the World
// Air Quality Index Project (aqicn.org, api.waqi.info) for the air, read from
// China's national monitoring network.
//
// Seniverse takes a latitude:longitude, so no city lookup is needed. Its free
// plan answers the current weather with only the sky, its code and the
// temperature, and three days ahead; a paid plan adds the rest of the reading,
// the hourly forecast and warnings, which are read here when it answers them.
// Requests are signed with the public key and an HMAC of the private one, so
// the private key never travels; SENIVERSE_PRIVATE_KEY alone works too.
//
// WAQI needs a free token (WAQI_TOKEN, from aqicn.org/data-platform/token). Its
// figures for China are on the US EPA's AQI scale, the same as Open-Meteo's,
// and it asks to be credited along with the agency that measured them.

import { createHmac } from 'node:crypto';
import { allow } from '../cache.js';
import { fetchJSON, num } from '../wx.js';

const SENIVERSE = 'https://api.seniverse.com/v3/weather';
const WAQI = 'https://api.waqi.info';
const HOUR = 3600 * 1000;

const PUBLIC_KEY = process.env.SENIVERSE_PUBLIC_KEY;
const PRIVATE_KEY = process.env.SENIVERSE_PRIVATE_KEY;

export const chinaConfigured = () => Boolean(PRIVATE_KEY);

// ---------- Seniverse ----------

// Its weather codes, from the docs' table: 0 to 38, 99 for unknown. Wind, cold
// and heat (32 to 38) say nothing of the sky, so they leave Open-Meteo's code.
const CODES = {
  0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3, 9: 3,
  10: 80, 11: 95, 12: 96, 13: 61, 14: 63, 15: 65, 16: 65, 17: 65, 18: 65,
  19: 66, 20: 66, 21: 85, 22: 71, 23: 73, 24: 75, 25: 75,
  26: 45, 27: 45, 28: 45, 29: 45, 30: 45, 31: 45
};
const codeOf = (c) => CODES[num(c)] ?? null;

// Signed: "ts=…&ttl=…&uid=<public key>", HMAC-SHA1 with the private key, base64.
// Should Seniverse turn the signature away, the private key is sent as `key`
// from then on; it is a server-to-server call either way.
let plainKey = !PUBLIC_KEY;
function auth() {
  if (plainKey) return `key=${encodeURIComponent(PRIVATE_KEY)}`;
  const base = `ts=${Math.floor(Date.now() / 1000)}&ttl=300&uid=${encodeURIComponent(PUBLIC_KEY)}`;
  return `${base}&sig=${encodeURIComponent(createHmac('sha1', PRIVATE_KEY).update(base).digest('base64'))}`;
}

class SeniverseError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function ask(path, lat, lon, extra = '') {
  const url = (a) => `${SENIVERSE}/${path}.json?location=${lat.toFixed(2)}:${lon.toFixed(2)}&language=en&unit=c${extra}&${a}`;
  const once = async () => {
    const res = await fetch(url(auth()), { signal: AbortSignal.timeout(8000) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.results?.[0]) {
      throw new SeniverseError(`Seniverse ${path} answered ${res.status}: ${j?.status || 'no results'}`, j?.status_code, res.status);
    }
    return j.results[0];
  };
  try {
    return await once();
  } catch (err) {
    // AP010001 to AP010005: the signature or key was not accepted.
    if (plainKey || !/^AP01000[1-5]$/.test(err.code || '')) throw err;
    console.warn('Seniverse refused the signature, sending the private key instead:', err.message);
    plainKey = true;
    return once();
  }
}

// Parts the plan doesn't cover answer 403 (AP010006); they're not asked again
// on this instance for six hours.
const notInPlan = new Map();
async function optional(path, lat, lon, extra) {
  if (Date.now() < (notInPlan.get(path) || 0)) return null;
  try {
    return await ask(path, lat, lon, extra);
  } catch (err) {
    if (err.status === 403 || err.code === 'AP010006') notInPlan.set(path, Date.now() + 6 * HOUR);
    else console.warn(`Seniverse ${path} failed:`, err.message);
    return null;
  }
}

function current(r) {
  const n = r?.now;
  if (!n || num(n.temperature) == null) return null;
  const time = Date.parse(r.last_update);
  // An observation from hours ago is not the weather now.
  if (!(Date.now() - time < 3 * HOUR)) return null;
  return {
    time: Math.floor(time / 1000),
    temperature_2m: num(n.temperature),
    apparent_temperature: num(n.feels_like),
    relative_humidity_2m: num(n.humidity),
    wind_speed_10m: num(n.wind_speed),
    wind_direction_10m: num(n.wind_direction_degree),
    surface_pressure: num(n.pressure),
    weather_code: codeOf(n.code)
  };
}

function hourly(r) {
  return (r?.hourly || []).map((h) => ({
    time: Math.floor(Date.parse(h.time) / 1000),
    temperature_2m: num(h.temperature),
    relative_humidity_2m: num(h.humidity),
    weather_code: codeOf(h.code)
  })).filter((h) => Number.isFinite(h.time));
}

function daily(r) {
  return (r?.daily || []).map((d) => {
    const codes = [codeOf(d.code_day), codeOf(d.code_night)].filter(Number.isFinite);
    const chance = num(d.precip);
    return {
      date: d.date,
      temperature_2m_max: num(d.high),
      temperature_2m_min: num(d.low),
      precipitation_sum: num(d.rainfall),
      // A fraction, and only outside China so far; empty inside it.
      precipitation_probability_max: chance == null ? null : Math.round(chance * 100),
      // Open-Meteo's daily code is the day's worst weather; this matches it.
      weather_code: codes.length ? Math.max(...codes) : null
    };
  }).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d.date || ''));
}

function alerts(r) {
  return (r?.alarms || []).map((a) => ({
    title: a.title,
    event: a.type,
    severity: a.level,
    from: a.pub_date,
    until: null,
    text: a.description,
    source: 'Seniverse'
  }));
}

/** The weather from Seniverse, or null when it isn't set up. */
export async function china(lat, lon) {
  if (!chinaConfigured()) return null;
  // Up to four calls. The places cron rebuilds each place every ten minutes, so
  // this is held to the per-minute budget like the keyed fallbacks.
  if (!(await allow('seniverse', 4))) throw new Error('Seniverse is over its budget this minute');
  const [now, days, hours, warnings] = await Promise.allSettled([
    ask('now', lat, lon),
    ask('daily', lat, lon, '&start=0&days=15'),
    optional('hourly', lat, lon, '&start=0&hours=24'),
    optional('alarm', lat, lon)
  ]);
  const ok = (x) => (x.status === 'fulfilled' ? x.value : null);
  const c = current(ok(now));
  const d = daily(ok(days));
  if (!c && !d.length) throw new Error(`Seniverse sent nothing: ${(now.reason || days.reason)?.message}`);
  return {
    source: 'seniverse',
    name: 'Seniverse',
    current: c,
    hourly: hourly(ok(hours)),
    daily: d,
    alerts: alerts(ok(warnings))
  };
}

// ---------- air quality: WAQI ----------

// Monitoring stations in a box of about 110 by 120 km round the point. aqi is a
// string, "-" when the station has nothing; time is local, with its offset.
async function stationsAround(lat, lon, token) {
  const box = [lat - 0.5, lon - 0.6, lat + 0.5, lon + 0.6].map((v) => v.toFixed(3)).join(',');
  const j = await fetchJSON(`${WAQI}/map/bounds?latlng=${box}&token=${encodeURIComponent(token)}`, { label: 'WAQI' });
  if (j.status !== 'ok') throw new Error(`WAQI: ${j.data || j.status}`);
  return (j.data || []).map((s) => ({
    name: s.station?.name,
    index: num(s.aqi),
    pm25: null,
    lat: num(s.lat),
    lon: num(s.lon),
    time: s.station?.time
  }));
}

// The nearest station anywhere, for a point with none in its box. Too far, and
// it is somebody else's air; Open-Meteo's model at the point is nearer the mark.
const MAX_NEAREST_KM = 100;

async function nearestStation(lat, lon, token) {
  const j = await fetchJSON(`${WAQI}/feed/geo:${lat.toFixed(3)};${lon.toFixed(3)}/?token=${encodeURIComponent(token)}`, { label: 'WAQI' });
  if (j.status !== 'ok') throw new Error(`WAQI: ${j.data || j.status}`);
  const d = j.data || {};
  const [slat, slon] = d.city?.geo || [];
  const rad = Math.PI / 180;
  const km = 12742 * Math.asin(Math.sqrt(Math.sin(((slat - lat) * rad) / 2) ** 2 +
    Math.cos(lat * rad) * Math.cos(slat * rad) * Math.sin(((slon - lon) * rad) / 2) ** 2));
  if (!(km <= MAX_NEAREST_KM)) throw new Error('no WAQI station within 100 km');
  // iaqi.pm25 is PM2.5's own AQI, not a concentration, so it isn't passed on.
  return [{ name: d.city?.name, index: num(d.aqi), pm25: null, lat: slat, lon: slon, time: d.time?.iso }];
}

/** The US AQI at the monitoring stations round the point, from WAQI. */
export async function chinaAir(lat, lon) {
  const token = process.env.WAQI_TOKEN;
  if (!token) throw new Error('WAQI_TOKEN is not set');
  const recent = (s) => s.index != null && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
    Date.now() - Date.parse(s.time) < 3 * HOUR;
  let stations = (await stationsAround(lat, lon, token)).filter(recent);
  if (!stations.length) stations = (await nearestStation(lat, lon, token)).filter(recent);
  if (!stations.length) throw new Error('no recent WAQI reading near here');
  return { source: 'waqi', stations };
}
