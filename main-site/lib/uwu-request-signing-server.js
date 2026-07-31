// Shared server-side request signing/verification for UwU PWAs.
import crypto from 'node:crypto';

function hmacHex(signingKeyHex, message) {
  return crypto.createHmac('sha256', Buffer.from(signingKeyHex, 'hex')).update(message).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Minimal PostgREST wrapper — no supabase-js dependency.
export function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const authHeaders = { apikey: key, Authorization: `Bearer ${key}` };

  return {
    from(table) {
      return {
        select(cols = '*') {
          return {
            eq(col, val) {
              return {
                async maybeSingle() {
                  const res = await fetch(
                    `${url}/rest/v1/${table}?select=${encodeURIComponent(cols)}&${col}=eq.${encodeURIComponent(val)}`,
                    { headers: authHeaders }
                  );
                  if (!res.ok) return { data: null, error: await res.text() };
                  const rows = await res.json();
                  return { data: rows[0] || null, error: null };
                }
              };
            }
          };
        },
        async insert(row) {
          const res = await fetch(`${url}/rest/v1/${table}`, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify(row)
          });
          return { error: res.ok ? null : await res.text() };
        }
      };
    }
  };
}

// Vercel parses an absent JSON body as {} — treat that the same as no body.
function getBodyString(req) {
  const body = req.body;
  if (body == null) return '';
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return str === '{}' ? '' : str;
}

export async function verifySignedRequest(req, supabase) {
  const token     = req.headers['x-request-token'];
  const ts        = req.headers['x-request-ts'];
  const keyId     = req.headers['x-key-id'];
  const authBearer = req.headers['authorization'];

  if (!token || !ts) return { valid: false, reason: 'missing_headers' };

  const sessionToken = authBearer?.startsWith('Bearer ') ? authBearer.slice(7) : keyId;
  if (!sessionToken) return { valid: false, reason: 'missing_key_id' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 30_000) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const { data: keyRow, error: keyErr } = await supabase
    .from('uwu_signing_keys')
    .select('signing_key,expires_at')
    .eq('session_token', sessionToken)
    .maybeSingle();

  if (keyErr || !keyRow) return { valid: false, reason: 'unknown_key' };
  if (new Date(keyRow.expires_at).getTime() < Date.now()) return { valid: false, reason: 'key_expired' };

  const bodyStr  = getBodyString(req);
  const bodyHash = bodyStr ? hmacHex(keyRow.signing_key, bodyStr) : 'empty';
  const expected = hmacHex(keyRow.signing_key, `${ts}:${req.method}:${req.url}:${bodyHash}`);

  if (!timingSafeEqualHex(expected, token)) return { valid: false, reason: 'bad_signature' };

  const { data: used } = await supabase
    .from('uwu_used_request_tokens')
    .select('token')
    .eq('token', token)
    .maybeSingle();
  if (used) return { valid: false, reason: 'replayed' };

  await supabase.from('uwu_used_request_tokens').insert({
    token, session_token: sessionToken, used_at: new Date().toISOString()
  });

  return { valid: true, reason: 'ok' };
}
