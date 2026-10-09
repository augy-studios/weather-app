// Radar tiles from the keyed services, for when RainViewer doesn't answer:
//
//   GET /api/tiles?p=owm|xweather&z=&x=&y=
//
// Proxied so the keys never reach the page, and held by the CDN for ten
// minutes, so a busy map costs each free tier one call per tile per ten
// minutes rather than one per visitor. Both are the radar as it is now; neither
// free plan has the past. Zoom stops at 7, as RainViewer's does, and the page
// enlarges beyond it, which keeps the number of distinct tiles small.

import { allow } from '../lib/cache.js';
import { OPEN_WEATHER_KEY, XWEATHER_AUTH } from '../lib/sources/fallbacks.js';

const MAX_ZOOM = 7;

const PROVIDERS = {
  owm: {
    quota: 'openweather',
    ready: () => Boolean(OPEN_WEATHER_KEY),
    url: (z, x, y) => `https://tile.openweathermap.org/map/precipitation_new/${z}/${x}/${y}.png?appid=${OPEN_WEATHER_KEY}`
  },
  xweather: {
    quota: 'xweather',
    ready: () => Boolean(XWEATHER_AUTH),
    url: (z, x, y) => `https://maps.api.xweather.com/${XWEATHER_AUTH.id}_${XWEATHER_AUTH.secret}/radar/${z}/${x}/${y}/current.png`
  }
};

export default async function handler(req, res) {
  const p = PROVIDERS[req.query.p];
  const [z, x, y] = ['z', 'x', 'y'].map((k) => Number(req.query[k]));
  if (!p || ![z, x, y].every(Number.isInteger) || z < 0 || z > MAX_ZOOM || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return res.status(400).json({ error: 'p must be owm or xweather, with whole z (0 to 7), x and y' });
  }
  if (!p.ready()) return res.status(404).json({ error: 'That radar is not set up' });

  if (!(await allow(p.quota))) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Over the free tier for now' });
  }
  try {
    const upstream = await fetch(p.url(z, x, y), { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error(`answered ${upstream.status}`);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    return res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn(`tiles ${req.query.p} failed:`, err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The radar is not answering right now' });
  }
}
