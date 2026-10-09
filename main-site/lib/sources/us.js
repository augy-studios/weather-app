// The US National Weather Service, api.weather.gov: the nearest station's
// latest observation, the hourly and 12-hour forecasts for the place's grid
// square, and any warnings in force there. Open-Meteo fills whatever it leaves
// out (UV, the fifteen-minute rain, the days past its seven).
//
// /points is the expensive lookup and its answer barely changes, so it and the
// station list are kept for a week.

import { cached } from '../cache.js';
import { fetchJSON, num, wordsToWmo } from '../wx.js';

const API = 'https://api.weather.gov';
const DAY = 24 * 3600 * 1000;
const OBS_MAX_AGE_MS = 2 * 3600 * 1000;

const nws = (url) => fetchJSON(url, { headers: { accept: 'application/geo+json' }, label: 'NWS' });

async function pointOf(lat, lon) {
  const key = `nws-point-${lat.toFixed(3)},${lon.toFixed(3)}`;
  const { data } = await cached(key, { fresh: 7 * DAY, stale: 60 * DAY }, async () => {
    const p = (await nws(`${API}/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).properties;
    const stations = await nws(p.observationStations).catch(() => null);
    return {
      forecast: p.forecast,
      hourly: p.forecastHourly,
      stations: (stations?.features || []).slice(0, 3).map((f) => ({
        id: f.properties?.stationIdentifier,
        name: f.properties?.name,
        lat: f.geometry?.coordinates?.[1],
        lon: f.geometry?.coordinates?.[0]
      }))
    };
  });
  return data;
}

// The first nearby station with a recent temperature.
async function observation(stations) {
  for (const s of stations) {
    const p = (await nws(`${API}/stations/${s.id}/observations/latest`).catch(() => null))?.properties;
    const temp = num(p?.temperature?.value);
    if (temp == null || !(Date.now() - Date.parse(p.timestamp) < OBS_MAX_AGE_MS)) continue;
    const pressurePa = num(p.barometricPressure?.value);
    return {
      time: Math.floor(Date.parse(p.timestamp) / 1000),
      temperature_2m: temp,
      relative_humidity_2m: num(p.relativeHumidity?.value),
      // Feels like, NWS style: heat index in the heat, wind chill in the cold.
      apparent_temperature: num(p.heatIndex?.value) ?? num(p.windChill?.value),
      wind_speed_10m: num(p.windSpeed?.value),
      wind_direction_10m: num(p.windDirection?.value),
      surface_pressure: pressurePa == null ? null : pressurePa / 100,
      weather_code: wordsToWmo(p.textDescription),
      precipitation: num(p.precipitationLastHour?.value),
      station: s.name,
      stationLat: s.lat,
      stationLon: s.lon
    };
  }
  return null;
}

function hourlyOf(j) {
  return (j?.properties?.periods || []).map((p) => ({
    time: Math.floor(Date.parse(p.startTime) / 1000),
    temperature_2m: num(p.temperature),
    precipitation_probability: num(p.probabilityOfPrecipitation?.value),
    relative_humidity_2m: num(p.relativeHumidity?.value),
    weather_code: wordsToWmo(p.shortForecast),
    is_day: p.isDaytime ? 1 : 0
  }));
}

// Twelve-hour periods into days. A night's low is the next morning's, so it
// goes to the date the night ends on, as Open-Meteo's daily minimum would.
function dailyOf(j) {
  const days = new Map();
  const row = (date) => {
    if (!days.has(date)) days.set(date, { date });
    return days.get(date);
  };
  for (const p of j?.properties?.periods || []) {
    const pop = num(p.probabilityOfPrecipitation?.value);
    if (p.isDaytime) {
      const r = row(p.startTime.slice(0, 10));
      r.temperature_2m_max = num(p.temperature);
      r.weather_code = wordsToWmo(p.shortForecast);
      r.precipitation_probability_max = Math.max(r.precipitation_probability_max ?? 0, pop ?? 0);
    } else {
      const r = row(p.endTime.slice(0, 10));
      r.temperature_2m_min = num(p.temperature);
    }
  }
  return [...days.values()];
}

async function alertsAt(lat, lon) {
  const j = await nws(`${API}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
  return (j.features || []).map(({ properties: a }) => ({
    title: a.headline || a.event,
    event: a.event,
    severity: a.severity,
    from: a.onset || a.effective,
    until: a.ends || a.expires,
    text: [a.description, a.instruction].filter(Boolean).join('\n\n'),
    source: a.senderName || 'National Weather Service'
  }));
}

export async function unitedStates(lat, lon) {
  const point = await pointOf(lat, lon);
  const [obs, hourly, daily, alerts] = await Promise.allSettled([
    observation(point.stations),
    nws(`${point.hourly}?units=si`),
    nws(`${point.forecast}?units=si`),
    alertsAt(lat, lon)
  ]);
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  for (const r of [obs, hourly, daily, alerts]) if (r.status === 'rejected') console.warn('NWS part failed:', r.reason?.message);
  if (!ok(obs) && !ok(hourly) && !ok(daily)) throw new Error('the NWS sent nothing for this place');
  return {
    source: 'nws',
    name: 'the US National Weather Service',
    current: ok(obs),
    hourly: hourlyOf(ok(hourly)),
    daily: dailyOf(ok(daily)),
    alerts: ok(alerts) || []
  };
}
