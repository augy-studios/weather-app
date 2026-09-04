// The synced list of saved places.
//
// GET  reads it, with the portal id in the x-portal-id header so the secret
//      never lands in a URL or an access log.
// POST writes it, two ways:
//        { mode: "merge", favourites: [...] }  unions this browser's list with
//          the account's, skipping anything deleted elsewhere. Runs on load and
//          right after a link.
//        { ops: [{ op: "add" | "remove", name, lat, lon }] }  applies what the
//          person just did. A removal leaves a tombstone, so another device
//          holding a stale copy cannot push the place back.
//
// A browser that is not linked gets { linked: false } and keeps using its own
// storage, so the site works exactly as before for anyone who never links.

import {
  applyOps, fail, linkFor, listFavourites, mergeFavourites, readBody, syncConfigured
} from '../lib/portal.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!syncConfigured) {
    return fail(res, 503, 'Syncing is not configured on this deployment.');
  }

  try {
    if (req.method === 'GET') {
      const link = await linkFor(req.headers['x-portal-id']);
      if (!link) return res.status(200).json({ linked: false, favourites: [] });
      return res.status(200).json({
        linked: true,
        favourites: await listFavourites(link.telegram_id)
      });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const link = await linkFor(body.portal_id);
      if (!link) return res.status(200).json({ linked: false, favourites: [] });

      const favourites = body.mode === 'merge'
        ? await mergeFavourites(link.telegram_id, body.favourites)
        : await applyOps(link.telegram_id, body.ops);

      return res.status(200).json({ linked: true, favourites });
    }

    res.setHeader('Allow', 'GET, POST');
    return fail(res, 405, 'Method not allowed.');
  } catch (err) {
    console.error('favourites handler failed', err);
    return fail(res, 502, 'The sync service is not answering. Please try again shortly.');
  }
}
