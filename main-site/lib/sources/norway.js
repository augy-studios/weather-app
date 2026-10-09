// Norway: MET Norway's locationforecast for the weather, and NILU's measured
// air quality, with MET Norway's air quality forecast standing in for NILU.
//
// MET's terms: an identifying User-Agent (lib/wx.js), coordinates to no more
// than four decimals, and no asking again before the answer's Expires time.
// Its data and NILU's are CC BY 4.0; the page credits both.
//
// NILU's api.nilu.no now asks for a login (HTTP Basic). Set NILU_AUTH to
// "user:password" to use it; without it, or when it fails, the air quality is
// MET Norway's forecast for the hour, on the same 1 to 4 Norwegian scale.

import { cached } from '../cache.js';
import { dateKey, fetchJSON, num } from '../wx.js';

const MET = 'https://api.met.no/weatherapi';
const NILU = 'https://api.nilu.no';
const ZONE = 'Europe/Oslo';

const fixed = (v) => Number(v.toFixed(4));

// MET's symbol names, without the _day/_night/_polartwilight ending.
const SYMBOLS = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightsleet: 66, sleet: 66, heavysleet: 67,
  lightsleetshowers: 66, sleetshowers: 66, heavysleetshowers: 67,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86
};

function symbolCode(symbol) {
  const s = String(symbol || '').replace(/_(day|night|polartwilight)$/, '');
  if (!s) return null;
  if (s.includes('thunder')) return 95;
  return SYMBOLS[s] ?? null;
}

async function locationforecast(lat, lon) {
  // MET's own answers say when to ask again, about half an hour on; twenty
  // minutes here keeps well inside that.
  const key = `metno-${lat.toFixed(3)},${lon.toFixed(3)}`;
  const { data } = await cached(key, { fresh: 20 * 60 * 1000, stale: 6 * 3600 * 1000, blob: false }, () =>
    fetchJSON(`${MET}/locationforecast/2.0/compact?lat=${fixed(lat)}&lon=${fixed(lon)}`, { label: 'MET Norway' }));
  return data;
}

export async function norway(lat, lon) {
  const series = (await locationforecast(lat, lon)).properties?.timeseries || [];
  if (!series.length) throw new Error('MET Norway sent no forecast');

  const rows = series.map((e) => {
    const d = e.data?.instant?.details || {};
    const next1 = e.data?.next_1_hours;
    const next6 = e.data?.next_6_hours;
    return {
      time: Math.floor(Date.parse(e.time) / 1000),
      hourly: Boolean(next1),
      temperature_2m: num(d.air_temperature),
      relative_humidity_2m: num(d.relative_humidity),
      wind_speed_10m: num(d.wind_speed) == null ? null : d.wind_speed * 3.6,
      wind_direction_10m: num(d.wind_from_direction),
      surface_pressure: num(d.air_pressure_at_sea_level),
      precipitation: num((next1 || next6)?.details?.precipitation_amount),
      weather_code: symbolCode((next1 || next6 || e.data?.next_12_hours)?.summary?.symbol_code)
    };
  });

  // The entry for the hour now is the forecast's nowcast: MET's own best value
  // for this moment.
  const nowS = Date.now() / 1000;
  const now = [...rows].reverse().find((r) => r.time <= nowS) || rows[0];

  // Days in Norway's own zone. Precipitation is summed from the one hour steps
  // where there are any, the six hour steps after.
  const days = new Map();
  for (const r of rows) {
    const date = dateKey(r.time * 1000, ZONE);
    if (!days.has(date)) days.set(date, { date, temps: [], codes: [], rain: 0 });
    const d = days.get(date);
    if (r.temperature_2m != null) d.temps.push(r.temperature_2m);
    if (r.weather_code != null) d.codes.push(r.weather_code);
    d.rain += r.precipitation ?? 0;
  }

  return {
    source: 'met-norway',
    name: 'MET Norway',
    current: {
      time: now.time,
      temperature_2m: now.temperature_2m,
      relative_humidity_2m: now.relative_humidity_2m,
      wind_speed_10m: now.wind_speed_10m,
      wind_direction_10m: now.wind_direction_10m,
      surface_pressure: now.surface_pressure,
      weather_code: now.weather_code
    },
    hourly: rows.filter((r) => r.hourly).map(({ hourly, ...r }) => r),
    daily: [...days.values()]
      .filter((d) => d.temps.length >= 4)
      .map((d) => ({
        date: d.date,
        temperature_2m_max: Math.max(...d.temps),
        temperature_2m_min: Math.min(...d.temps),
        // Open-Meteo's daily code is the day's worst weather; this matches it.
        weather_code: d.codes.length ? Math.max(...d.codes) : null,
        precipitation_sum: Math.round(d.rain * 10) / 10
      })),
    alerts: []
  };
}

// ---------- air quality ----------

// The Norwegian index: 1 low, 2 moderate, 3 high, 4 very high. Severity on the
// page's 1 to 6 scale, so the colours mean the same as PSI's and US AQI's.
export const NORWAY_BANDS = [[1.99, 'Low', 1], [2.99, 'Moderate', 2], [3.99, 'High', 4], [Infinity, 'Very high', 5]];

async function nilu(lat, lon) {
  const auth = process.env.NILU_AUTH;
  if (!auth) throw new Error('NILU_AUTH is not set');
  const rows = await fetchJSON(`${NILU}/aq/utd/${fixed(lat)}/${fixed(lon)}/20`, {
    headers: { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` },
    label: 'NILU'
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('NILU has no station within 20 km');

  // One entry per station: its worst component's index, and its PM2.5.
  const byStation = new Map();
  for (const r of rows) {
    if (!(r.index > 0)) continue;
    const s = byStation.get(r.station) || { name: r.station, index: 0, pm25: null, lat: r.latitude, lon: r.longitude, time: r.toTime };
    s.index = Math.max(s.index, r.index);
    if (/^pm2\.?5$/i.test(r.component || '')) s.pm25 = num(r.value);
    byStation.set(r.station, s);
  }
  const stations = [...byStation.values()];
  if (!stations.length) throw new Error('NILU had no valid reading near here');
  return { source: 'nilu', stations };
}

async function metAir(lat, lon) {
  const j = await fetchJSON(`${MET}/airqualityforecast/0.1/?lat=${fixed(lat)}&lon=${fixed(lon)}`, { label: 'MET Norway air quality' });
  const now = Date.now();
  const hours = j.data?.time || [];
  const hour = hours.find((h) => Date.parse(h.from) <= now && now < Date.parse(h.from) + 3600 * 1000) || hours[0];
  const v = hour?.variables || {};
  const index = num(v.AQI?.value);
  if (index == null) throw new Error('MET Norway had no air quality for this hour');
  return {
    source: 'met-norway',
    stations: [{
      name: j.meta?.superlocation?.name || j.meta?.location?.name || 'here',
      index: Math.round(index * 10) / 10,
      pm25: num(v.pm25_concentration?.value),
      lat, lon,
      time: hour.from
    }]
  };
}

/** Air quality near the point on the Norwegian index, from NILU or MET Norway. */
export async function norwayAir(lat, lon) {
  try {
    return await nilu(lat, lon);
  } catch (err) {
    if (process.env.NILU_AUTH) console.warn('NILU failed, using MET Norway:', err.message);
    return metAir(lat, lon);
  }
}
