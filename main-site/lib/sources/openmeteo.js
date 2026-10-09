// Open-Meteo: the forecast every place starts from, and the sea state for
// places on the coast. Always asked in metric; /api/forecast converts.

import { fetchJSON } from '../wx.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

// What the page draws. The fifteen-minute series runs three hours back as well
// as two ahead, so the map's scrubber has a reading for the place at every step.
export const FIELDS = {
  current: [
    'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation',
    'weather_code', 'is_day', 'wind_speed_10m', 'wind_direction_10m', 'surface_pressure'
  ],
  hourly: [
    'temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation',
    'weather_code', 'is_day', 'uv_index', 'relative_humidity_2m'
  ],
  daily: [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum',
    'precipitation_probability_max', 'wind_speed_10m_max', 'uv_index_max'
  ],
  minutely_15: ['precipitation', 'temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m']
};

export async function forecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: 'auto',
    timeformat: 'unixtime',
    current: FIELDS.current.join(','),
    hourly: FIELDS.hourly.join(','),
    daily: FIELDS.daily.join(','),
    minutely_15: FIELDS.minutely_15.join(','),
    past_minutely_15: '12',
    forecast_minutely_15: '9',
    forecast_days: '7'
  });
  const j = await fetchJSON(`${FORECAST}?${params}`, { label: 'Open-Meteo' });
  if (!j.current || !j.hourly?.time?.length) throw new Error('Open-Meteo sent no forecast');
  return { ...j, source: 'open-meteo' };
}

/**
 * Waves, swell and the sea's temperature, or null inland: the marine model has
 * no cell over land, and answers nulls there.
 */
export async function marine(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: 'auto',
    timeformat: 'unixtime',
    current: 'wave_height,wave_direction,wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction',
    hourly: 'wave_height',
    forecast_days: '2'
  });
  const j = await fetchJSON(`${MARINE}?${params}`, { label: 'Open-Meteo marine' });
  const c = j.current || {};
  if (c.wave_height == null && c.sea_surface_temperature == null) return null;
  return {
    time: c.time,
    waveHeight: c.wave_height,
    waveDirection: c.wave_direction,
    wavePeriod: c.wave_period,
    seaTemperature: c.sea_surface_temperature,
    currentSpeed: c.ocean_current_velocity,
    currentDirection: c.ocean_current_direction,
    hourly: (j.hourly?.time || []).map((t, i) => ({ t, waveHeight: j.hourly.wave_height?.[i] ?? null }))
  };
}
