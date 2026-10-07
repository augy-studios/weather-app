// Lightning alerts on Telegram, for a browser linked to the bot.
//
// POST { portal_id, action: "get" }                          where it stands
// POST { portal_id, action: "set", enabled, radiusKm }        turn it on or off
//
// The places are the account's synced favourites, so turning this on from any
// linked browser covers every place saved on the bot too. The portal id travels
// in the body, never a URL, as with /api/favourites.

import { DEFAULT_RADIUS_KM, eligible } from '../lib/lightning.js';
import { T, fail, linkFor, listFavourites, nowIso, readBody, rest, selectOne, syncConfigured } from '../lib/portal.js';
import { ValidationError, parseRadius } from '../lib/push-validate.js';

async function standing(telegramId) {
  const [row, favourites] = await Promise.all([
    selectOne(T.lightning, { telegram_id: `eq.${telegramId}`, select: 'enabled,radius_km' }),
    listFavourites(telegramId)
  ]);
  return {
    linked: true,
    enabled: Boolean(row?.enabled),
    radiusKm: row?.radius_km ?? DEFAULT_RADIUS_KM,
    // How many of the account's places can be warned about, for the panel to say.
    places: favourites.filter(eligible).length
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!syncConfigured) return fail(res, 503, 'Syncing is not configured on this deployment.');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Method not allowed.');
  }

  try {
    const body = readBody(req);
    const link = await linkFor(body.portal_id);
    if (!link) return res.status(200).json({ linked: false });

    if (body.action === 'set') {
      await rest('POST', T.lightning, {
        params: { on_conflict: 'telegram_id' },
        body: {
          telegram_id: link.telegram_id,
          enabled: body.enabled === true,
          radius_km: parseRadius(body.radiusKm),
          updated_at: nowIso()
        },
        prefer: 'resolution=merge-duplicates,return=minimal'
      });
    }
    return res.status(200).json(await standing(link.telegram_id));
  } catch (err) {
    if (err instanceof ValidationError) return fail(res, 400, err.message);
    console.error('lightning handler failed', err);
    return fail(res, 502, 'The sync service is not answering. Please try again shortly.');
  }
}
