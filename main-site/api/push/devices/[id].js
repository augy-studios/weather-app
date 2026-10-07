// Turn lightning alerts on for a browser or change its places and distance (PUT,
// sent again on every page load and whenever the saved places change, which also
// keeps the subscription fresh), off (DELETE: the device is forgotten), or send it
// a test alert (POST). sg-psi's api/push/devices/[id].js, with places in place
// of a PSI area and level.

import { pushConfigured, pushTest } from '../../../lib/lightning.js';
import { devices, rateLimited, releaseLock, storeConfigured, takeLock } from '../../../lib/kv.js';
import { ValidationError, isId, parseDevice } from '../../../lib/push-validate.js';
import { readBody } from '../../../lib/portal.js';

const MAX_DEVICES = 50_000;
const RATE_LIMIT = 60; // requests per IP per minute
// Between test alerts to one device.
const TEST_GAP_SECONDS = 15;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeConfigured()) return res.status(503).json({ error: 'Lightning alerts are not set up: no Redis store' });

  const { id } = req.query;
  if (!isId(id)) return res.status(400).json({ error: 'bad device id' });

  // Vercel puts the client's address first in x-forwarded-for.
  const ip = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  try {
    if (await rateLimited(ip, RATE_LIMIT)) return res.status(429).json({ error: 'too many requests' });

    if (req.method === 'PUT') {
      if (!(await devices.has(id)) && (await devices.size()) >= MAX_DEVICES) {
        return res.status(503).json({ error: 'server full' });
      }
      const device = parseDevice(readBody(req));
      await devices.set(id, { ...device, updatedAt: Date.now() });
      return res.status(200).json({ places: device.places.length, radiusKm: device.radiusKm });
    }

    if (req.method === 'DELETE') {
      await devices.delete(id);
      return res.status(204).end();
    }

    // Only the device itself knows its id, so a test can only reach the one asking.
    if (req.method === 'POST') {
      if (!pushConfigured()) return res.status(503).json({ error: 'Lightning alerts are not set up: VAPID keys missing' });
      const device = await devices.get(id);
      if (!device) return res.status(404).json({ error: 'device not signed up' });
      if (!(await takeLock(`test:${id}`, TEST_GAP_SECONDS))) return res.status(429).json({ error: 'a test was just sent' });

      const result = await pushTest(id, device);
      if (result === 'sent') return res.status(200).json({ sent: true });
      // Only a test that arrived counts against the gap: the page signs up again and retries.
      await releaseLock(`test:${id}`).catch(() => {});
      if (result === 'dropped') return res.status(410).json({ error: 'subscription expired' });
      return res.status(502).json({ error: 'the push service turned it away' });
    }

    res.setHeader('Allow', 'PUT, DELETE, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
}
