// Shared helpers for the Telegram link and the synced favourites.
//
// A "portal id" is a random uuid the browser keeps in its own storage. It is
// the only thing that identifies a device, so it is a bearer secret: it travels
// in request bodies over https and is never put in a URL or a log line.
//
// Nothing here runs in the browser. SUPABASE_SERVICE_KEY bypasses row level
// security, so these helpers only ever execute inside a serverless function,
// and vercel.json rewrites /lib/* to the 404 page so this file is not
// downloadable from the site itself.

import { createHash } from 'node:crypto';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

export const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'uwuweatherapp_bot';
export const MAX_FAVOURITES = 24;
export const CODE_TTL_MINUTES = 10;

export const T = {
  links: 'uwu_weather_links',
  tokens: 'uwu_weather_link_tokens',
  codes: 'uwu_weather_link_codes',
  backupCodes: 'uwu_weather_backup_codes',
  backupRequests: 'uwu_weather_backup_requests',
  notices: 'uwu_weather_notices',
  favourites: 'uwu_weather_favourites'
};

export const syncConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isPortalId = (value) => typeof value === 'string' && UUID.test(value);

export const nowIso = () => new Date().toISOString();
export const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

// Four decimals, about eleven metres. The bot rounds identically, so both sides
// agree on when two saved places are the same place.
export const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4;
export const placeKey = (lat, lon) => `${round4(lat).toFixed(4)},${round4(lon).toFixed(4)}`;

export async function rest(method, table, { params = {}, body, prefer } = {}) {
  if (!syncConfigured) throw new Error('Supabase is not configured');

  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Supabase ${method} ${table} failed: ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  const text = await res.text();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function selectOne(table, params) {
  const rows = await rest('GET', table, { params: { ...params, limit: '1' } });
  return rows[0] || null;
}

export const isLive = (row) => !row?.expires_at || new Date(row.expires_at).getTime() > Date.now();

/** The Telegram account a browser belongs to, or null when it is not linked. */
export async function linkFor(portalId) {
  if (!isPortalId(portalId)) return null;
  return selectOne(T.links, { portal_id: `eq.${portalId}`, select: '*' });
}

export function randomCode() {
  // crypto.getRandomValues avoids the modulo bias a plain Math.random has.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

export function randomToken(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- backup codes ----------------------------------------------------------
//
// Created here, shown once in the browser that asked, and only after the
// Telegram account has approved the request. This side never stores a code,
// only its SHA-256.

// No I, L, O, U or 0 and 1, so nothing is misread off a piece of paper.
const BACKUP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const BACKUP_GROUPS = 2;
const BACKUP_GROUP_SIZE = 4;

export const BACKUP_CODE_COUNT = 8;
export const BACKUP_REQUEST_TTL_MINUTES = 10;

export const normaliseBackupCode = (value) =>
  String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const hashBackupCode = (code) =>
  createHash('sha256').update(normaliseBackupCode(code)).digest('hex');

function randomLetters(count) {
  const out = [];
  while (out.length < count) {
    const buf = new Uint8Array(count * 2);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      // 240 is the largest multiple of 30 under 256. Discarding the rest keeps
      // every letter equally likely instead of favouring the first sixteen.
      if (byte >= 240) continue;
      out.push(BACKUP_ALPHABET[byte % BACKUP_ALPHABET.length]);
      if (out.length === count) break;
    }
  }
  return out.join('');
}

export function newBackupCode() {
  const raw = randomLetters(BACKUP_GROUPS * BACKUP_GROUP_SIZE);
  return raw.match(new RegExp(`.{1,${BACKUP_GROUP_SIZE}}`, 'g')).join('-');
}

export async function countBackupCodes(telegramId) {
  const rows = await rest('GET', T.backupCodes, {
    params: { telegram_id: `eq.${telegramId}`, used_at: 'is.null', select: 'id' }
  });
  return rows.length;
}

/**
 * Mint a set and retire whatever was unused before it.
 *
 * The new batch is written before the old one is retired, never the other way
 * around: if anything fails in between, the codes already written down keep
 * working, which is the only safe direction for this to fail in.
 */
export async function generateBackupCodes(telegramId) {
  const batch = crypto.randomUUID();
  const codes = [];
  const rows = [];
  while (codes.length < BACKUP_CODE_COUNT) {
    const code = newBackupCode();
    if (codes.includes(code)) continue;
    codes.push(code);
    rows.push({ telegram_id: telegramId, code_hash: hashBackupCode(code), batch });
  }

  await rest('POST', T.backupCodes, { prefer: 'return=minimal', body: rows });
  await rest('DELETE', T.backupCodes, {
    params: {
      telegram_id: `eq.${telegramId}`,
      used_at: 'is.null',
      batch: `neq.${batch}`
    },
    prefer: 'return=minimal'
  });

  return codes;
}

// --- rate limiting ---------------------------------------------------------

/** The caller's address, as far as the proxy in front of us will say. */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

/**
 * Count one attempt against a bucket and say how many are in the window.
 *
 * This lives in Postgres rather than in a module variable because serverless
 * instances are recycled constantly, and because the browser picks its own
 * portal id: a counter keyed on anything the caller controls is a counter the
 * caller can reset. Fails open, so a Supabase hiccup does not lock anyone out.
 */
export async function bumpRate(bucket, windowSeconds) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/uwu_weather_bump_rate`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds })
    });
    if (!res.ok) return 0;
    return Number(await res.json()) || 0;
  } catch (err) {
    console.error('rate limit check failed', err);
    return 0;
  }
}

// --- favourites ------------------------------------------------------------

/** Validate one place from the browser, or null when it is not one. */
export function cleanPlace(input) {
  const lat = Number(input?.lat);
  const lon = Number(input?.lon);
  const name = String(input?.name ?? '').trim().slice(0, 120);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name, lat: round4(lat), lon: round4(lon) };
}

/** Trim whatever the browser sent down to storable places. */
export function cleanFavourites(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const place = cleanPlace(item);
    if (!place) continue;
    const key = placeKey(place.lat, place.lon);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
    if (out.length >= MAX_FAVOURITES) break;
  }
  return out;
}

/** Every row for an account, tombstones included. */
async function allRows(telegramId) {
  return rest('GET', T.favourites, {
    params: {
      telegram_id: `eq.${telegramId}`,
      select: 'name,lat,lon,created_at,deleted_at',
      order: 'created_at.asc'
    }
  });
}

const toPlace = (row) => ({ name: row.name, lat: Number(row.lat), lon: Number(row.lon) });

export async function listFavourites(telegramId) {
  const rows = await rest('GET', T.favourites, {
    params: {
      telegram_id: `eq.${telegramId}`,
      deleted_at: 'is.null',
      select: 'name,lat,lon,created_at',
      order: 'created_at.asc'
    }
  });
  return rows.map(toPlace);
}

async function insertPlaces(telegramId, places) {
  if (!places.length) return;
  await rest('POST', T.favourites, {
    params: { on_conflict: 'telegram_id,lat,lon' },
    prefer: 'return=minimal,resolution=merge-duplicates',
    body: places.map((p) => ({
      telegram_id: telegramId,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      deleted_at: null // saving a place again brings it back from a tombstone
    }))
  });
}

/**
 * Union the browser's places with the synced ones, minus anything deleted.
 *
 * This runs on load and right after linking. Without the tombstone check a
 * device holding a stale copy would quietly undo a deletion made elsewhere,
 * which is the one way a merge can lose an intention rather than a place.
 */
export async function mergeFavourites(telegramId, incoming) {
  const rows = await allRows(telegramId);
  const buried = new Set(rows.filter((r) => r.deleted_at).map((r) => placeKey(r.lat, r.lon)));
  const byKey = new Map();
  for (const row of rows) {
    if (!row.deleted_at) byKey.set(placeKey(row.lat, row.lon), toPlace(row));
  }

  const fresh = [];
  for (const place of cleanFavourites(incoming)) {
    const key = placeKey(place.lat, place.lon);
    if (buried.has(key) || byKey.has(key)) continue;
    if (byKey.size >= MAX_FAVOURITES) break;
    byKey.set(key, place);
    fresh.push(place);
  }

  await insertPlaces(telegramId, fresh);
  return [...byKey.values()];
}

/**
 * Apply what the browser actually did, rather than the list it ended up with.
 *
 * Sending the whole list would make every sync a claim about places the browser
 * may never have heard of. Sending the two or three changes keeps one device's
 * stale view from speaking for the account.
 */
export async function applyOps(telegramId, ops) {
  if (!Array.isArray(ops) || !ops.length) return listFavourites(telegramId);

  const adds = [];
  const removes = [];
  for (const op of ops.slice(0, 50)) {
    const place = cleanPlace(op);
    if (!place) continue;
    (op?.op === 'remove' ? removes : adds).push(place);
  }

  // Removals first, so a place removed and saved again in one batch survives.
  for (const place of removes) {
    await rest('PATCH', T.favourites, {
      params: {
        telegram_id: `eq.${telegramId}`,
        lat: `eq.${place.lat}`,
        lon: `eq.${place.lon}`,
        deleted_at: 'is.null'
      },
      prefer: 'return=minimal',
      body: { deleted_at: nowIso() }
    });
  }

  if (adds.length) {
    const live = await listFavourites(telegramId);
    const known = new Set(live.map((p) => placeKey(p.lat, p.lon)));
    const room = Math.max(0, MAX_FAVOURITES - live.length);
    const wanted = [];
    for (const place of adds) {
      const key = placeKey(place.lat, place.lon);
      if (known.has(key)) {
        wanted.push(place); // a rename of somewhere already saved
        continue;
      }
      if (wanted.filter((p) => !known.has(placeKey(p.lat, p.lon))).length >= room) break;
      wanted.push(place);
    }
    await insertPlaces(telegramId, wanted);
  }

  return listFavourites(telegramId);
}

/** Record the link itself. Safe to call again for a browser already linked. */
export async function saveLink({ portalId, telegramId, username, label }) {
  await rest('POST', T.links, {
    params: { on_conflict: 'portal_id' },
    prefer: 'return=minimal,resolution=merge-duplicates',
    body: {
      portal_id: portalId,
      telegram_id: telegramId,
      telegram_username: username ? String(username).toLowerCase() : null,
      label: label || null,
      updated_at: nowIso(),
      last_seen_at: nowIso()
    }
  });
}

export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

export function fail(res, status, message) {
  res.status(status).json({ error: message });
}

// A first line of defence only, in front of the counter that actually holds.
// Serverless instances are short lived, so this catches a burst from one
// instance and nothing more.
const attempts = new Map();

export function throttled(key, limit = 6, windowMs = 60_000) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}
