// Our own offline map archives (js/offline.js), built from OpenStreetMap by
// .github/workflows/offline-maps.yml and kept on the repository's
// `offline-maps` release, each as <id>.json, which names its build, and the
// archive in 1 GiB files, <id>-<build>.pmtiles.000, .001, …:
//
//   GET /api/mappack?id=japan                  { size, etag, updated, part, parts }
//   GET /api/mappack?id=japan&part=N&v=build   bytes N*part .. (N+1)*part-1
//
// The page can't fetch the release itself: GitHub's downloads send no CORS
// headers. So it comes through here in pieces of 4 MiB, under Vercel's 4.5 MB
// response limit, which also lets a stopped download carry on where it was.
// A piece's address names its build, and a build's files never change, so the
// CDN keeps a piece for good and a download never mixes two builds. The
// workflow keeps the build before the newest, so a download already under way
// can finish; once its build is gone, its pieces get 409, and the page starts
// that pack again.
//
// Not an open proxy: only the archives lib/map-packs.js names, on one release.

import packs from '../lib/map-packs.js';

const RELEASE = process.env.MAP_RELEASE_URL || 'https://github.com/augy-studios/weather-app/releases/download/offline-maps';
const USER_AGENT = 'uwu-weather/1.0 (+https://weather.uwuapps.org)';
export const PART = 4 * 1024 * 1024;
// The size of each release file but the last. Keep in step with `split -b` in
// the workflow; a multiple of PART, so no piece spans two files.
export const CHUNK = 1024 * 1024 * 1024;

const isArchive = (id) => Object.hasOwn(packs, id) && Boolean(packs[id].archive);

async function manifest(id) {
  const res = await fetch(`${RELEASE}/${id}.json`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const err = new Error(`${id}.json answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const m = await res.json();
  if (!/^\d+$/.test(String(m.build)) || !(m.size > 0) || !Array.isArray(m.files)) throw new Error(`${id}.json is not a manifest`);
  return m;
}

export default async function handler(req, res) {
  const id = String(req.query.id || '');
  if (!isArchive(id)) {
    const ids = Object.keys(packs).filter(isArchive);
    return res.status(404).json({ error: `id must be one of ${ids.join(', ')}` });
  }

  try {
    if (req.query.part == null) {
      const m = await manifest(id);
      // A few minutes, so a rebuild reaches phones the same day.
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      return res.status(200).json({
        id, size: m.size, etag: String(m.build), part: PART, parts: Math.ceil(m.size / PART), updated: m.built || null
      });
    }

    const part = Number(req.query.part);
    const v = String(req.query.v || '');
    if (!Number.isInteger(part) || part < 0 || part > 8192 || !/^\d{1,20}$/.test(v)) {
      return res.status(400).json({ error: 'part must be a whole number, with v the build' });
    }
    const start = part * PART;
    const file = `${id}-${v}.pmtiles.${String(Math.floor(start / CHUNK)).padStart(3, '0')}`;
    const from = start % CHUNK;
    const upstream = await fetch(`${RELEASE}/${file}`, {
      headers: { 'User-Agent': USER_AGENT, Range: `bytes=${from}-${from + PART - 1}` },
      signal: AbortSignal.timeout(20000)
    });
    if (upstream.status === 416) return res.status(416).json({ error: 'part is past the end of the map' });
    if (upstream.status === 404) {
      // That build has been taken down, or never was: start again.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(409).json({ error: 'The map has been rebuilt since; start again' });
    }
    if (upstream.status !== 206 && upstream.status !== 200) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: `The map file answered ${upstream.status}` });
    }
    let body = Buffer.from(await upstream.arrayBuffer());
    // A server that ignores Range sends the lot: cut out the piece.
    if (upstream.status === 200) body = body.subarray(from, from + PART);
    if (!body.length) return res.status(416).json({ error: 'part is past the end of the map' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(body);
  } catch (err) {
    console.warn('mappack failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    if (err.status === 404) return res.status(404).json({ error: 'That map hasn\'t been built yet' });
    return res.status(502).json({ error: 'The map file is not answering right now' });
  }
}
