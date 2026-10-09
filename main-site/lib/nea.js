// Singapore as NEA reports it: the 2-hour, 24-hour and 4-day forecasts, the
// latest reading at every weather station, the UV index, WBGT heat stress,
// lightning, and the PSI and PM2.5 by region.
//
// The sg cron (api/cron/sg.js) rebuilds this every minute and keeps it in Blob,
// so /api/sg and /api/air read one copy instead of each asking data.gov.sg. Each
// part is refreshed on its own clock, as often as NEA updates it, and a part
// that fails keeps its last value until it is too old to show.

import { STATION_FEEDS, latest, stationsOf, strikesOf, valuesOf } from './datagov.js';
import { getJSON, putJSON } from './blob.js';

const MIN = 60 * 1000;
export const SG_PATH = 'sg/now.json';

async function forecast2h() {
  const data = await latest('two-hr-forecast');
  const item = data.items?.[0];
  if (!item?.forecasts?.length) throw new Error('no 2-hour forecast');
  const text = Object.fromEntries(item.forecasts.map((f) => [f.area, f.forecast]));
  return {
    time: item.timestamp,
    valid: item.valid_period,
    areas: (data.area_metadata || [])
      .filter((a) => text[a.name])
      .map((a) => ({ name: a.name, lat: a.label_location?.latitude, lon: a.label_location?.longitude, text: text[a.name] }))
  };
}

async function forecast24h() {
  const rec = (await latest('twenty-four-hr-forecast')).records?.[0];
  if (!rec?.general) throw new Error('no 24-hour forecast');
  const g = rec.general;
  return {
    time: rec.timestamp,
    valid: g.validPeriod,
    text: g.forecast?.text,
    temp: g.temperature,
    humidity: g.relativeHumidity,
    wind: { dir: g.wind?.direction, low: g.wind?.speed?.low, high: g.wind?.speed?.high },
    periods: (rec.periods || []).map((p) => ({
      start: p.timePeriod?.start,
      end: p.timePeriod?.end,
      label: p.timePeriod?.text,
      regions: Object.fromEntries(Object.entries(p.regions || {}).map(([r, v]) => [r, v?.text]))
    }))
  };
}

async function outlook4d() {
  const rec = (await latest('four-day-outlook')).records?.[0];
  if (!rec?.forecasts?.length) throw new Error('no 4-day outlook');
  return {
    time: rec.timestamp,
    days: rec.forecasts.map((f) => ({
      date: f.timestamp,
      day: f.day,
      text: f.forecast?.text,
      summary: f.forecast?.summary,
      low: f.temperature?.low,
      high: f.temperature?.high,
      humidity: f.relativeHumidity,
      wind: { dir: f.wind?.direction, low: f.wind?.speed?.low, high: f.wind?.speed?.high }
    }))
  };
}

// One map of every station any feed mentions, and each feed's values by station.
async function stations() {
  const results = await Promise.allSettled(STATION_FEEDS.map((f) => latest(f.path)));
  const out = { list: {}, times: {} };
  STATION_FEEDS.forEach((feed, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled') {
      console.warn(`sg: ${feed.path} failed:`, r.reason?.message);
      return;
    }
    Object.assign(out.list, stationsOf(r.value));
    const reading = r.value.readings?.[0];
    out[feed.key] = valuesOf(reading);
    out.times[feed.key] = reading?.timestamp ?? null;
  });
  if (!Object.keys(out.times).length) throw new Error('no station feed answered');
  return out;
}

async function uv() {
  const rec = (await latest('uv')).records?.[0];
  if (!rec?.index?.length) throw new Error('no UV reading');
  // Newest first from the API; oldest first here, for a chart.
  return {
    time: rec.timestamp,
    hours: rec.index.map((h) => ({ t: h.hour, value: h.value })).reverse()
  };
}

async function wbgt() {
  const rec = (await latest('weather', { api: 'wbgt' })).records?.[0];
  const readings = rec?.item?.readings || [];
  if (!readings.length) throw new Error('no WBGT reading');
  // Some stations are listed twice; the first of each is kept.
  const seen = new Set();
  return {
    time: rec.datetime,
    stations: readings
      .map((r) => ({
        id: r.station?.id,
        name: r.station?.name,
        town: r.station?.townCenter,
        lat: Number(r.location?.latitude),
        // The spec spells it "longtitude"; the live feed spells it right. Both read.
        lon: Number(r.location?.longitude ?? r.location?.longtitude),
        wbgt: Number(r.wbgt),
        stress: r.heatStress
      }))
      .filter((s) => Number.isFinite(s.wbgt) && Number.isFinite(s.lat) && Number.isFinite(s.lon) && !seen.has(s.id) && seen.add(s.id))
  };
}

async function lightning() {
  const rec = (await latest('weather', { api: 'lightning' })).records?.[0];
  if (!rec) throw new Error('no lightning record');
  return { time: rec.datetime, strikes: strikesOf(rec) };
}

// The PSI and PM2.5 feeds as NEA sends them; api/air.js reads the regions.
async function psi() {
  const data = await latest('psi');
  if (!data.items?.length) throw new Error('no PSI reading');
  return data;
}

async function pm25() {
  const data = await latest('pm25');
  if (!data.items?.length) throw new Error('no PM2.5 reading');
  return data;
}

// How often each part is asked for, and how long its last value may stand in
// when NEA stops answering for it.
const PARTS = {
  forecast2h: { fn: forecast2h, every: 1 * MIN, keep: 2 * 60 * MIN },
  forecast24h: { fn: forecast24h, every: 15 * MIN, keep: 12 * 60 * MIN },
  outlook4d: { fn: outlook4d, every: 30 * MIN, keep: 24 * 60 * MIN },
  stations: { fn: stations, every: 1 * MIN, keep: 20 * MIN },
  uv: { fn: uv, every: 10 * MIN, keep: 3 * 60 * MIN },
  wbgt: { fn: wbgt, every: 5 * MIN, keep: 60 * MIN },
  lightning: { fn: lightning, every: 1 * MIN, keep: 20 * MIN },
  psi: { fn: psi, every: 5 * MIN, keep: 3 * 60 * MIN },
  pm25: { fn: pm25, every: 5 * MIN, keep: 3 * 60 * MIN }
};
export const PART_NAMES = Object.keys(PARTS);

/**
 * The bundle, with every part that is due asked for again and the rest kept
 * from `previous`. { fetchedAt, at: {part: ms}, [part]: value | null }.
 */
export async function refreshSg(previous = null, { all = false } = {}) {
  const now = Date.now();
  const due = PART_NAMES.filter((n) => all || !previous?.[n] || !(now - (previous.at?.[n] ?? 0) < PARTS[n].every));
  const results = await Promise.allSettled(due.map((n) => PARTS[n].fn()));

  const body = { fetchedAt: now, at: {} };
  for (const n of PART_NAMES) {
    const i = due.indexOf(n);
    if (i >= 0 && results[i].status === 'fulfilled') {
      body[n] = results[i].value;
      body.at[n] = now;
      continue;
    }
    if (i >= 0) console.warn(`sg: ${n} failed:`, results[i].reason?.message);
    const kept = previous?.[n] && now - (previous.at?.[n] ?? 0) < PARTS[n].keep;
    body[n] = kept ? previous[n] : null;
    if (kept) body.at[n] = previous.at[n];
  }
  return body;
}

export const readSg = () => getJSON(SG_PATH);
export const writeSg = (body) => putJSON(SG_PATH, body);
