// The Telegram bot's air quality: /api/air behind the bot's token.
//
//   GET /api/bot/air?latitude=&longitude=&country=XX
//   Authorization: Bearer <BOT_API_TOKEN>

import { botAuthorized } from '../../lib/bot-auth.js';
import { airFor } from '../../lib/air.js';

export default async function handler(req, res) {
  if (!botAuthorized(req, res)) return;
  const lat = parseFloat(req.query.latitude);
  const lon = parseFloat(req.query.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }
  try {
    const { body } = await airFor(lat, lon, req.query.country);
    res.status(200).json(body);
  } catch (err) {
    console.warn('bot air quality failed:', err.message);
    res.status(502).json({ error: 'No air quality reading for this place right now' });
  }
}
