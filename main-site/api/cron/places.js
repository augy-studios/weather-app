// Run by Vercel Cron every five minutes (vercel.json). Rebuilds the weather of
// every place looked at in the last day (lib/kv.js keeps the list) before
// anybody asks again, so a visit is served from a copy no more than ten
// minutes old, and stays that way when an upstream is having a bad hour:
//
// - The place's bundle: forecast, national service, sea (lib/place.js).
// - Its air quality (lib/air.js).
// - In England, the rain gauges round it, for the map (lib/sources/uk.js).
//
// Each place is rebuilt at most every ten minutes, so this cron does about half
// of them on each run. The keyed fallbacks are only called when Open-Meteo
// fails, as on any other request.

import { airFor } from '../../lib/air.js';
import { blobConfigured } from '../../lib/blob.js';
import { recentPlaces, storeConfigured } from '../../lib/kv.js';
import { FRESH_MS, warmPlace } from '../../lib/place.js';
import { gaugesFor } from '../../lib/sources/uk.js';
import { countryCode } from '../../lib/country.js';

const DAY = 24 * 3600 * 1000;
// The most places kept warm. Past this the least recently looked at wait for a
// visitor, as they would have before.
const MAX_PLACES = 80;
const AT_ONCE = 4;
// Stop starting new places with this much of the function's time left.
const BUDGET_MS = 240 * 1000;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!storeConfigured() || !blobConfigured()) {
    return res.status(200).json({ skipped: 'needs both Upstash (the list of places) and Blob (the copies)' });
  }

  const started = Date.now();
  const places = await recentPlaces.since(Date.now() - DAY, MAX_PLACES);
  const tally = { places: places.length, built: 0, fresh: 0, failed: 0, unstarted: 0 };

  // A copy under this age is left alone; one run in two picks each place up.
  const freshMs = FRESH_MS - 60 * 1000;
  const queue = [...places];
  const worker = async () => {
    while (queue.length) {
      if (Date.now() - started > BUDGET_MS) {
        tally.unstarted = queue.length;
        queue.length = 0;
        return;
      }
      const p = queue.shift();
      try {
        const result = await warmPlace(p.lat, p.lon, p.code, { freshMs });
        tally[result]++;
        // The same clock for the rest: these are cached too, so a fresh copy costs a read.
        await airFor(p.lat, p.lon, p.code).catch((err) => console.warn('places cron: air failed:', err.message));
        if (countryCode(p.code, p.lat, p.lon) === 'GB') {
          await gaugesFor(p.lat, p.lon, { fresh: freshMs }).catch((err) => console.warn('places cron: gauges failed:', err.message));
        }
      } catch (err) {
        tally.failed++;
        console.warn(`places cron: ${p.lat},${p.lon} failed:`, err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return res.status(200).json({ ...tally, ms: Date.now() - started });
}
