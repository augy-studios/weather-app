// Singapore as NEA reports it right now, for the Now, Forecast and Air & heat
// pages and the map (lib/nea.js has the parts).
//
// The sg cron keeps a copy in Blob, refreshed every minute, and this serves it.
// Only when that copy is missing or more than a few minutes old does this ask
// data.gov.sg itself, for whatever parts are due, and keep the result for the
// next caller. Every part is null when NEA has nothing for it, so one feed being
// down never blanks the rest; the page fills a null part from Open-Meteo.

import { blobConfigured } from '../lib/blob.js';
import { PART_NAMES, readSg, refreshSg, writeSg } from '../lib/nea.js';

// Past this the cron has stopped, and this goes to data.gov.sg instead.
const STORED_FRESH_MS = 3 * 60 * 1000;

export default async function handler(req, res) {
  let body = await readSg().catch(() => null);
  if (!body || !(Date.now() - body.fetchedAt < STORED_FRESH_MS)) {
    body = await refreshSg(body);
    if (blobConfigured() && PART_NAMES.some((n) => body[n])) {
      await writeSg(body).catch((err) => console.warn('sg: could not keep the copy:', err.message));
    }
  }

  if (PART_NAMES.every((n) => body[n] === null)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'data.gov.sg is not answering' });
  }

  // Stations read every minute and lightning every two, so a minute is the most
  // a reading should lag. Missing parts are cached for less, so a recovering
  // feed shows up soon after.
  const partial = PART_NAMES.some((n) => body[n] === null);
  res.setHeader('Cache-Control', partial ? 'public, s-maxage=20' : 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(body);
}
