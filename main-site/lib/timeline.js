// The last three hours of Singapore's station readings and lightning, in
// five-minute slots, for the scrubber along the bottom of the map.
//
// Three hours of the one-minute feeds is eight pages each from data.gov.sg, too
// much to fetch for every visitor. So the collect cron (api/cron/collect.js)
// stores one snapshot per slot in Upstash as it goes, backfills any slot it
// missed, and /api/timeline reads them back. Without Upstash, or before the cron
// has filled anything, /api/timeline falls back to what is cheap to fetch live:
// three hours of rainfall and lightning, and the stations' latest readings.

import {
  RateLimited, STATION_FEEDS, at, latest, sgMoment, stationsOf, strikesOf, valuesOf, windowBack
} from './datagov.js';

export const WINDOW_MS = 3 * 3600 * 1000;
export const SLOT_MS = 5 * 60 * 1000;

export const slotOf = (ms) => Math.floor(ms / SLOT_MS) * SLOT_MS;
export const isoOf = (ms) => new Date(ms).toISOString();

/**
 * Every station feed at one moment (null for now), as one snapshot:
 * { stations: {id: [name, lat, lon]}, values: { temp: {id: v}, ... } }.
 * A feed that fails is left out rather than failing the snapshot.
 */
export async function readStations(moment = null, { retries = 0 } = {}) {
  const results = await Promise.allSettled(STATION_FEEDS.map((f) =>
    moment == null ? latest(f.path) : at(f.path, sgMoment(moment), { retries })));
  const stations = {};
  const values = {};
  let limited = false;
  STATION_FEEDS.forEach((feed, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled') {
      if (r.reason instanceof RateLimited) limited = true;
      return;
    }
    Object.assign(stations, stationsOf(r.value));
    values[feed.key] = valuesOf(r.value.readings?.[0]);
  });
  return { stations, values, limited, empty: !Object.keys(values).length };
}

const lightningOpts = { params: { api: 'lightning' }, stamp: (r) => r.datetime };

/** Every lightning record since a moment, as { [recordTime]: strikes }. */
export async function liveLightning(since) {
  const { entries } = await windowBack('weather', 'records', since, lightningOpts);
  return Object.fromEntries(entries.map((r) => [r.datetime, strikesOf(r)]));
}

/** Five-minute rainfall totals since a moment, as { [slotIso]: {id: mm} }, and the gauges. */
export async function liveRain(since) {
  const { meta, entries } = await windowBack('rainfall', 'readings', since);
  const bySlot = {};
  for (const r of entries) bySlot[isoOf(slotOf(Date.parse(r.timestamp)))] = valuesOf(r);
  return { stations: stationsOf(meta), bySlot };
}

/** Flatten { [recordTime]: strikes } into one list, oldest first, inside the window. */
export function flattenStrikes(byRecord, since) {
  return Object.values(byRecord)
    .flat()
    .filter((s) => Date.parse(s.t) >= since)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}
