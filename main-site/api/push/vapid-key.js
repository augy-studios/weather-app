// The public half of the VAPID keys, which the page needs to subscribe to Web Push.

export default function handler(req, res) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) return res.status(503).json({ error: 'Lightning alerts are not set up: VAPID_PUBLIC_KEY is missing' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ publicKey });
}
