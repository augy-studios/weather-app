// Run by Vercel Cron every minute (vercel.json). Two jobs, both kept in Upstash:
//
// - Lightning alerts. NEA publishes a lightning record about every two minutes.
//   Each new strike, one not already in the last three hours' records, is passed
//   to lib/lightning.js, which warns anyone with a place near it. Strikes older
//   than STALE_MS when first seen are stored but not announced: by then the
//   warning is history, not news.
// - The map's timeline. One snapshot of every weather station per five-minute
//   slot, plus the lightning records, three hours of each (lib/timeline.js).
//   A slot the cron missed, a deploy or an outage, is backfilled from
//   data.gov.sg a couple at a time, newest first, stopping at the first 429.
//
// The very first run only fills the store. Nothing it finds is new to anybody.

import { latest, strikesOf } from '../../lib/datagov.js';
import { getState, releaseLock, setState, storeConfigured, takeLock, timeline } from '../../lib/kv.js';
import { notifyLightning } from '../../lib/lightning.js';
import {
  SLOT_MS, WINDOW_MS, flattenStrikes, isoOf, liveLightning, readStations, slotOf
} from '../../lib/timeline.js';

// Shorter than the minute between runs.
const LOCK_SECONDS = 55;
// A strike first seen this long after it happened is not announced.
const STALE_MS = 20 * 60 * 1000;
// Slots backfilled per run: five requests each, so ten a minute at most on top of
// the run's own six.
const BACKFILL_PER_RUN = 2;
// Station names and places change rarely; the list is refreshed this often.
const STATIONS_TTL_MS = 6 * 3600 * 1000;

const strikeId = (s) => `${s.t}|${s.lat}|${s.lon}`;

export default async function handler(req, res) {
  // Vercel Cron sends CRON_SECRET as a bearer token; nobody else can make the server collect.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!storeConfigured()) {
    return res.status(200).json({ skipped: 'Upstash is not set up, so there is nowhere to keep anything' });
  }
  if (!(await takeLock('collect', LOCK_SECONDS))) {
    return res.status(200).json({ skipped: 'a run is already going' });
  }

  try {
    const since = Date.now() - WINDOW_MS;
    const [lightning, stations] = await Promise.allSettled([collectLightning(since), collectStations(since)]);
    const out = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
    if (lightning.status === 'rejected') console.error('collect: lightning failed:', lightning.reason);
    if (stations.status === 'rejected') console.error('collect: stations failed:', stations.reason);
    return res.status(200).json({ lightning: out(lightning), stations: out(stations) });
  } finally {
    await releaseLock('collect').catch(() => {});
  }
}

async function collectLightning(since) {
  const stored = Object.fromEntries(await timeline.all('lightning'));
  const first = !(await getState('lightning-started'));

  // The first run takes the whole window, so the map has it straight away and
  // nothing in it is mistaken for news on the next run.
  if (first) {
    const window = await liveLightning(since);
    for (const [t, strikes] of Object.entries(window)) {
      if (strikes.length) await timeline.put('lightning', t, strikes);
    }
    await setState('lightning-started', { at: new Date().toISOString() });
    return { first: true, records: Object.keys(window).length };
  }

  const record = (await latest('weather', { api: 'lightning' })).records?.[0];
  if (!record?.datetime) return { record: null };
  const strikes = strikesOf(record);

  const seen = new Set(flattenStrikes(stored, since).map(strikeId));
  const fresh = strikes.filter((s) => !seen.has(strikeId(s)) && Date.now() - Date.parse(s.t) < STALE_MS);

  // Kept only when there is something to draw; an empty record says nothing the
  // map needs.
  if (strikes.length) await timeline.put('lightning', record.datetime, strikes);
  await timeline.trim('lightning', since - SLOT_MS);

  const alerts = fresh.length ? await notifyLightning(fresh) : null;
  return { record: record.datetime, strikes: strikes.length, fresh: fresh.length, alerts };
}

async function collectStations(since) {
  const now = slotOf(Date.now());
  const have = new Set(await timeline.keys('stations'));
  const out = { slot: null, backfilled: [], limited: false };

  if (!have.has(isoOf(now))) {
    const snap = await readStations();
    if (!snap.empty) {
      await timeline.put('stations', isoOf(now), snap.values);
      await keepStations(snap.stations);
      out.slot = isoOf(now);
    }
  }

  // Newest first: the slots a reader scrubs back to first.
  const missing = [];
  for (let t = now - SLOT_MS; t > since; t -= SLOT_MS) if (!have.has(isoOf(t))) missing.push(t);
  for (const t of missing.slice(0, BACKFILL_PER_RUN)) {
    const snap = await readStations(t, { retries: 1 });
    if (snap.limited) {
      out.limited = true;
      break;
    }
    if (snap.empty) continue;
    await timeline.put('stations', isoOf(t), snap.values);
    await keepStations(snap.stations);
    out.backfilled.push(isoOf(t));
  }
  out.left = missing.length - out.backfilled.length;

  await timeline.trim('stations', since - SLOT_MS);
  return out;
}

// The station list, merged so a station missing from one reading keeps its pin.
async function keepStations(list) {
  if (!Object.keys(list).length) return;
  const known = await getState('stations');
  const fresh = Object.keys(list).some((id) => !known?.[id]);
  const at = await getState('stations-at');
  if (known && !fresh && at && Date.now() - at < STATIONS_TTL_MS) return;
  await setState('stations', { ...(known || {}), ...list });
  await setState('stations-at', Date.now());
}
