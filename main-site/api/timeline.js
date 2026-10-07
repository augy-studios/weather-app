// The map's scrubber: Singapore's last three hours in five-minute slots, each with
// every station's temperature, humidity, rainfall and wind, plus every lightning
// strike in the window. The radar frames come from /api/radar.
//
// Read from what the collect cron stored (see lib/timeline.js). Until it has
// stored anything, or without Upstash at all, the earlier slots carry rainfall
// only and the newest has everything, and the page says so.

import { getState, storeConfigured, timeline } from '../lib/kv.js';
import {
  SLOT_MS, WINDOW_MS, flattenStrikes, isoOf, liveLightning, liveRain, readStations, slotOf
} from '../lib/timeline.js';

// Fewer stored slots than this and the live answer is fuller.
const MIN_STORED_SLOTS = 6;

async function fromStore(since) {
  const [stations, slots, strikes] = await Promise.all([
    getState('stations'),
    timeline.all('stations'),
    timeline.all('lightning')
  ]);
  const inWindow = slots.filter(([t]) => Date.parse(t) >= since);
  if (!stations || inWindow.length < MIN_STORED_SLOTS) return null;
  return {
    source: 'stored',
    stations,
    slots: inWindow.map(([t, values]) => ({ t, ...values })),
    strikes: flattenStrikes(Object.fromEntries(strikes), since)
  };
}

async function live(since) {
  const [rain, now, strikes] = await Promise.allSettled([liveRain(since), readStations(), liveLightning(since)]);
  const r = rain.status === 'fulfilled' ? rain.value : { stations: {}, bySlot: {} };
  const n = now.status === 'fulfilled' ? now.value : { stations: {}, values: {} };
  if (rain.status === 'rejected' && (now.status === 'rejected' || n.empty)) throw new Error('no station feed answered');

  const newest = isoOf(slotOf(Date.now()));
  const slots = [];
  for (let t = slotOf(since) + SLOT_MS; t <= slotOf(Date.now()); t += SLOT_MS) {
    const iso = isoOf(t);
    const rainNow = r.bySlot[iso];
    if (iso === newest) slots.push({ t: iso, ...n.values, rain: rainNow ?? n.values.rain });
    else if (rainNow) slots.push({ t: iso, rain: rainNow });
  }
  return {
    source: 'live',
    stations: { ...r.stations, ...n.stations },
    slots,
    strikes: strikes.status === 'fulfilled' ? flattenStrikes(strikes.value, since) : []
  };
}

export default async function handler(req, res) {
  const since = Date.now() - WINDOW_MS;
  try {
    let body = null;
    if (storeConfigured()) {
      body = await fromStore(since).catch((err) => {
        console.warn('timeline: store failed:', err.message);
        return null;
      });
    }
    body ??= await live(since);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ...body, fetchedAt: Date.now() });
  } catch (err) {
    console.warn('timeline failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The station readings are not answering right now' });
  }
}
