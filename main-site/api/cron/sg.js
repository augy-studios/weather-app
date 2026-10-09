// Run by Vercel Cron every minute (vercel.json), alongside collect.js. Keeps
// Singapore ready in Blob, so visitors read copies instead of each asking
// data.gov.sg:
//
// - NEA's bundle for /api/sg and /api/air (lib/nea.js), each part on its own clock.
// - NEA's radar, every frame as it is published, at all three ranges, three
//   hours of them, with any frame missed backfilled (lib/radar.js).
// - Each new 2-hour forecast, into the map's timeline in Upstash, so the
//   scrubber shows the forecast as it stood at each time, not only now's.
//
// Without Blob there is nowhere to keep any of it, and every route asks
// upstream itself, as before.

import { blobConfigured } from '../../lib/blob.js';
import { storeConfigured, timeline } from '../../lib/kv.js';
import { readSg, refreshSg, writeSg } from '../../lib/nea.js';
import { NEA_RANGES, WINDOW_MS, collectNea } from '../../lib/radar.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!blobConfigured()) {
    return res.status(200).json({ skipped: 'Vercel Blob is not set up, so there is nowhere to keep anything' });
  }

  const [bundle, ...radar] = await Promise.allSettled([
    keepBundle(),
    ...NEA_RANGES.map((range) => collectNea(range))
  ]);
  const out = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
  if (bundle.status === 'rejected') console.error('sg cron: bundle failed:', bundle.reason);
  radar.forEach((r, i) => r.status === 'rejected' && console.error(`sg cron: radar ${NEA_RANGES[i]} failed:`, r.reason));
  return res.status(200).json({ bundle: out(bundle), radar: radar.map(out) });
}

async function keepBundle() {
  const previous = await readSg();
  const body = await refreshSg(previous);
  await writeSg(body);

  // A forecast is kept once, when NEA issues it, which is every half hour.
  let forecast = null;
  const f = body.forecast2h;
  if (storeConfigured() && f?.time && f.time !== previous?.forecast2h?.time) {
    await timeline.put('forecast2h', f.time, {
      valid: f.valid?.text || null,
      areas: Object.fromEntries(f.areas.map((a) => [a.name, a.text]))
    });
    // An hour more than the window, so the oldest slots still have the
    // forecast that was current for them.
    await timeline.trim('forecast2h', Date.now() - WINDOW_MS - 3600 * 1000);
    forecast = f.time;
  }
  return {
    parts: Object.fromEntries(Object.entries(body.at).map(([k, t]) => [k, t === body.fetchedAt ? 'fetched' : 'kept'])),
    forecast
  };
}
