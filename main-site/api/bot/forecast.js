// The Telegram bot's forecast: the same bundle /api/forecast serves the page
// (lib/place.js: Open-Meteo with the national service laid over it, warnings,
// MeteoGate's stations across Europe), in the shape the bot reads. Times are
// the place's own wall clock as "2026-10-11T09:00", and days "2026-10-11", as
// Open-Meteo gives them when asked for ISO times; utc_offset_seconds is filled
// in even when a fallback service stood in.
//
//   GET /api/bot/forecast?latitude=&longitude=&units=metric|imperial&country=XX
//   Authorization: Bearer <BOT_API_TOKEN>

import { botAuthorized } from '../../lib/bot-auth.js';
import { recentPlaces, storeConfigured } from '../../lib/kv.js';
import { getPlace, present, roundPlace } from '../../lib/place.js';
import { dateKey } from '../../lib/wx.js';

// "2026-10-11T09:00" for unix seconds, on the zone's wall clock.
function wallClock(zone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
  }
  return (seconds) => {
    if (!Number.isFinite(seconds)) return seconds;
    const p = Object.fromEntries(fmt.formatToParts(new Date(seconds * 1000)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
}

// The zone's offset from UTC right now, from its own wall clock.
function offsetNow(local) {
  const now = Math.floor(Date.now() / 60000) * 60;
  return Math.round((Date.parse(`${local(now)}:00Z`) / 1000 - now) / 60) * 60;
}

function forBot(bundle) {
  const zone = bundle.timezone;
  const local = wallClock(zone);
  const times = (block) => block && { ...block, time: (block.time || []).map(local) };
  const daily = bundle.daily && {
    ...bundle.daily,
    time: (bundle.daily.time || []).map((t) => dateKey(t * 1000, zone)),
    sunrise: (bundle.daily.sunrise || []).map(local),
    sunset: (bundle.daily.sunset || []).map(local)
  };
  return {
    ...bundle,
    utc_offset_seconds: bundle.utc_offset_seconds ?? offsetNow(local),
    current: bundle.current && { ...bundle.current, time: local(bundle.current.time) },
    hourly: times(bundle.hourly),
    minutely_15: times(bundle.minutely_15),
    daily
  };
}

export default async function handler(req, res) {
  if (!botAuthorized(req, res)) return;
  const lat = parseFloat(req.query.latitude);
  const lon = parseFloat(req.query.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }
  const code = /^[A-Z]{2}$/.test(req.query.country || '') ? req.query.country : null;
  const imperial = req.query.units === 'imperial';

  // A digest's place is kept warm by the places cron like any other.
  if (storeConfigured()) {
    const [rlat, rlon] = roundPlace(lat, lon);
    await recentPlaces.touch(rlat, rlon, code).catch((err) => console.warn('recent places:', err.message));
  }

  try {
    const { data, savedAt, stale } = await getPlace(lat, lon, code);
    res.status(200).json({ ...forBot(present(data, imperial)), savedAt, stale });
  } catch (err) {
    console.warn('bot forecast failed:', err.message);
    res.status(502).json({ error: 'No forecast for this place right now' });
  }
}
