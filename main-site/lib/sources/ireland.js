// Ireland: Met Éireann's point forecast (openaccess.pf.api.met.ie). HARMONIE,
// hourly, for the first two days or so; ECMWF in steps of three and six hours
// after. The reading now is the forecast's first hour, unless MeteoGate has a
// station close by (lib/sources/meteogate.js, laid over it in lib/place.js).
//
// The answer is XML in MET Norway's old locationforecast shape: a <time> with
// from = to for each instant (temperature, wind, humidity, pressure), and one
// with from < to for each interval (precipitation, the symbol).
//
// Data: Met Éireann, CC BY 4.0. Its terms ask for the credit and its
// disclaimer; the page carries both.

import { cached } from '../cache.js';
import { dateKey, fetchText, num } from '../wx.js';

// Plain http, as documented. https redirects to an Azure host whose TLS
// handshake fails; it is public data between servers either way.
const API = 'http://openaccess.pf.api.met.ie/metno-wdb2ts/locationforecast';
const ZONE = 'Europe/Dublin';
const HOUR = 3600 * 1000;

// Symbol names, without a "Dark_" night prefix. Thunder anywhere is a storm;
// "Sun" on the end means showers between sunny spells.
function symbolCode(name) {
  const s = String(name || '').replace(/^Dark_?/i, '');
  if (!s) return null;
  if (/Thunder/i.test(s)) return 95;
  const showers = /Sun$/.test(s) && s !== 'Sun';
  if (/Sleet/.test(s)) return /Heavy/.test(s) ? 67 : 66;
  if (/Snow/.test(s)) {
    if (showers) return /Heavy/.test(s) ? 86 : 85;
    return /Heavy/.test(s) ? 75 : /Light/.test(s) ? 71 : 73;
  }
  if (/Drizzle/.test(s)) return showers ? 80 : 51;
  if (/Rain/.test(s)) {
    if (showers) return /Light/.test(s) ? 80 : 81;
    return /Heavy/.test(s) ? 65 : /Light/.test(s) ? 61 : 63;
  }
  if (/Fog/.test(s)) return 45;
  return { Sun: 0, LightCloud: 1, PartlyCloud: 2, Cloud: 3 }[s] ?? null;
}

// Enough of an XML reader for this one format: each <time> block, its two
// times, and the attributes of the elements inside it.
const attr = (tag, name) => tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const element = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>`))?.[0];

function parse(xml) {
  const instants = [];
  const intervals = [];
  for (const [, head, body] of xml.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/g)) {
    const from = Date.parse(attr(head, 'from'));
    const to = Date.parse(attr(head, 'to'));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from === to) {
      const speed = num(attr(element(body, 'windSpeed'), 'mps'));
      instants.push({
        time: from / 1000,
        temperature_2m: num(attr(element(body, 'temperature'), 'value')),
        relative_humidity_2m: num(attr(element(body, 'humidity'), 'value')),
        wind_speed_10m: speed == null ? null : Math.round(speed * 36) / 10,
        wind_direction_10m: num(attr(element(body, 'windDirection'), 'deg')),
        surface_pressure: num(attr(element(body, 'pressure'), 'value'))
      });
    } else {
      const rain = element(body, 'precipitation');
      intervals.push({
        from, to,
        precipitation: num(attr(rain, 'value')),
        precipitation_probability: num(attr(rain, 'probability')),
        weather_code: symbolCode(attr(element(body, 'symbol'), 'id'))
      });
    }
  }
  return { instants, intervals };
}

async function locationforecast(lat, lon) {
  // Each run lands about every three hours; twenty minutes keeps well inside it.
  const key = `met-eireann-${lat.toFixed(3)},${lon.toFixed(3)}`;
  const { data } = await cached(key, { fresh: 20 * 60 * 1000, stale: 6 * HOUR, blob: false }, () =>
    fetchText(`${API}?lat=${lat.toFixed(4)};long=${lon.toFixed(4)}`, { label: 'Met Éireann', timeout: 10000 }));
  return data;
}

// Intervals that tile the timeline without overlapping, the shortest first
// where several end together, so precipitation isn't counted twice.
function tiling(intervals) {
  const shortest = new Map();
  for (const iv of intervals) {
    const kept = shortest.get(iv.to);
    if (!kept || iv.to - iv.from < kept.to - kept.from) shortest.set(iv.to, iv);
  }
  const out = [];
  let reached = -Infinity;
  for (const iv of [...shortest.values()].sort((a, b) => a.from - b.from)) {
    if (iv.from < reached) continue;
    out.push(iv);
    reached = iv.to;
  }
  return out;
}

export async function ireland(lat, lon) {
  const { instants, intervals } = parse(await locationforecast(lat, lon));
  if (!instants.length) throw new Error('Met Éireann sent no forecast');
  const steps = tiling(intervals);

  // Hourly: the instant at each hour, with the hour ending then, which is how
  // Open-Meteo times its precipitation and its weather code.
  const hourEnding = new Map(steps.filter((iv) => iv.to - iv.from === HOUR).map((iv) => [iv.to / 1000, iv]));
  const hourly = instants
    .filter((r) => hourEnding.has(r.time))
    .map((r) => {
      const iv = hourEnding.get(r.time);
      return {
        time: r.time,
        temperature_2m: r.temperature_2m,
        relative_humidity_2m: r.relative_humidity_2m,
        precipitation: iv.precipitation,
        precipitation_probability: iv.precipitation_probability == null ? null : Math.round(iv.precipitation_probability),
        weather_code: iv.weather_code
      };
    });

  const nowS = Date.now() / 1000;
  const now = [...instants].reverse().find((r) => r.time <= nowS) || instants[0];
  const nowStep = steps.find((iv) => iv.from / 1000 <= now.time && now.time < iv.to / 1000) || steps[0];

  // Days in Ireland's own zone: the temperatures at every instant, the
  // precipitation over the steps, the worst symbol.
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, temps: [], codes: [], rain: 0, chance: [], hours: 0 });
    return days.get(date);
  };
  for (const r of instants) if (r.temperature_2m != null) day(dateKey(r.time * 1000, ZONE)).temps.push(r.temperature_2m);
  for (const iv of steps) {
    const d = day(dateKey(iv.from, ZONE));
    d.rain += iv.precipitation ?? 0;
    d.hours += (iv.to - iv.from) / HOUR;
    if (iv.weather_code != null) d.codes.push(iv.weather_code);
    if (iv.precipitation_probability != null) d.chance.push(iv.precipitation_probability);
  }

  return {
    source: 'met-eireann',
    name: 'Met Éireann',
    current: {
      time: now.time,
      temperature_2m: now.temperature_2m,
      relative_humidity_2m: now.relative_humidity_2m,
      wind_speed_10m: now.wind_speed_10m,
      wind_direction_10m: now.wind_direction_10m,
      surface_pressure: now.surface_pressure,
      weather_code: nowStep?.weather_code ?? null
    },
    hourly,
    // Only days the forecast covers whole; the first and last are partial.
    daily: [...days.values()]
      .filter((d) => d.temps.length >= 4 && d.hours >= 18)
      .map((d) => ({
        date: d.date,
        temperature_2m_max: Math.max(...d.temps),
        temperature_2m_min: Math.min(...d.temps),
        precipitation_sum: Math.round(d.rain * 10) / 10,
        precipitation_probability_max: d.chance.length ? Math.round(Math.max(...d.chance)) : null,
        // Open-Meteo's daily code is the day's worst weather; this matches it.
        weather_code: d.codes.length ? Math.max(...d.codes) : null
      })),
    alerts: []
  };
}
