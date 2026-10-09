// The weather for one place, as the page draws it: Open-Meteo's forecast with
// the national weather service's readings laid over it, the sea state, and any
// warnings in force (lib/place.js). The shape stays Open-Meteo's, so a page from
// before this change still reads it.
//
//   GET /api/forecast?latitude=&longitude=&units=metric|imperial&country=XX
//
// Built at most once per place every ten minutes and kept in Blob, so a cold
// instance, a second visitor or the places cron all start from the same copy.
// Each call notes the place in Upstash, which is how the cron knows what to
// keep warm.

import { recentPlaces, storeConfigured } from '../lib/kv.js';
import { getPlace, present, roundPlace } from '../lib/place.js';

export default async function handler(req, res) {
  const lat = parseFloat(req.query.latitude);
  const lon = parseFloat(req.query.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }
  const code = /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : null;
  // `temperature_unit` is how pages from before this change ask for Fahrenheit.
  const imperial = req.query.units === 'imperial' || req.query.temperature_unit === 'fahrenheit';

  if (storeConfigured()) {
    const [rlat, rlon] = roundPlace(lat, lon);
    await recentPlaces.touch(rlat, rlon, code).catch((err) => console.warn('recent places:', err.message));
  }

  try {
    const { data, savedAt, stale } = await getPlace(lat, lon, code);
    // A stand-in (an old copy, or a fallback while Open-Meteo is down) is held
    // briefly, so the CDN asks again soon and picks up the recovery.
    const brief = stale || data.source !== 'open-meteo';
    res.setHeader('Cache-Control', brief ? 'public, s-maxage=60' : 'public, s-maxage=300, stale-while-revalidate=3600');
    res.status(200).json({ ...present(data, imperial), savedAt, stale });
  } catch (err) {
    console.warn('forecast failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'No forecast for this place right now' });
  }
}
