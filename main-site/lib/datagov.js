// data.gov.sg's real-time API, for everything the site reads about Singapore:
// forecasts, station readings, UV, WBGT, lightning and the rain radar. The feeds'
// shapes are in the JSON specs at the repo root. Differences found against the
// live API are noted where they matter, as sg-psi's copy of this file does.
//
// DATA_GOV_KEY is optional; it raises the rate limit.

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';

// How long to wait before asking again after a 429, at most.
const MAX_RETRY_WAIT_MS = 10_000;

// A day's readings come back 25 to a page, newest first. This only stops a feed
// that keeps handing out tokens from looping.
const MAX_PAGES = 12;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimited extends Error {}

// `retries`: how many times to wait and ask again after a 429. None for anything
// a page is waiting on; the cron's backfill can afford to wait.
async function get(path, params = {}, { retries = 0, timeout = 8000 } = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const key = process.env.DATA_GOV_KEY;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      signal: AbortSignal.timeout(timeout)
    });
    if (res.status !== 429 || attempt >= retries) break;
    const after = Number(res.headers.get('retry-after')) * 1000;
    await sleep(Math.min(MAX_RETRY_WAIT_MS, after > 0 ? after : 4000 * (attempt + 1)));
  }
  if (res.status === 429) throw new RateLimited(`data.gov.sg ${path} answered 429`);
  if (!res.ok) throw new Error(`data.gov.sg ${path} answered ${res.status}`);
  const body = await res.json();
  if (body.code !== 0 || !body.data) throw new Error(`data.gov.sg ${path} said ${body.errorMsg || body.code}`);
  return body.data;
}

export const latest = (path, params = {}) => get(path, params);

// The reading as it stood at one SGT moment, e.g. "2026-10-04T10:05:00".
export const at = (path, moment, { retries = 0, params = {} } = {}) =>
  get(path, { ...params, date: moment }, { retries });

// A moment as data.gov.sg's `date` parameter wants it: SGT, to the second, no zone.
export const sgMoment = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19);

// The SGT calendar date of a moment.
export const sgDate = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Every entry of one SGT day's listing, newest first, following pages until an
 * entry older than `since` turns up. `field` is the array the feed pages over:
 * "records" for radar and lightning, "readings" for the station feeds.
 */
export async function dayBack(path, date, field, since, { params = {}, stamp = (e) => e.timestamp } = {}) {
  const out = [];
  let token = null;
  let meta = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get(path, { ...params, date, paginationToken: token });
    meta ??= data;
    const entries = data[field] || [];
    out.push(...entries);
    token = data.paginationToken;
    const oldest = entries.length ? Date.parse(stamp(entries[entries.length - 1])) : NaN;
    if (!token || !(oldest >= since)) break;
  }
  return { meta, entries: out.filter((e) => Date.parse(stamp(e)) >= since) };
}

/** The same, across midnight when the window starts on the day before. */
export async function windowBack(path, field, since, opts = {}) {
  const today = sgDate(Date.now());
  const first = sgDate(since);
  const { meta, entries } = await dayBack(path, today, field, since, opts);
  if (first === today) return { meta, entries };
  const before = await dayBack(path, first, field, since, opts).catch(() => ({ entries: [] }));
  return { meta: meta || before.meta, entries: [...entries, ...before.entries] };
}

// ---------- stations ----------

/** The feeds measured at weather stations, with the key each is kept under. */
export const STATION_FEEDS = [
  { key: 'temp', path: 'air-temperature' },
  { key: 'humidity', path: 'relative-humidity' },
  { key: 'rain', path: 'rainfall' },
  { key: 'windSpeed', path: 'wind-speed' },
  { key: 'windDir', path: 'wind-direction' }
];

// Station ids to [name, lat, lon]. The wind feeds call it `location` where the
// spec says `labelLocation`, so both are read.
export function stationsOf(data) {
  const out = {};
  for (const s of data?.stations || []) {
    const loc = s.location || s.labelLocation || {};
    if (Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)) {
      out[s.id] = [s.name, loc.latitude, loc.longitude];
    }
  }
  return out;
}

/** { stationId: value } for one reading. */
export function valuesOf(reading) {
  const out = {};
  for (const d of reading?.data || []) if (Number.isFinite(d.value)) out[d.stationId] = d.value;
  return out;
}

// ---------- lightning ----------

// [{ lat, lon, t, type }] from a lightning record. Coordinates come as strings.
// "G" is cloud to ground, "C" cloud to cloud; both count as lightning nearby.
export function strikesOf(record) {
  return (record?.item?.readings || [])
    .map((r) => ({
      lat: Number(r.location?.latitude),
      lon: Number(r.location?.longitude),
      t: r.datetime,
      type: r.type === 'G' ? 'ground' : 'cloud'
    }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

// ---------- distance ----------

export function km(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
