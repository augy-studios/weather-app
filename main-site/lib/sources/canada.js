// Canada: the Meteorological Service of Canada through api.weather.gc.ca. The
// nearest city page gives the observation, the hourly and the day by day
// forecast and any warnings; the AQHI observations give the air quality.
//
// Every value comes as { en, fr }; only the English is read.

import { cached } from '../cache.js';
import { fetchJSON, num, wordsToWmo } from '../wx.js';

const API = 'https://api.weather.gc.ca/collections';
const DAY = 24 * 3600 * 1000;
// A city page further away than this is somebody else's weather.
const MAX_CITY_KM = 120;

const en = (x) => (x == null ? null : typeof x === 'object' ? (x.en ?? null) : x);

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const bboxAround = (lat, lon, dLat, dLon) => [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(3)).join(',');

// The nearest city page's id, kept a week: cities don't move.
async function cityId(lat, lon) {
  const key = `eccc-city-${lat.toFixed(2)},${lon.toFixed(2)}`;
  const { data } = await cached(key, { fresh: 7 * DAY, stale: 60 * DAY }, async () => {
    const j = await fetchJSON(`${API}/citypageweather-realtime/items?f=json&limit=20&bbox=${bboxAround(lat, lon, 1, 1.5)}`, { label: 'MSC', timeout: 12000 });
    let best = null;
    for (const f of j.features || []) {
      const [flon, flat] = f.geometry?.coordinates || [];
      const d = distanceKm(lat, lon, flat, flon);
      if (Number.isFinite(d) && (!best || d < best.km)) best = { id: f.id, km: d };
    }
    if (!best || best.km > MAX_CITY_KM) throw new Error('no MSC city page near here');
    return best;
  });
  return data;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// The forecast names its periods by weekday ("Friday", "Friday night"), not by
// date. The first period's weekday fixes today's date, from the issue time,
// and each change of weekday after it is the next day.
function datedPeriods(group) {
  const forecasts = group?.forecasts || [];
  const issued = Date.parse(en(group?.timestamp) || group?.timestamp) || Date.now();
  const firstDay = WEEKDAYS.indexOf(String(en(forecasts[0]?.period?.value) || '').toLowerCase());
  let date = null;
  for (const offset of [0, -1, 1]) {
    const d = new Date(issued + offset * DAY);
    if (d.getUTCDay() === firstDay) date = d;
  }
  if (!date) return [];

  let weekday = firstDay;
  return forecasts.map((f) => {
    const name = String(en(f.period?.value) || '').toLowerCase();
    const w = WEEKDAYS.indexOf(name);
    if (w >= 0 && w !== weekday) {
      date = new Date(date.getTime() + DAY);
      weekday = w;
    }
    const label = String(en(f.period?.textForecastName) || '');
    return { f, date: date.toISOString().slice(0, 10), night: /night/i.test(label) };
  });
}

function temperatureOf(f, cls) {
  const list = [].concat(f.temperatures?.temperature || []);
  return num(en(list.find((t) => en(t.class) === cls)?.value));
}

async function cityPage(id) {
  return fetchJSON(`${API}/citypageweather-realtime/items/${encodeURIComponent(id)}?f=json`, { label: 'MSC', timeout: 12000 });
}

export async function canada(lat, lon) {
  const { id } = await cityId(lat, lon);
  const p = (await cityPage(id)).properties || {};
  const c = p.currentConditions || {};

  const temp = num(en(c.temperature?.value));
  const pressureKpa = num(en(c.pressure?.value));
  // Humidex in summer, wind chill in winter: Canada's own feels like. The feed
  // also carries a wind chill on mild days that matches no formula (-5 at 10°C
  // in a light breeze), so each is read only where MSC itself would use it.
  const humidex = num(en(c.humidex?.value));
  const windChill = num(en(c.windChill?.value));
  const apparent = temp >= 20 && humidex > temp ? humidex
    : temp <= 0 && windChill < temp ? windChill
    : null;
  const current = temp == null ? null : {
    time: Math.floor((Date.parse(en(c.timestamp)) || Date.now()) / 1000),
    temperature_2m: temp,
    relative_humidity_2m: num(en(c.relativeHumidity?.value)),
    apparent_temperature: apparent,
    wind_speed_10m: num(en(c.wind?.speed?.value)) ?? (String(en(c.wind?.speed?.value)).toLowerCase() === 'calm' ? 0 : null),
    wind_direction_10m: num(en(c.wind?.bearing?.value)),
    surface_pressure: pressureKpa == null ? null : pressureKpa * 10,
    weather_code: wordsToWmo(en(c.condition)),
    station: en(c.station?.value)
  };

  const hourly = (p.hourlyForecastGroup?.hourlyForecasts || []).map((h) => ({
    time: Math.floor(Date.parse(en(h.timestamp) || h.timestamp) / 1000),
    temperature_2m: num(en(h.temperature?.value)),
    precipitation_probability: num(en(h.lop?.value)),
    weather_code: wordsToWmo(en(h.condition))
  })).filter((h) => Number.isFinite(h.time));

  const days = new Map();
  for (const { f, date, night } of datedPeriods(p.forecastGroup)) {
    // A night's low belongs to the next morning.
    const key = night ? new Date(Date.parse(date) + DAY).toISOString().slice(0, 10) : date;
    if (!days.has(key)) days.set(key, { date: key });
    const row = days.get(key);
    if (night) {
      row.temperature_2m_min = temperatureOf(f, 'low');
    } else {
      row.temperature_2m_max = temperatureOf(f, 'high');
      const abbr = f.abbreviatedForecast || {};
      row.weather_code = wordsToWmo(en(abbr.textSummary) || en(f.textSummary));
      const pop = num(en(abbr.pop?.value) ?? en(abbr.pop));
      if (pop != null) row.precipitation_probability_max = pop;
    }
  }

  const alerts = [].concat(p.warnings || []).flatMap((w) => [].concat(w.event || w)).map((w) => ({
    title: en(w.description) || en(w.type) || 'Weather warning',
    event: en(w.type),
    severity: en(w.priority),
    from: en(w.eventIssue?.timestamp) || null,
    until: en(w.expiryTime) || null,
    text: en(w.text) || '',
    url: en(w.url) || 'https://weather.gc.ca/warnings/index_e.html',
    source: 'Environment and Climate Change Canada'
  })).filter((a) => a.title);

  return {
    source: 'eccc',
    name: 'Environment Canada',
    current,
    hourly,
    daily: [...days.values()],
    alerts
  };
}

// ---------- AQHI ----------

// Canada's Air Quality Health Index, on its own published bands, with severity
// on the page's 1 to 6 scale.
export const AQHI_BANDS = [[3, 'Low risk', 1], [6, 'Moderate risk', 2], [10, 'High risk', 4], [Infinity, 'Very high risk', 5]];

/** The latest AQHI at every community within about 100 km. */
export async function canadaAir(lat, lon) {
  const j = await fetchJSON(
    `${API}/aqhi-observations-realtime/items?f=json&limit=200&sortby=-observation_datetime&bbox=${bboxAround(lat, lon, 1, 1.4)}`,
    { label: 'MSC AQHI', timeout: 12000 }
  );
  const byPlace = new Map();
  for (const f of j.features || []) {
    const pr = f.properties || {};
    const value = num(pr.aqhi);
    if (value == null || byPlace.has(pr.location_id)) continue;
    // Sorted newest first, so the first of each community is its latest.
    const [flon, flat] = f.geometry?.coordinates || [];
    byPlace.set(pr.location_id, { name: pr.location_name_en, index: Math.round(value), lat: flat, lon: flon, time: pr.observation_datetime });
  }
  const stations = [...byPlace.values()].filter((s) => Date.now() - Date.parse(s.time) < 6 * 3600 * 1000);
  if (!stations.length) throw new Error('no recent AQHI near here');
  return { source: 'eccc', stations };
}
