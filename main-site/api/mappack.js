// Our own offline map archives (js/offline.js), built from OpenStreetMap by
// .github/workflows/offline-maps.yml and kept on the repository's
// `offline-maps` release:
//
//   GET /api/mappack?id=malaysia               { size, etag, updated, part, parts }
//   GET /api/mappack?id=malaysia&part=N&v=etag  bytes N*part .. (N+1)*part-1
//
// The page can't fetch the release itself: GitHub's downloads send no CORS
// headers. So it comes through here in pieces of 4 MiB, under Vercel's 4.5 MB
// response limit, which also lets a stopped download carry on where it was.
// A piece's address names the file's ETag, so the CDN can keep it for good,
// and a piece of a newer file never lands in an older download: a stale ETag
// gets 409, and the page starts that pack again.
//
// Not an open proxy: only the archives lib/map-packs.js names, on one release.

import packs from '../lib/map-packs.js';

const RELEASE = process.env.MAP_RELEASE_URL || 'https://github.com/augy-studios/weather-app/releases/download/offline-maps';
const USER_AGENT = 'uwu-weather/1.0 (+https://weather.uwuapps.org)';
export const PART = 4 * 1024 * 1024;

const archiveOf = (id) => (Object.hasOwn(packs, id) ? packs[id].archive : null);
const urlOf = (archive) => `${RELEASE}/${archive.file}`;
const tagOf = (headers) => (headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');

export default async function handler(req, res) {
  const id = String(req.query.id || '');
  const archive = archiveOf(id);
  if (!archive) {
    const ids = Object.keys(packs).filter((k) => packs[k].archive);
    return res.status(404).json({ error: `id must be one of ${ids.join(', ')}` });
  }

  try {
    if (req.query.part == null) {
      const head = await fetch(urlOf(archive), { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
      if (!head.ok) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(head.status === 404 ? 404 : 502).json({ error: `The map file answered ${head.status}` });
      }
      const size = Number(head.headers.get('content-length'));
      const etag = tagOf(head.headers);
      if (!size || !etag) throw new Error('no size or ETag on the map file');
      // A few minutes, so a rebuild reaches phones the same day.
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      return res.status(200).json({
        id, size, etag, part: PART, parts: Math.ceil(size / PART),
        updated: head.headers.get('last-modified') || null
      });
    }

    const part = Number(req.query.part);
    const v = String(req.query.v || '');
    if (!Number.isInteger(part) || part < 0 || part > 4096 || !v) {
      return res.status(400).json({ error: 'part must be a whole number, with v the ETag' });
    }
    const start = part * PART;
    const upstream = await fetch(urlOf(archive), {
      headers: { 'User-Agent': USER_AGENT, Range: `bytes=${start}-${start + PART - 1}` },
      signal: AbortSignal.timeout(20000)
    });
    if (upstream.status === 416) return res.status(416).json({ error: 'part is past the end of the file' });
    if (upstream.status !== 206 && upstream.status !== 200) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: `The map file answered ${upstream.status}` });
    }
    if (tagOf(upstream.headers) !== v) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(409).json({ error: 'The map file has been rebuilt since; start again' });
    }
    let body = Buffer.from(await upstream.arrayBuffer());
    // A server that ignores Range sends the lot: cut out the piece.
    if (upstream.status === 200) body = body.subarray(start, start + PART);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(body);
  } catch (err) {
    console.warn('mappack failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The map file is not answering right now' });
  }
}
