export default async function handler(req, res) {
  const { latitude, longitude } = req.query;

  if (!latitude || !longitude) {
    res.status(400).json({ error: 'Missing required "latitude"/"longitude" parameters' });
    return;
  }

  const params = new URLSearchParams(req.query);
  const upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  const body = await upstream.text();

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.status(upstream.status).setHeader('Content-Type', 'application/json').send(body);
}
