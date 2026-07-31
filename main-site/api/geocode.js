import { verifySignedRequest, createSupabaseClient } from '../lib/uwu-request-signing-server.js';

export default async function handler(req, res) {
  const { valid, reason } = await verifySignedRequest(req, createSupabaseClient());
  if (!valid) {
    res.status(401).json({ error: 'Invalid request signature', reason });
    return;
  }

  const { name, count, language, format, countryCode } = req.query;

  if (!name) {
    res.status(400).json({ error: 'Missing required "name" parameter' });
    return;
  }

  const params = new URLSearchParams({
    name,
    count: count || '8',
    language: language || 'en',
    format: format || 'json'
  });
  if (countryCode) params.set('countryCode', countryCode);

  const upstream = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  const body = await upstream.text();

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.status(upstream.status).setHeader('Content-Type', 'application/json').send(body);
}
