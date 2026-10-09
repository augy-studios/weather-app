// Air quality for the country a point is in, as a low to high range, in one
// shape whatever the source (lib/air.js). The Telegram bot reads it from here too.
//
//   GET /api/air?latitude=&longitude=&country=XX

import { airFor } from '../lib/air.js';

export default async function handler(req, res) {
  const lat = parseFloat(req.query.latitude);
  const lon = parseFloat(req.query.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }

  try {
    const { body, intended } = await airFor(lat, lon, req.query.country);
    // The intended source is held ten minutes; a stand-in only one, so
    // Singapore goes back to NEA as soon as NEA is back.
    res.setHeader('Cache-Control', intended
      ? 's-maxage=600, stale-while-revalidate=3600'
      : 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(body);
  } catch (err) {
    console.warn('Air quality failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'No air quality reading for this place right now' });
  }
}
