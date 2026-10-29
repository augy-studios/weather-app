// Builds lib/map-packs.js, the tiles in each offline map the Map page can keep:
// Singapore to zoom 14 and Malaysia to zoom 11, from the country outlines in
// lib/countries.js with a margin round them, and a city's centre to zoom 14,
// from a box, so its buildings stand up in 3D. Run it by hand when the
// outlines or the packs change; nothing runs it at deploy time. It needs a
// connection: it asks OpenFreeMap how big every tile is.
//
//   node lib/build-map-packs.mjs              every pack, into lib/map-packs.js
//   node lib/build-map-packs.mjs paris rome   just those, measured and printed,
//                                             to try a box; nothing is written
//
// The tiles are OpenFreeMap's: its vector tiles, 512 px on the XYZ grid, which
// stop at zoom 14, and Liberty's shaded relief under them, 256 px, which stops
// at zoom 6. The buildings are in the zoom 14 tiles, and the 3D layer draws
// them from zoom 14 up. OpenFreeMap's terms allow a download of at most 3,000
// tiles or 50 MB (https://openfreemap.org/tos/), so the build stops if a pack
// is over the count, or over MAX_MB with its fonts and icons; /api/maptile and
// the page stop at 50 MB. Each pack's size goes in the file, and in the list
// it prints for js/offline.js's PACKS.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import countries from './countries.js';
import { GLYPHS } from '../api/maptile.js';

const MAX_TILES = 3000;
// Under OpenFreeMap's 50 MB, with room for the tiles to grow from week to week.
const MAX_MB = 45;
const RELIEF_MAX_ZOOM = 6;
// A city's surroundings, to zoom 9, so zooming out from it doesn't fall off
// the edge of the map: its box grown by this many degrees. Zoom 10 round a
// big city runs to 5-8 MB.
const AROUND = 0.5;
const AROUND_MAX_ZOOM = 9;

// A country: its outline, with a margin in degrees that catches what the 1:50m
// outlines leave off: small islands, the coast's own detail, and a little of
// the neighbours across the water, which the map shows anyway.
// A city: its centre as a box [w, s, e, n], the built-up core, sized to stay
// well under 50 MB at zoom 14 (dense centres run to 150-300 KB a tile).
const PACKS = [
  { id: 'sg', code: 'SG', name: 'Singapore', maxzoom: 14, margin: 0.1 },
  { id: 'my', code: 'MY', name: 'Malaysia', maxzoom: 11, margin: 0.15 },
  // Malaysia's cities, with their buildings, which the country's own pack can't
  // reach: all of it at zoom 14 is about 220 MB.
  { id: 'kuala-lumpur', name: 'Kuala Lumpur', bbox: [101.45, 2.95, 101.8, 3.28] },
  { id: 'penang', name: 'Penang', bbox: [100.17, 5.15, 100.55, 5.55] },
  { id: 'johor-bahru', name: 'Johor Bahru', bbox: [103.55, 1.4, 103.95, 1.65] },
  { id: 'kota-kinabalu', name: 'Kota Kinabalu', bbox: [116.02, 5.88, 116.18, 6.08] },
  { id: 'kuching', name: 'Kuching', bbox: [110.25, 1.45, 110.45, 1.63] },
  // Asia.
  { id: 'taipei', name: 'Taipei', bbox: [121.4, 24.95, 121.66, 25.15] },
  { id: 'hong-kong', name: 'Hong Kong', bbox: [114.1, 22.24, 114.27, 22.4] },
  { id: 'bangkok', name: 'Bangkok', bbox: [100.45, 13.68, 100.65, 13.83] },
  { id: 'kyoto', name: 'Kyoto', bbox: [135.64, 34.9, 135.85, 35.1] },
  { id: 'tokyo', name: 'Tokyo', bbox: [139.65, 35.62, 139.83, 35.75] },
  { id: 'seoul', name: 'Seoul', bbox: [126.85, 37.47, 127.15, 37.62] },
  // Europe.
  { id: 'london', name: 'London', bbox: [-0.23, 51.45, 0.01, 51.56] },
  { id: 'paris', name: 'Paris', bbox: [2.22, 48.81, 2.47, 48.91] },
  { id: 'amsterdam', name: 'Amsterdam', bbox: [4.73, 52.3, 5.05, 52.43] },
  { id: 'barcelona', name: 'Barcelona', bbox: [2.05, 41.32, 2.25, 41.47] },
  { id: 'rome', name: 'Rome', bbox: [12.33, 41.77, 12.66, 42.0] },
  // North America.
  { id: 'new-york', name: 'New York City', bbox: [-74.04, 40.57, -73.84, 40.88] },
  { id: 'vancouver', name: 'Vancouver', bbox: [-123.27, 49.1, -122.75, 49.38] },
  { id: 'san-francisco', name: 'San Francisco', bbox: [-122.53, 37.7, -122.17, 37.9] },
  // Australia.
  { id: 'sydney', name: 'Sydney', bbox: [151.1, -33.95, 151.3, -33.8] }
];

const HOST = 'https://tiles.openfreemap.org';
const USER_AGENT = 'uwu-weather/1.0 (+https://weather.uwuapps.org)';
const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];

const lonOf = (x, z) => (x / 2 ** z) * 360 - 180;
const latOf = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const xOf = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const yOf = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

// Even-odd over every ring of every polygon.
function contains(polygons, lon, lat) {
  let inside = false;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

// Whether the segment a-b crosses the box [w, s, e, n] (Liang-Barsky).
function crosses([ax, ay], [bx, by], [w, s, e, n]) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [[-dx, ax - w], [dx, e - ax], [-dy, ay - s], [dy, n - ay]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// A tile is in when its box, grown by the margin, touches the country: an
// edge of the outline crosses it, or it sits inside the outline.
function touches(polygons, box) {
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (crosses(ring[j], ring[i], box)) return true;
      }
    }
  }
  return contains(polygons, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
}

function tilesFor(polygons, bbox, margin, maxzoom) {
  const [w, s, e, n] = [bbox[0] - margin, bbox[1] - margin, bbox[2] + margin, bbox[3] + margin];
  const out = [];
  for (let z = 0; z <= maxzoom; z++) {
    for (let x = xOf(w, z); x <= xOf(e, z); x++) {
      for (let y = yOf(n, z); y <= yOf(s, z); y++) {
        const box = [lonOf(x, z) - margin, latOf(y + 1, z) - margin, lonOf(x + 1, z) + margin, latOf(y, z) + margin];
        if (touches(polygons, box)) out.push(`${z}/${x}/${y}`);
      }
    }
  }
  return out;
}

// Every tile over a box, from zoom `from` to `to`.
function tilesIn([w, s, e, n], from, to) {
  const out = [];
  for (let z = from; z <= to; z++) {
    for (let x = xOf(w, z); x <= xOf(e, z); x++) {
      for (let y = yOf(n, z); y <= yOf(s, z); y++) out.push(`${z}/${x}/${y}`);
    }
  }
  return out;
}

// A city: its surroundings to zoom 10, and its box to zoom 14.
function cityTiles(bbox, maxzoom) {
  const [w, s, e, n] = bbox;
  const around = tilesIn([w - AROUND, s - AROUND, e + AROUND, n + AROUND], 0, AROUND_MAX_ZOOM);
  return [...new Set([...around, ...tilesIn(bbox, 0, maxzoom)])];
}

// What OpenFreeMap sends for a file, gzipped, which is what the page counts
// against the 50 MB. Its tiles say in Content-Length; its fonts don't, so the
// page counts them unpacked, and so does this.
async function sizeOf(path, method = 'HEAD') {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(HOST + path, { method, headers: { 'User-Agent': USER_AGENT } });
      if (res.status === 404 || res.status === 204) return 0;
      if (!res.ok) throw new Error(`${path} replied ${res.status}`);
      const length = Number(res.headers.get('content-length'));
      if (length) return length;
      return method === 'HEAD' ? sizeOf(path, 'GET') : (await res.arrayBuffer()).byteLength;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// Four at a time, OpenFreeMap's limit.
async function totalOf(paths) {
  let next = 0;
  let total = 0;
  const worker = async () => {
    while (next < paths.length) {
      // Not `total += await …`, which reads total before the wait and loses
      // what the other workers added meanwhile.
      const size = await sizeOf(paths[next++]);
      total += size;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return total;
}

const week = (await (await fetch(`${HOST}/planet`, { headers: { 'User-Agent': USER_AGENT } })).json()).tiles[0].match(/\/planet\/([^/]+)\//)[1];
// What every pack carries besides its tiles: both styles, their icons, the fonts.
const styles = await Promise.all(['liberty', 'dark'].map(async (s) => (await fetch(`${HOST}/styles/${s}`, { headers: { 'User-Agent': USER_AGENT } })).json()));
const sprites = [...new Set(styles.map((s) => new URL(s.sprite).pathname))];
const shared = await totalOf([
  '/planet', '/styles/liberty', '/styles/dark',
  ...sprites.flatMap((p) => ['.json', '.png', '@2x.json', '@2x.png'].map((ext) => p + ext)),
  ...FONTS.flatMap((f) => GLYPHS.map((r) => `/fonts/${encodeURIComponent(f)}/${r}.pbf`))
]);

const only = process.argv.slice(2);
const packs = {};
const over = [];
for (const p of PACKS.filter((k) => !only.length || only.includes(k.id))) {
  const maxzoom = p.maxzoom ?? 14;
  let vector;
  let relief;
  let bbox;
  if (p.code) {
    const c = countries.find((k) => k.code === p.code);
    if (!c) throw new Error(`No outline for ${p.code}`);
    vector = tilesFor(c.polygons, c.bbox, p.margin, maxzoom);
    relief = tilesFor(c.polygons, c.bbox, p.margin, RELIEF_MAX_ZOOM);
    const [w, s, e, n] = c.bbox;
    bbox = [w - p.margin, s - p.margin, e + p.margin, n + p.margin];
  } else {
    vector = cityTiles(p.bbox, maxzoom);
    relief = tilesIn(p.bbox, 0, RELIEF_MAX_ZOOM);
    bbox = p.bbox;
  }
  const count = vector.length + relief.length;
  if (count > MAX_TILES) over.push(`${p.name} is ${count} tiles, over OpenFreeMap's ${MAX_TILES}`);
  const bytes = shared
    + (await totalOf(vector.map((t) => `/planet/${week}/${t}.pbf`)))
    + (await totalOf(relief.map((t) => `/natural_earth/ne2sr/${t}.png`)));
  if (bytes > MAX_MB * 1e6) over.push(`${p.name} is ${(bytes / 1e6).toFixed(1)} MB, over ${MAX_MB} MB`);
  packs[p.id] = {
    name: p.name,
    maxzoom,
    bbox: bbox.map((v) => Math.round(v * 100) / 100),
    mb: Math.round(bytes / 1e6),
    vector,
    relief
  };
  const z14 = vector.filter((t) => t.startsWith(`${maxzoom}/`)).length;
  console.log(`${p.name}: ${vector.length} vector tiles to zoom ${maxzoom} (${z14} at ${maxzoom}), ${relief.length} relief tiles, ${count} in all, ${(bytes / 1e6).toFixed(1)} MB`);
}

if (over.length) throw new Error(`Make these smaller:\n${over.join('\n')}`);
if (only.length) process.exit(0);

const header = `// Generated by lib/build-map-packs.mjs from lib/countries.js and its city boxes,
// with OpenFreeMap's tiles of ${week}. Do not edit by hand.
// { id: { name, maxzoom, bbox: [w, s, e, n], mb, vector: ["z/x/y"], relief: ["z/x/y"] } }
`;
writeFileSync(fileURLToPath(new URL('./map-packs.js', import.meta.url)), `${header}export default ${JSON.stringify(packs)};\n`);
console.log('\nFor js/offline.js PACKS, the sizes:');
console.log(Object.entries(packs).map(([id, p]) => `${id}: ${p.mb}`).join(', '));
