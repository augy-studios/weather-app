// OpenFreeMap's files for the offline maps (js/offline.js):
//
//   GET /api/maptile?pack=sg|my       what the pack holds: its tiles, fonts and styles
//   GET /api/maptile?path=/planet/…   one file from tiles.openfreemap.org
//
// OpenFreeMap allows offline downloads of at most 3,000 tiles or 50 MB, with at
// most four requests at a time, each with a User-Agent naming the app
// (https://openfreemap.org/tos/). A page can't set its User-Agent, so the
// download comes through here, which sets one. The page keeps to four at a
// time and stops at 50 MB; lib/build-map-packs.mjs keeps each pack under the
// tile count.
//
// Not an open proxy: one host, and only the paths a pack needs. Tiles must be
// in a pack's list, fonts and glyph ranges in the lists below. Nothing about
// the visitor is logged. Ordinary map browsing goes straight to OpenFreeMap.

import { gzipSync } from 'node:zlib';
import packs from '../lib/map-packs.js';

const HOST = 'https://tiles.openfreemap.org';
const USER_AGENT = 'uwu-weather/1.0 (+https://weather.uwuapps.org)';

// The styles the Map page draws (js/map.js), and the fonts they name.
const STYLES = ['liberty', 'dark'];
const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];
// Glyph ranges, 256 code points each: the ones the labels asked for over
// Singapore and Malaysia at every zoom, in both styles. Latin and its accents,
// Cyrillic, Arabic (Jawi), Tamil, Devanagari, Malayalam, Thai, Tibetan,
// Myanmar and Khmer for the neighbours' names at the wider zooms, Vietnamese
// accents, and punctuation. Chinese is drawn from the device's own fonts, so
// none of its ranges are needed.
export const GLYPHS = [
  '0-255', '256-511', '768-1023', '1024-1279', '1536-1791', '2304-2559', '2816-3071',
  '3328-3583', '3584-3839', '3840-4095', '4096-4351', '5888-6143', '7680-7935', '8192-8447'
];

const VECTOR = new Set(Object.values(packs).flatMap((p) => p.vector));
const RELIEF = new Set(Object.values(packs).flatMap((p) => p.relief));

const DAY = 86400;

// The cache time for a path, or null when it isn't one a pack needs.
function allowed(path) {
  let m;
  if ((m = path.match(/^\/styles\/([a-z]+)$/))) return STYLES.includes(m[1]) ? DAY / 24 : null;
  if (path === '/planet') return DAY / 24;
  // Each week's tiles have their own address and never change.
  if ((m = path.match(/^\/planet\/\d{8}_\d{6}_pt\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.pbf$/))) {
    return VECTOR.has(`${m[1]}/${m[2]}/${m[3]}`) ? 365 * DAY : null;
  }
  if ((m = path.match(/^\/natural_earth\/ne2sr\/(\d{1,2})\/(\d{1,3})\/(\d{1,3})\.png$/))) {
    return RELIEF.has(`${m[1]}/${m[2]}/${m[3]}`) ? 30 * DAY : null;
  }
  if ((m = path.match(/^\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/))) {
    let font;
    try {
      font = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    return FONTS.includes(font) && GLYPHS.includes(m[2]) ? 30 * DAY : null;
  }
  if (/^\/sprites\/ofm_[a-z0-9]{1,12}\/ofm(@2x)?\.(json|png)$/.test(path)) return 30 * DAY;
  return null;
}

export default async function handler(req, res) {
  if (req.query.pack) {
    const p = packs[req.query.pack];
    if (!p) return res.status(404).json({ error: 'pack must be sg or my' });
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).json({ id: req.query.pack, ...p, styles: STYLES, fonts: FONTS, glyphs: GLYPHS });
  }

  const path = String(req.query.path || '');
  const maxAge = allowed(path);
  if (maxAge == null) return res.status(400).json({ error: 'Not a file an offline map needs' });

  try {
    const upstream = await fetch(HOST + path, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: `OpenFreeMap answered ${upstream.status}` });
    }
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    // What OpenFreeMap sent, compressed, which is what its 50 MB counts. The
    // page adds these up.
    const sent = upstream.headers.get('content-length');
    let body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge}`);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('X-Upstream-Length', sent || String(body.length));
    // Tiles and styles compress to about half; the icons and relief are PNG already.
    if (!type.startsWith('image/') && /\bgzip\b/.test(req.headers?.['accept-encoding'] || '')) {
      body = gzipSync(body);
      res.setHeader('Content-Encoding', 'gzip');
    }
    return res.status(200).send(body);
  } catch (err) {
    console.warn('maptile failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'OpenFreeMap is not answering right now' });
  }
}
