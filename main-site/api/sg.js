// Singapore as NEA reports it right now, for the Now, Forecast and Air & heat
// pages and the map: the 2-hour, 24-hour and 4-day forecasts, the latest reading
// at every weather station, the UV index, WBGT heat stress and lightning.
//
// Every part is fetched on its own and is null when data.gov.sg does not answer
// for it, so one feed being down never blanks the rest. The page fills any null
// part from Open-Meteo instead. The CDN holds each answer for a minute so every
// visitor in that window shares one round of upstream calls.

import { STATION_FEEDS, latest, stationsOf, strikesOf, valuesOf } from '../lib/datagov.js';

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

const PARTS = { forecast2h, forecast24h, outlook4d, stations, uv, wbgt, lightning };

export default async function handler(req, res) {
  const names = Object.keys(PARTS);
  const results = await Promise.allSettled(names.map((n) => PARTS[n]()));
  const body = { fetchedAt: Date.now() };
  names.forEach((n, i) => {
    const r = results[i];
    body[n] = r.status === 'fulfilled' ? r.value : null;
    if (r.status === 'rejected') console.warn(`sg: ${n} failed:`, r.reason?.message);
  });

  if (names.every((n) => body[n] === null)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'data.gov.sg is not answering' });
  }

  // Stations read every minute and lightning every two, so a minute is the most
  // a reading should lag. Missing parts are cached for less, so a recovering
  // feed shows up soon after.
  const partial = names.some((n) => body[n] === null);
  res.setHeader('Cache-Control', partial ? 'public, s-maxage=20' : 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(body);
}
