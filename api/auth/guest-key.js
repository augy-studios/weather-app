import crypto from 'node:crypto';
import { createSupabaseClient } from '../../lib/uwu-request-signing-server.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Same-origin requests can legitimately arrive with no Origin header — only
  // reject when one is present and not on the allowed list.
  const origin = req.headers.origin;
  if (origin) {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
  }

  const appId = (req.query.app || 'unknown').toString();
  const sessionToken = crypto.randomUUID();
  const signingKey = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const supabase = createSupabaseClient();
  const { error } = await supabase.from('uwu_signing_keys').insert({
    session_token: sessionToken,
    signing_key: signingKey,
    is_guest: true,
    app_id: appId,
    created_at: new Date().toISOString(),
    expires_at: expiresAt
  });

  if (error) {
    res.status(500).json({ error: 'Failed to issue guest key' });
    return;
  }

  res.status(200).json({ key_id: sessionToken, signing_key: signingKey });
}
