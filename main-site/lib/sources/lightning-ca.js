// Lightning over Canada, from Environment Canada's GeoMet: the Canadian
// Lightning Detection Network's flashes, cloud to ground and in cloud, counted
// on a 2.5 km grid every ten minutes (the Lightning_2.5km_Density layer).
//
// There is no list of strikes, only the grid, so the grid round the watched
// places is drawn as a small PNG at one pixel a cell and every lit pixel becomes
// a "strike" at the cell's centre. lib/lightning.js then measures and warns as
// it does for NEA's. One request per one-degree square holding a watched place,
// every ten minutes, keeps well inside GeoMet's rate limit.

import { decodePng } from '../png.js';
import { HttpError, fetchText } from '../wx.js';

const GEOMET = 'https://geo.weather.gc.ca/geomet';
export const LIGHTNING_LAYER = 'Lightning_2.5km_Density';
// A pixel a cell, about 2.5 km north to south.
const DEG = 0.025;
// Room round each square for the widest alert distance, 20 km.
const MARGIN_KM = 25;
const SQUARES_AT_ONCE = 4;

// Asked once a minute at most per instance: places built together share it.
let known = { time: null, at: 0 };

/** The newest ten minutes the layer has, as an ISO time. */
export async function latestTime() {
  if (known.time && Date.now() - known.at < 60 * 1000) return known.time;
  const xml = await fetchText(`${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${LIGHTNING_LAYER}`, { label: 'GeoMet', timeout: 20000 });
  const dim = xml.match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"/)?.[1];
  if (!Date.parse(dim)) throw new Error('GeoMet listed no lightning time');
  known = { time: dim, at: Date.now() };
  return dim;
}

async function square(lat0, lon0, time) {
  const dLat = MARGIN_KM / 111;
  const dLon = MARGIN_KM / (111 * Math.cos(((lat0 + 0.5) * Math.PI) / 180));
  const [south, north] = [lat0 - dLat, lat0 + 1 + dLat];
  const [west, east] = [lon0 - dLon, lon0 + 1 + dLon];
  const width = Math.ceil((east - west) / DEG);
  const height = Math.ceil((north - south) / DEG);
  // WMS 1.3.0 in EPSG:4326 takes the box latitude first.
  const params = new URLSearchParams({
    service: 'WMS', version: '1.3.0', request: 'GetMap', layers: LIGHTNING_LAYER, styles: '',
    crs: 'EPSG:4326', bbox: [south, west, north, east].map((v) => v.toFixed(4)).join(','),
    width: String(width), height: String(height), format: 'image/png', transparent: 'true', time
  });
  // GeoMet's answer times swing from a third of a second to half a minute for
  // the same request, so it gets a generous wait, once.
  const res = await fetch(`${GEOMET}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new HttpError(`GeoMet lightning answered ${res.status}`, res.status);
  const png = decodePng(Buffer.from(await res.arrayBuffer()));

  const flashes = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!png.alpha(x, y)) continue;
      flashes.push({
        lat: north - ((y + 0.5) / png.height) * (north - south),
        lon: west + ((x + 0.5) / png.width) * (east - west),
        t: time,
        type: 'flash',
        source: 'eccc'
      });
    }
  }
  return flashes;
}

/**
 * Every lit cell within reach of any of these places in the ten minutes to
 * `time`, as strikes: [{ lat, lon, t, type: 'flash', source: 'eccc' }].
 * A square that fails is skipped; a 429 stops the round rather than pressing
 * on into the rate limit.
 */
export async function canadaFlashes(places, time) {
  const squares = new Map();
  for (const p of places) squares.set(`${Math.floor(p.lat)},${Math.floor(p.lon)}`, [Math.floor(p.lat), Math.floor(p.lon)]);
  const queue = [...squares.values()];
  const out = [];
  let limited = false;
  // A few at once, so a slow answer doesn't hold up the rest past the cron's minute.
  const worker = async () => {
    while (queue.length && !limited) {
      const [lat0, lon0] = queue.shift();
      try {
        out.push(...(await square(lat0, lon0, time)));
      } catch (err) {
        console.warn('Canadian lightning failed:', err.message);
        if (err.status === 429) limited = true;
      }
    }
  };
  await Promise.all(Array.from({ length: SQUARES_AT_ONCE }, worker));
  return out;
}

/** The nearest lit cell within `km` of a point in the latest ten minutes, or null. For the Now page. */
export async function nearestFlash(lat, lon, km = 20) {
  const time = await latestTime();
  const flashes = await canadaFlashes([{ lat, lon }], time);
  const rad = Math.PI / 180;
  let best = null;
  for (const f of flashes) {
    const a = Math.sin(((f.lat - lat) * rad) / 2) ** 2 +
      Math.cos(lat * rad) * Math.cos(f.lat * rad) * Math.sin(((f.lon - lon) * rad) / 2) ** 2;
    const d = 12742 * Math.asin(Math.sqrt(a));
    if (d <= km && (!best || d < best.km)) best = { km: Math.round(d * 10) / 10, t: time, lat: f.lat, lon: f.lon };
  }
  return { time, nearest: best };
}
