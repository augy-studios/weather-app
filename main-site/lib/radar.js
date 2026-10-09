// The rain radars the map scrubs through, three hours of each:
//
// - NEA, round Singapore. data.gov.sg hands out each image as a link that dies
//   after twenty minutes, and asking for an old one by date is what runs into
//   its rate limit. So the sg cron fetches every frame once, as it is
//   published, and keeps it in Blob with an index per range. A frame the cron
//   missed (a deploy, an outage) is backfilled a couple at a time.
// - The DWD, over Germany, through Bright Sky: five-minute rain grids, turned
//   into PNGs here and laid on the map by their corners.
// - MSC Canada's GeoMet radar, drawn by the page as WMS tiles; only the list of
//   times comes from here.

import { at, latest, sgMoment } from './datagov.js';
import { getJSON, putBytes, putJSON, remove } from './blob.js';
import { cached } from './cache.js';
import { encodePng } from './png.js';
import { fetchJSON, fetchText } from './wx.js';

export const WINDOW_MS = 3 * 3600 * 1000;
const STEP_MS = 5 * 60 * 1000;
const DAY = 24 * 3600 * 1000;

// ---------- NEA ----------

export const NEA_RANGES = ['70km', '240km', '480km'];
// Frames backfilled per range on each run of the cron.
const BACKFILL_PER_RUN = 2;

// "2026-10-07T23:55:00+08:00" to "202610072355": NEA's own clock, as its file names use.
export const stampOf = (iso) => iso.slice(0, 16).replace(/\D/g, '');
// Back again, as UTC milliseconds.
export const msOfStamp = (s) =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) - 8 * 3600 * 1000;

export const neaIndexPath = (range) => `radar/nea/${range}.json`;
export const neaFramePath = (range, stamp) => `radar/nea/${range}/${stamp}.png`;

export function boundsOf(meta) {
  const b = meta?.boundaryBox;
  if (!b?.upperLeft || !b?.lowerRight) return null;
  return [[b.lowerRight.latitude, b.upperLeft.longitude], [b.upperLeft.latitude, b.lowerRight.longitude]];
}

export const readNeaIndex = (range) => getJSON(neaIndexPath(range));

async function keepFrame(range, record) {
  const res = await fetch(record.image.url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`radar image answered ${res.status}`);
  await putBytes(neaFramePath(range, stampOf(record.timestamp)), Buffer.from(await res.arrayBuffer()), 'image/png');
}

/** One cron pass for one range: keep anything new, backfill a little, trim the old. */
export async function collectNea(range) {
  const path = `weather-radar-images/${range}`;
  const index = (await readNeaIndex(range)) || { range, bounds: null, center: null, frames: [], gaps: [] };
  const since = Date.now() - WINDOW_MS;
  const have = new Set(index.frames.map((f) => f.stamp));
  const gaps = new Set(index.gaps || []);
  const out = { range, kept: [], backfilled: [], trimmed: 0 };

  const add = async (records) => {
    const added = [];
    for (const r of records || []) {
      if (!r.timestamp || !r.image?.url || Date.parse(r.timestamp) < since) continue;
      const stamp = stampOf(r.timestamp);
      if (have.has(stamp)) continue;
      await keepFrame(range, r);
      have.add(stamp);
      index.frames.push({ t: r.timestamp, stamp });
      added.push(stamp);
    }
    return added;
  };

  const now = await latest(path);
  index.bounds = boundsOf(now) || index.bounds;
  index.center = now?.projection?.center ?? index.center;
  out.kept = await add(now.records);

  // Every five minute slot of the window that has no frame and hasn't been
  // found missing before, newest first.
  const newest = Math.max(...index.frames.map((f) => Date.parse(f.t)), Date.now() - STEP_MS);
  const wanted = [];
  for (let t = Math.floor(newest / STEP_MS) * STEP_MS - STEP_MS; t > since; t -= STEP_MS) {
    const stamp = stampOf(sgMoment(t));
    if (!have.has(stamp) && !gaps.has(stamp)) wanted.push(t);
  }
  for (const t of wanted.slice(0, BACKFILL_PER_RUN)) {
    const data = await at(path, sgMoment(t), { retries: 1 }).catch(() => null);
    if (!data) break; // rate limited: try again next run
    const added = await add(data.records);
    out.backfilled.push(...added);
    if (!have.has(stampOf(sgMoment(t)))) gaps.add(stampOf(sgMoment(t)));
  }

  // Out of the window: dropped from the index and from Blob.
  const old = index.frames.filter((f) => Date.parse(f.t) < since);
  if (old.length) {
    index.frames = index.frames.filter((f) => Date.parse(f.t) >= since);
    await remove(old.map((f) => neaFramePath(range, f.stamp)));
    out.trimmed = old.length;
  }
  index.gaps = [...gaps].filter((s) => msOfStamp(s) >= since);
  index.frames.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  index.updatedAt = Date.now();
  await putJSON(neaIndexPath(range), index);
  return out;
}

// ---------- DWD, through Bright Sky ----------

const BRIGHTSKY = 'https://api.brightsky.dev/radar';
// Around the place's half-degree cell: wide enough to see rain coming.
const DWD_DISTANCE_M = 200000;

// The NEA legend's colours, by rain rate in mm/h, so both radars read alike.
// Below 0.3 mm/h (about 15 dBZ) is left clear: the grid carries a haze of the
// faintest echoes over ground the stations report as dry.
const RATES = [
  [16, [210, 0, 165]], // very heavy, --radar-intense
  [4, [255, 31, 0]], // heavy, --radar-heavy
  [1, [255, 220, 0]], // moderate, --radar-moderate
  [0.3, [0, 186, 191]] // light, --radar-light
];

export const dwdCell = (lat, lon) => [Math.round(lat * 2) / 2, Math.round(lon * 2) / 2];

// The grid window round a cell and its corners, which never change: kept a month.
async function dwdGrid(lat, lon) {
  const { data } = await cached(`dwd-grid-${lat},${lon}`, { fresh: 30 * DAY, stale: 365 * DAY }, async () => {
    const t = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const j = await fetchJSON(`${BRIGHTSKY}?lat=${lat}&lon=${lon}&distance=${DWD_DISTANCE_M}&format=compressed&date=${t}&last_date=${t}`, { label: 'Bright Sky', timeout: 15000 });
    if (!j.bbox || !j.geometry?.coordinates?.length) throw new Error('Bright Sky sent no radar grid');
    // Four [lon, lat] corners: top left, bottom left, bottom right, top right.
    // Sent as a flat list; a GeoJSON style nested ring reads too.
    const c = j.geometry.coordinates;
    return { bbox: j.bbox, corners: (Array.isArray(c[0][0]) ? c[0] : c).slice(0, 4) };
  });
  return data;
}

// [[south, west], [north, east]] round the four corners.
function boxOf(corners) {
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
}

/** The last three hours of frame times round a place: { bounds, frames: [{ t, src }] }. */
export async function dwdList(lat, lon) {
  const [clat, clon] = dwdCell(lat, lon);
  const grid = await dwdGrid(clat, clon);
  // A one kilometre window is enough to learn which times exist.
  const from = new Date(Date.now() - WINDOW_MS).toISOString();
  const to = new Date().toISOString();
  const j = await fetchJSON(`${BRIGHTSKY}?lat=${clat}&lon=${clon}&distance=1000&format=compressed&date=${from}&last_date=${to}`, { label: 'Bright Sky' });
  const frames = (j.radar || [])
    .map((r) => r.timestamp)
    .filter((t) => Date.parse(t) <= Date.now())
    .sort()
    .map((t) => ({ t, src: `/api/radar?src=dwd&cell=${clat},${clon}&at=${t.slice(0, 16).replace(/\D/g, '')}` }));
  return { source: 'dwd', bounds: boxOf(grid.corners), frames };
}

const toMerc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const fromMerc = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

/**
 * One frame as a PNG covering boxOf(corners). Each pixel of the image, laid out
 * in the map's own Mercator, looks up the grid cell under it through the affine
 * map the corners give, which over a few hundred kilometres is within a pixel.
 */
export async function dwdFrame(clat, clon, stamp) {
  const grid = await dwdGrid(clat, clon);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:00Z`;
  const j = await fetchJSON(`${BRIGHTSKY}?bbox=${grid.bbox.join(',')}&format=compressed&date=${iso}&last_date=${iso}`, { label: 'Bright Sky', timeout: 15000 });
  const record = (j.radar || []).find((r) => r.timestamp.startsWith(iso.slice(0, 16))) || j.radar?.[0];
  if (!record) return null;

  const [top, left, bottom, right] = grid.bbox;
  const gw = right - left + 1;
  const gh = bottom - top + 1;
  const { inflateSync } = await import('node:zlib');
  const raw = inflateSync(Buffer.from(record.precipitation_5, 'base64'));
  const value = (x, y) => raw.readUInt16LE((y * gw + x) * 2);

  // Grid to place: the top left corner, and one step right and one step down.
  const [tl, bl, , tr] = grid.corners;
  const ax = (tr[0] - tl[0]) / gw, bx = (bl[0] - tl[0]) / gh;
  const ay = (tr[1] - tl[1]) / gw, by = (bl[1] - tl[1]) / gh;
  const det = ax * by - bx * ay;

  const [[south, west], [north, east]] = boxOf(grid.corners);
  const width = gw;
  const height = Math.round(gw * ((toMerc(north) - toMerc(south)) / (((east - west) * Math.PI) / 180)));
  const rgba = new Uint8Array(width * height * 4);
  const yTop = toMerc(north);
  const yStep = (toMerc(north) - toMerc(south)) / height;

  for (let j2 = 0; j2 < height; j2++) {
    const lat = fromMerc(yTop - (j2 + 0.5) * yStep);
    for (let i = 0; i < width; i++) {
      const lon = west + ((i + 0.5) / width) * (east - west);
      const dl = lon - tl[0];
      const dp = lat - tl[1];
      const gx = Math.floor((dl * by - bx * dp) / det);
      const gy = Math.floor((ax * dp - dl * ay) / det);
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
      // Hundredths of a millimetre in five minutes, to millimetres an hour.
      const rate = value(gx, gy) * 0.12;
      const colour = RATES.find(([min]) => rate >= min)?.[1];
      if (!colour) continue;
      const o = (j2 * width + i) * 4;
      rgba[o] = colour[0];
      rgba[o + 1] = colour[1];
      rgba[o + 2] = colour[2];
      rgba[o + 3] = 255;
    }
  }
  return encodePng(width, height, rgba);
}

// ---------- MSC Canada ----------

const GEOMET = 'https://geo.weather.gc.ca/geomet';
export const MSC_LAYER = 'RADAR_1KM_RRAI';

// Canada's lightning grid, every ten minutes, drawn the same way over the radar.
export const MSC_LIGHTNING_LAYER = 'Lightning_2.5km_Density';

/** A GeoMet layer's times, from its capabilities: "start/end/PT6M". The radar by default. */
export async function mscList(layer = MSC_LAYER) {
  const xml = await fetchText(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${layer}`, { label: 'GeoMet', timeout: 12000 });
  const dim = xml.match(/<Dimension[^>]*name="time"[^>]*>([^<]+)</)?.[1]?.trim();
  const [start, end, step] = (dim || '').split('/');
  const minutes = Number(step?.match(/PT(\d+)M/)?.[1]);
  if (!Date.parse(start) || !Date.parse(end) || !minutes) throw new Error('GeoMet listed no radar times');
  const frames = [];
  for (let t = Date.parse(end); t >= Math.max(Date.parse(start), Date.now() - WINDOW_MS); t -= minutes * 60000) {
    frames.unshift({ t: new Date(t).toISOString() });
  }
  return { source: 'msc', url: GEOMET, layer, frames };
}
