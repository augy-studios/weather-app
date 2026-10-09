// The rain radar, for the map (lib/radar.js has the sources).
//
//   GET /api/radar?range=70km                    NEA: the last three hours of frames
//   GET /api/radar?range=70km&at=YYYYMMDDHHmm    NEA: one frame's PNG
//   GET /api/radar?src=dwd&lat=&lon=             Germany: the frames round a place
//   GET /api/radar?src=dwd&cell=52.5,13.5&at=YYYYMMDDHHmm   Germany: one frame
//   GET /api/radar?src=msc                       Canada: the radar layer's times
//   GET /api/radar?src=msc-lightning             Canada: the lightning grid's times
//
// NEA's frames come from what the sg cron keeps in Blob. Only a frame it has
// not got yet is fetched from data.gov.sg here, and then kept for next time.
// Every frame, whatever its source, is served as immutable: a frame for 23:55
// never changes, so the CDN and the page's service worker keep it for good.
//
// NEA's images are drawn in its azimuthal equidistant projection and placed on
// the map by their EPSG:4326 corners. Near the equator, over these distances,
// the difference from Leaflet's projection is a few hundred metres at the edge of
// the 70 km image and a few kilometres at the edge of the 480 km one.

import { blobConfigured, getBytes, putBytes } from '../lib/blob.js';
import { at, latest, sgMoment, windowBack } from '../lib/datagov.js';
import {
  MSC_LAYER, MSC_LIGHTNING_LAYER, NEA_RANGES, WINDOW_MS, boundsOf, dwdFrame, dwdList, msOfStamp, mscList,
  neaFramePath, readNeaIndex, stampOf
} from '../lib/radar.js';

const STAMP = /^\d{12}$/;
// The cron writes the index every minute; past this it has stopped.
const INDEX_FRESH_MS = 10 * 60 * 1000;

// ---------- NEA ----------

async function neaList(res, range) {
  const index = await readNeaIndex(range);
  let frames;
  let bounds;
  let center;
  if (index?.frames?.length && Date.now() - index.updatedAt < INDEX_FRESH_MS) {
    ({ bounds, center } = index);
    frames = index.frames.filter((f) => Date.parse(f.t) >= Date.now() - WINDOW_MS);
  } else {
    // No cron, or a stalled one: list straight from data.gov.sg.
    const path = `weather-radar-images/${range}`;
    let { meta, entries } = await windowBack(path, 'records', Date.now() - WINDOW_MS);
    if (!meta) meta = await latest(path);
    bounds = boundsOf(meta);
    center = meta?.projection?.center ?? null;
    frames = entries.filter((r) => r.timestamp).map((r) => ({ t: r.timestamp, stamp: stampOf(r.timestamp) }));
  }

  // A new frame arrives every five minutes.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    source: 'nea',
    range,
    bounds,
    center,
    frames: frames
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
      .map((f) => ({ t: f.t, src: `/api/radar?range=${range}&at=${f.stamp}` }))
  });
}

async function neaFrame(res, range, stamp) {
  let png = await getBytes(neaFramePath(range, stamp));
  if (!png) {
    // "Latest at or before" that minute, which is the frame itself when it exists.
    // Once more after a 429: a map opening on a cold deploy asks for many frames at once.
    const data = await at(`weather-radar-images/${range}`, sgMoment(msOfStamp(stamp)), { retries: 1 });
    const record = (data.records || []).find((r) => r.timestamp && stampOf(r.timestamp) === stamp);
    if (!record?.image?.url) {
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.status(404).json({ error: 'No radar frame at that time' });
    }
    const upstream = await fetch(record.image.url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error(`radar image answered ${upstream.status}`);
    png = Buffer.from(await upstream.arrayBuffer());
    if (blobConfigured()) await putBytes(neaFramePath(range, stamp), png, 'image/png').catch(() => {});
  }
  return sendPng(res, png);
}

function sendPng(res, png) {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.status(200).send(png);
}

// ---------- the others ----------

async function dwd(req, res) {
  const { at: stamp, cell } = req.query;
  if (stamp !== undefined) {
    const [clat, clon] = String(cell || '').split(',').map(Number);
    if (!STAMP.test(stamp) || !Number.isFinite(clat) || !Number.isFinite(clon) || (clat * 2) % 1 || (clon * 2) % 1) {
      return res.status(400).json({ error: 'cell must be a half degree "lat,lon" and at YYYYMMDDHHmm' });
    }
    const png = await dwdFrame(clat, clon, stamp);
    if (!png) {
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.status(404).json({ error: 'No radar frame at that time' });
    }
    return sendPng(res, png);
  }
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon are required' });
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  return res.status(200).json(await dwdList(lat, lon));
}

async function msc(req, res, layer) {
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  return res.status(200).json(await mscList(layer));
}

export default async function handler(req, res) {
  try {
    if (req.query.src === 'dwd') return await dwd(req, res);
    if (req.query.src === 'msc') return await msc(req, res, MSC_LAYER);
    if (req.query.src === 'msc-lightning') return await msc(req, res, MSC_LIGHTNING_LAYER);

    const range = NEA_RANGES.includes(req.query.range) ? req.query.range : '70km';
    const stamp = req.query.at;
    if (stamp === undefined) return await neaList(res, range);
    if (!STAMP.test(stamp)) return res.status(400).json({ error: 'at must be YYYYMMDDHHmm' });
    return await neaFrame(res, range, stamp);
  } catch (err) {
    console.warn('radar failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The radar is not answering right now' });
  }
}
