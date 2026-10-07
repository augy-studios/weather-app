// NEA's rain radar, for the map.
//
//   GET /api/radar?range=70km              the last three hours of frames
//   GET /api/radar?range=70km&at=YYYYMMDDHHmm   one frame's PNG
//
// data.gov.sg hands out each image as a presigned S3 link that dies after twenty
// minutes, which a map left open on the scrubber would outlive. So the list
// points at this function instead, and each frame is fetched once, here, and
// served as immutable: a frame for 23:55 never changes, so the CDN keeps it for
// good and the next visitor gets it without data.gov.sg being asked at all.
//
// The images are drawn in NEA's azimuthal equidistant projection and placed on
// the map by their EPSG:4326 corners. Near the equator, over these distances,
// the difference from Leaflet's projection is a few hundred metres at the edge of
// the 70 km image and a few kilometres at the edge of the 480 km one.

import { at, latest, sgMoment, windowBack } from '../lib/datagov.js';

const RANGES = ['70km', '240km', '480km'];
const WINDOW_MS = 3 * 3600 * 1000;
const STAMP = /^\d{12}$/;

// Presigned links seen in recent listings, so a frame asked for soon after its
// list does not need another data.gov.sg call. One per warm instance.
const signed = new Map();

// "2026-10-07T23:55:00+08:00" to "202610072355": NEA's own clock, as its file names use.
const stampOf = (iso) => iso.slice(0, 16).replace(/\D/g, '');

function remember(range, records) {
  const now = Date.now();
  for (const [k, v] of signed) if (v.expires <= now) signed.delete(k);
  for (const r of records) {
    const expires = Date.parse(r.image?.urlExpiresAt) || now + 15 * 60_000;
    if (r.image?.url) signed.set(`${range}|${stampOf(r.timestamp)}`, { url: r.image.url, expires: expires - 60_000 });
  }
}

function boundsOf(meta) {
  const b = meta?.boundaryBox;
  if (!b?.upperLeft || !b?.lowerRight) return null;
  return [[b.lowerRight.latitude, b.upperLeft.longitude], [b.upperLeft.latitude, b.lowerRight.longitude]];
}

async function list(req, res, range) {
  const since = Date.now() - WINDOW_MS;
  const path = `weather-radar-images/${range}`;
  // The listing's metadata is on every page; the latest call is the fallback when
  // today's listing is empty just after midnight.
  let { meta, entries } = await windowBack(path, 'records', since);
  if (!meta) meta = await latest(path);
  remember(range, entries);

  const frames = entries
    .filter((r) => r.timestamp)
    .map((r) => ({ t: r.timestamp, src: `/api/radar?range=${range}&at=${stampOf(r.timestamp)}` }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

  // A new frame arrives every five minutes.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    source: 'nea',
    range,
    bounds: boundsOf(meta),
    center: meta?.projection?.center ?? null,
    frames
  });
}

async function frame(req, res, range, stamp) {
  const key = `${range}|${stamp}`;
  let hit = signed.get(key);
  if (!hit || hit.expires <= Date.now()) {
    // "Latest at or before" that minute, which is the frame itself when it exists.
    const ms = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12)) - 8 * 3600 * 1000;
    const data = await at(`weather-radar-images/${range}`, sgMoment(ms));
    remember(range, data.records || []);
    hit = signed.get(key);
  }
  if (!hit) {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(404).json({ error: 'No radar frame at that time' });
  }

  const upstream = await fetch(hit.url, { signal: AbortSignal.timeout(8000) });
  if (!upstream.ok) throw new Error(`radar image answered ${upstream.status}`);
  const png = Buffer.from(await upstream.arrayBuffer());

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.status(200).send(png);
}

export default async function handler(req, res) {
  const range = RANGES.includes(req.query.range) ? req.query.range : '70km';
  const stamp = req.query.at;
  try {
    if (stamp === undefined) return await list(req, res, range);
    if (!STAMP.test(stamp)) return res.status(400).json({ error: 'at must be YYYYMMDDHHmm' });
    return await frame(req, res, range, stamp);
  } catch (err) {
    console.warn('radar failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The radar is not answering right now' });
  }
}
