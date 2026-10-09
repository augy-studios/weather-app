// England's rain gauges round a place, three hours of their fifteen-minute
// totals, for the map's scrubber (lib/sources/uk.js).
//
//   GET /api/gauges?lat=&lon=
//
// Kept per tenth of a degree for ten minutes, here and in Blob, and refreshed
// by the places cron for places looked at recently.

import { gaugesFor } from '../lib/sources/uk.js';

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon are required' });
  try {
    const { data, stale } = await gaugesFor(lat, lon);
    res.setHeader('Cache-Control', stale ? 'public, s-maxage=60' : 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ source: 'environment-agency', ...data, stale, fetchedAt: Date.now() });
  } catch (err) {
    console.warn('gauges failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The rain gauges are not answering right now' });
  }
}
