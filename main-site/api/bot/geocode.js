// The Telegram bot's place search: Open-Meteo's geocoder, as /api/geocode
// passes it on, behind the bot's token.
//
//   GET /api/bot/geocode?name=&count=&countryCode=XX
//   Authorization: Bearer <BOT_API_TOKEN>

import { botAuthorized } from '../../lib/bot-auth.js';

export default async function handler(req, res) {
  if (!botAuthorized(req, res)) return;
  const { name, count, countryCode } = req.query;
  if (!name) {
    res.status(400).json({ error: 'Missing required "name" parameter' });
    return;
  }
  const params = new URLSearchParams({ name, count: count || '8', language: 'en', format: 'json' });
  if (/^[A-Z]{2}$/i.test(countryCode || '')) params.set('countryCode', countryCode);
  try {
    const upstream = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(8000) });
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(await upstream.text());
  } catch (err) {
    console.warn('bot geocode failed:', err.message);
    res.status(502).json({ error: 'The place search did not answer' });
  }
}
