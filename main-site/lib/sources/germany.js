// Germany: the Deutscher Wetterdienst's open data. Bright Sky (api.brightsky.dev)
// serves it as JSON: the nearest station's observation, the MOSMIX hourly
// forecast, DWD's warnings and the rain radar (see api/radar.js). When Bright
// Sky is down, the observation comes straight from opendata.dwd.de, the
// station's own hourly report, for the station Bright Sky named last time.
//
// Data: Deutscher Wetterdienst, CC BY 4.0. The page credits it.

import { cached, peek } from '../cache.js';
import { dateKey, fetchJSON, fetchText, num } from '../wx.js';

const BRIGHTSKY = 'https://api.brightsky.dev';
const DWD_POI = 'https://opendata.dwd.de/weather/weather_reports/poi';
const ZONE = 'Europe/Berlin';
const DAY = 24 * 3600 * 1000;

const ICONS = {
  'clear-day': 0, 'clear-night': 0, 'partly-cloudy-day': 2, 'partly-cloudy-night': 2,
  cloudy: 3, fog: 45, rain: 63, sleet: 66, snow: 73, hail: 96, thunderstorm: 95
};
const CONDITIONS = { fog: 45, rain: 63, sleet: 66, snow: 73, hail: 96, thunderstorm: 95 };
const codeOf = (w) => ICONS[w?.icon] ?? CONDITIONS[w?.condition] ?? null;

const stationKey = (lat, lon) => `dwd-station-${lat.toFixed(1)},${lon.toFixed(1)}`;

async function brightSkyNow(lat, lon) {
  const j = await fetchJSON(`${BRIGHTSKY}/current_weather?lat=${lat}&lon=${lon}`, { label: 'Bright Sky' });
  const w = j.weather || {};
  const s = (j.sources || []).find((x) => x.id === w.source_id) || j.sources?.[0] || {};
  // Remembered, so that opendata.dwd.de can be asked for the same station when
  // Bright Sky can't be. Written once a month at most.
  if (/^\d{5}$/.test(s.wmo_station_id || '')) {
    cached(stationKey(lat, lon), { fresh: 30 * DAY }, async () => ({ id: s.wmo_station_id, name: s.station_name }))
      .catch(() => {});
  }
  if (num(w.temperature) == null) throw new Error('Bright Sky had no temperature');
  return {
    time: Math.floor(Date.parse(w.timestamp) / 1000),
    temperature_2m: num(w.temperature),
    relative_humidity_2m: num(w.relative_humidity),
    wind_speed_10m: num(w.wind_speed_10 ?? w.wind_speed_30),
    wind_direction_10m: num(w.wind_direction_10 ?? w.wind_direction_30),
    surface_pressure: num(w.pressure_msl),
    weather_code: codeOf(w),
    station: s.station_name,
    stationKm: num(s.distance) == null ? null : s.distance / 1000
  };
}

// The station's hourly report: semicolon separated, a row of English column
// names first, newest observation first, decimal commas, "---" for nothing.
async function dwdNow(lat, lon) {
  const station = (await peek(stationKey(lat, lon)))?.data;
  if (!station?.id) throw new Error('no DWD station known for this place yet');
  const lines = (await fetchText(`${DWD_POI}/${station.id}-BEOB.csv`, { label: 'opendata.dwd.de' })).trim().split(/\r?\n/);
  const names = lines[0].split(';');
  const row = lines[3]?.split(';');
  if (!row) throw new Error('the DWD report was empty');
  const col = (re) => {
    const i = names.findIndex((n) => re.test(n));
    return i < 0 ? null : num(row[i] === '---' ? null : row[i]);
  };
  const [d, m, y] = row[0].split('.');
  const time = Date.parse(`20${y}-${m}-${d}T${row[1]}:00Z`);
  if (!(Date.now() - time < 3 * 3600 * 1000)) throw new Error('the DWD report is stale');
  return {
    time: time / 1000,
    temperature_2m: col(/^dry_bulb_temperature_at_2_meter/),
    relative_humidity_2m: col(/^relative_humidity/),
    wind_speed_10m: col(/^mean_wind_speed_during/),
    wind_direction_10m: col(/^mean_wind_direction_during/),
    surface_pressure: col(/^pressure_reduced_to_mean_sea_level/),
    station: station.name
  };
}

async function hourly(lat, lon) {
  const from = new Date(Date.now() - 3600 * 1000).toISOString();
  const to = new Date(Date.now() + 4 * DAY).toISOString();
  const j = await fetchJSON(`${BRIGHTSKY}/weather?lat=${lat}&lon=${lon}&date=${from}&last_date=${to}`, { label: 'Bright Sky' });
  return (j.weather || []).map((w) => ({
    time: Math.floor(Date.parse(w.timestamp) / 1000),
    temperature_2m: num(w.temperature),
    precipitation: num(w.precipitation),
    precipitation_probability: num(w.precipitation_probability),
    relative_humidity_2m: num(w.relative_humidity),
    weather_code: codeOf(w)
  }));
}

async function alerts(lat, lon) {
  const j = await fetchJSON(`${BRIGHTSKY}/alerts?lat=${lat}&lon=${lon}`, { label: 'Bright Sky' });
  return (j.alerts || []).map((a) => ({
    title: a.headline_en || a.event_en || a.headline_de,
    event: a.event_en,
    severity: a.severity,
    from: a.onset || a.effective,
    until: a.expires,
    text: [a.description_en || a.description_de, a.instruction_en].filter(Boolean).join('\n\n'),
    source: 'Deutscher Wetterdienst'
  }));
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
      return {
        date,
        temperature_2m_max: Math.max(...temps),
        temperature_2m_min: Math.min(...temps),
        precipitation_sum: Math.round(pick('precipitation').reduce((a, b) => a + b, 0) * 10) / 10,
        precipitation_probability_max: pick('precipitation_probability').length ? Math.max(...pick('precipitation_probability')) : null,
        weather_code: pick('weather_code').length ? Math.max(...pick('weather_code')) : null
      };
    });
}

export async function germany(lat, lon) {
  const [now, hours, warnings] = await Promise.allSettled([
    brightSkyNow(lat, lon).catch(async (err) => {
      console.warn('Bright Sky current failed, trying opendata.dwd.de:', err.message);
      return dwdNow(lat, lon);
    }),
    hourly(lat, lon),
    alerts(lat, lon)
  ]);
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  if (!ok(now) && !ok(hours)) throw new Error(`DWD sent nothing: ${now.reason?.message}`);
  return {
    source: 'dwd',
    name: 'the Deutscher Wetterdienst',
    current: ok(now),
    hourly: ok(hours) || [],
    daily: daily(ok(hours) || []),
    alerts: ok(warnings) || []
  };
}
