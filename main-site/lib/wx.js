// Small pieces every weather source shares: fetching with a timeout and an
// honest User-Agent, turning a provider's words or codes into a WMO weather
// code (the page draws Open-Meteo's codes, so everything speaks them), dates in
// a place's own zone, and the US AQI worked out from PM2.5.

// MET Norway and the NWS turn away requests without one that names the app
// and a way to reach its owner.
export const USER_AGENT = 'uwu-weather/1.0 (https://weather.uwuapps.org; augy@augystudios.com)';

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function fetchJSON(url, { headers = {}, timeout = 8000, label } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeout)
  });
  const name = label || new URL(url).hostname;
  if (!res.ok) throw new HttpError(`${name} answered ${res.status}`, res.status);
  return res.json();
}

export async function fetchText(url, { headers = {}, timeout = 8000, label } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new HttpError(`${label || new URL(url).hostname} answered ${res.status}`, res.status);
  return res.text();
}

export const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
};

// ---------- weather in words to WMO codes ----------

// For the services that describe the weather in English rather than a code:
// the NWS ("Chance Showers And Thunderstorms"), MSC Canada ("Mainly sunny"),
// and WeatherAPI's and Xweather's descriptions as a last resort. Order matters:
// the first match wins, so the worse weather is checked first.
const WORDS = [
  [/thunder|t-storm|tstorm/, 95],
  [/freezing rain|freezing drizzle|ice pellet|sleet/, 66],
  [/heavy snow|blizzard/, 75],
  [/snow shower|flurr/, 85],
  [/light snow/, 71],
  [/snow/, 73],
  [/heavy rain|torrential/, 65],
  [/rain shower|showers/, 80],
  [/light rain|drizzle/, 61],
  [/rain/, 63],
  [/fog|mist|haze|smoke|dust/, 45],
  [/overcast/, 3],
  [/mostly cloudy|cloudy periods|considerable cloud|broken/, 3],
  [/partly|a few clouds|mix of sun|mostly sunny|mainly sunny|mainly clear|mostly clear|scattered clouds/, 2],
  [/cloud/, 3],
  [/sunny|clear|fair/, 0]
];

export function wordsToWmo(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const [re, code] of WORDS) if (re.test(t)) return code;
  return null;
}

// ---------- time ----------

/** "2026-10-09" for a moment, in a zone. */
export function dateKey(ms, zone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Unix seconds for the start of the hour a moment falls in. */
export const hourOf = (ms) => Math.floor(ms / 3600000) * 3600;

// ---------- US AQI from PM2.5 ----------

// EPA's 2024 breakpoints for 24-hour PM2.5, µg/m³. A fallback that only reports
// a concentration still gets a number on the same scale as Open-Meteo's.
const PM25_BREAKS = [
  [0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]
];

export function usAqiFromPm25(pm) {
  if (!Number.isFinite(pm)) return null;
  const c = Math.floor(Math.max(0, pm) * 10) / 10;
  const row = PM25_BREAKS.find(([, hi]) => c <= hi) || PM25_BREAKS[PM25_BREAKS.length - 1];
  const [clo, chi, ilo, ihi] = row;
  return Math.round(((ihi - ilo) / (chi - clo)) * (Math.min(c, chi) - clo) + ilo);
}
