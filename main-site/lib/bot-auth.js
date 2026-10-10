// The Telegram bot's key to /api/bot/*. The bot sends BOT_API_TOKEN as
// "Authorization: Bearer <token>"; the same value is set on the Vercel project
// and in the bot's .env. The routes the page uses stay public.

import { timingSafeEqual } from 'node:crypto';

/**
 * True when the request carries the bot's token. Otherwise answers it (503
 * when the site has no token set, 401 for a wrong one) and returns false.
 */
export function botAuthorized(req, res) {
  // Answers for one bot, never for the CDN to hand anyone else.
  res.setHeader('Cache-Control', 'private, no-store');
  const token = process.env.BOT_API_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'BOT_API_TOKEN is not set on the site' });
    return false;
  }
  const given = Buffer.from(String(req.headers.authorization || ''));
  const wanted = Buffer.from(`Bearer ${token}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
