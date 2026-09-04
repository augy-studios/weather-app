// Linking a browser to a Telegram account.
//
// Three ways in, all ending in the same link row, and all three started by the
// person themselves:
//
//   start          the browser asks for a token and opens t.me/<bot>?start=<token>
//   status         the browser polls that token until it is claimed or refused
//   redeem         the person types the six digits /code gave them
//   redeem-backup  Telegram is unreachable, so a single use backup code is used
//   whoami         does this browser already belong to an account
//   unlink         it should not any more
//
// Linking never moves favourites on its own. The browser calls /api/favourites
// with mode "merge" once it is linked, which keeps one merge path for every
// route.

import {
  BACKUP_CODE_COUNT, BACKUP_REQUEST_TTL_MINUTES, BOT_USERNAME, CODE_TTL_MINUTES, T,
  bumpRate, clientIp, countBackupCodes, fail, generateBackupCodes, hashBackupCode,
  inMinutes, isLive, isPortalId, linkFor, listFavourites, normaliseBackupCode, nowIso,
  randomToken, readBody, rest, saveLink, selectOne, syncConfigured, throttled
} from '../lib/portal.js';

// Ten minutes of guessing at a code that lives ten minutes. Well clear of any
// honest mistyping, and far too slow to sweep a six digit space.
const GUESS_WINDOW_SECONDS = 900;
const GUESS_LIMIT = 10;

const label = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : '') || null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!syncConfigured) {
    return fail(res, 503, 'Syncing is not configured on this deployment.');
  }

  const body = readBody(req);
  const action = String(req.query.action || body.action || '');

  try {
    if (req.method === 'GET') {
      if (action === 'status') return await tokenStatus(req, res);
      if (action === 'backup-status') return await backupStatus(req, res);
      return fail(res, 400, 'Unknown action.');
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return fail(res, 405, 'Method not allowed.');
    }

    switch (action) {
      case 'start': return await start(req, res, body);
      case 'redeem': return await redeem(req, res, body);
      case 'redeem-backup': return await redeemBackup(req, res, body);
      case 'backup-request': return await backupRequest(req, res, body);
      case 'backup-collect': return await backupCollect(req, res, body);
      case 'whoami': return await whoami(req, res, body);
      case 'unlink': return await unlink(req, res, body);
      default: return fail(res, 400, 'Unknown action.');
    }
  } catch (err) {
    console.error('link handler failed', err);
    return fail(res, 502, 'The sync service is not answering. Please try again shortly.');
  }
}

// --- deep link -------------------------------------------------------------

async function start(req, res, body) {
  if (!isPortalId(body.portal_id)) return fail(res, 400, 'A valid portal id is required.');
  if (throttled(`start:${body.portal_id}`, 10)) return fail(res, 429, 'Too many attempts.');

  const token = randomToken(24);
  await rest('POST', T.tokens, {
    prefer: 'return=minimal',
    body: {
      token,
      portal_id: body.portal_id,
      label: label(body.label),
      status: 'pending',
      expires_at: inMinutes(CODE_TTL_MINUTES)
    }
  });

  res.status(200).json({
    token,
    url: `https://t.me/${BOT_USERNAME}?start=${token}`,
    expires_in: CODE_TTL_MINUTES * 60
  });
}

async function tokenStatus(req, res) {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{16,128}$/i.test(token)) return fail(res, 400, 'A valid token is required.');

  const row = await selectOne(T.tokens, {
    token: `eq.${token}`,
    select: 'status,telegram_id,expires_at'
  });
  if (!row) return res.status(200).json({ status: 'unknown' });

  const status = row.status === 'pending' && !isLive(row) ? 'expired' : row.status;
  res.status(200).json({ status, linked: status === 'claimed' });
}

// --- pull code -------------------------------------------------------------

async function redeem(req, res, body) {
  if (!isPortalId(body.portal_id)) return fail(res, 400, 'A valid portal id is required.');
  if (throttled(`redeem:${body.portal_id}`)) {
    return fail(res, 429, 'Too many attempts. Wait a minute and try again.');
  }

  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6) return fail(res, 400, 'A six digit code is required.');

  const row = await selectOne(T.codes, { code: `eq.${code}`, select: '*' });
  if (!row || row.status !== 'pending' || !isLive(row)) {
    // Only failures are counted, so someone typing their own code correctly the
    // first time never meets this at all.
    if (await bumpRate(`redeem:${clientIp(req)}`, GUESS_WINDOW_SECONDS) > GUESS_LIMIT) {
      return fail(res, 429, 'Too many wrong codes from here. Try again in a few minutes.');
    }
    return fail(res, 400, 'That code is not valid any more. Send /code for a new one.');
  }

  await rest('PATCH', T.codes, {
    params: { code: `eq.${code}` },
    prefer: 'return=minimal',
    body: { status: 'claimed', portal_id: body.portal_id, claimed_at: nowIso() }
  });
  await saveLink({
    portalId: body.portal_id,
    telegramId: row.telegram_id,
    username: row.telegram_username,
    label: label(body.label)
  });

  res.status(200).json({ linked: true, telegram_username: row.telegram_username || null });
}

// --- backup codes ----------------------------------------------------------

async function redeemBackup(req, res, body) {
  if (!isPortalId(body.portal_id)) return fail(res, 400, 'A valid portal id is required.');
  if (throttled(`backup:${body.portal_id}`, 5)) {
    return fail(res, 429, 'Too many attempts. Wait a minute and try again.');
  }

  const code = normaliseBackupCode(body.code);
  if (code.length < 6 || code.length > 32) return fail(res, 400, 'That is not a backup code.');

  // Only the hash is stored, so the lookup is on the hash and a wrong code
  // simply finds nothing. Codes are high entropy, which is what lets a plain
  // SHA-256 stand in for a slow password hash here.
  const row = await selectOne(T.backupCodes, {
    code_hash: `eq.${hashBackupCode(code)}`,
    used_at: 'is.null',
    select: '*'
  });
  if (!row) {
    if (await bumpRate(`backup:${clientIp(req)}`, GUESS_WINDOW_SECONDS) > GUESS_LIMIT) {
      return fail(res, 429, 'Too many wrong codes from here. Try again in a few minutes.');
    }
    return fail(res, 400, 'That backup code is not valid, or it has already been used.');
  }

  await rest('PATCH', T.backupCodes, {
    params: { id: `eq.${row.id}` },
    prefer: 'return=minimal',
    body: { used_at: nowIso(), used_by: body.portal_id }
  });
  await saveLink({
    portalId: body.portal_id,
    telegramId: row.telegram_id,
    username: null,
    label: label(body.label)
  });

  // Tell the owner, through the bot, that one of their codes was spent. If the
  // person reading this is not the owner, that message is how the owner finds
  // out, and it carries the button that cuts the link again.
  const left = await rest('GET', T.backupCodes, {
    params: { telegram_id: `eq.${row.telegram_id}`, used_at: 'is.null', select: 'id' }
  });
  await rest('POST', T.notices, {
    prefer: 'return=minimal',
    body: {
      telegram_id: row.telegram_id,
      kind: 'backup_used',
      data: { label: label(body.label) || 'A browser', remaining: left.length }
    }
  });

  res.status(200).json({ linked: true, backup_codes_left: left.length });
}

// --- creating backup codes -------------------------------------------------
//
// Three steps, because neither half should be able to mint a way in alone:
// the browser asks, the Telegram account approves, and only then does the
// browser collect. The codes exist for the length of one response and are
// never stored in readable form on either side.

async function backupRequest(req, res, body) {
  const link = await linkFor(body.portal_id);
  if (!link) return fail(res, 400, 'This browser is not linked to a Telegram account.');
  if (throttled(`backuprq:${body.portal_id}`, 3)) {
    return fail(res, 429, 'Too many requests. Wait a minute and try again.');
  }
  // Counted against the account, not the browser, so a pile of fresh portal ids
  // cannot turn this into a way of pestering someone in Telegram.
  if (await bumpRate(`backuprq:${link.telegram_id}`, 3600) > 5) {
    return fail(res, 429, 'Too many requests for this account today. Try again later.');
  }

  // Only one may be live, so an abandoned prompt cannot be approved later.
  await rest('PATCH', T.backupRequests, {
    params: { telegram_id: `eq.${link.telegram_id}`, status: 'eq.pending' },
    prefer: 'return=minimal',
    body: { status: 'expired', resolved_at: nowIso() }
  });

  const [request] = await rest('POST', T.backupRequests, {
    body: {
      portal_id: body.portal_id,
      telegram_id: link.telegram_id,
      label: label(body.label),
      status: 'pending',
      expires_at: inMinutes(BACKUP_REQUEST_TTL_MINUTES)
    }
  });

  await rest('POST', T.notices, {
    prefer: 'return=minimal',
    body: {
      telegram_id: link.telegram_id,
      kind: 'backup_request',
      data: {
        request_id: request.id,
        label: label(body.label) || 'A browser',
        remaining: await countBackupCodes(link.telegram_id)
      }
    }
  });

  res.status(200).json({
    id: request.id,
    expires_in: BACKUP_REQUEST_TTL_MINUTES * 60,
    count: BACKUP_CODE_COUNT
  });
}

async function backupStatus(req, res) {
  const id = String(req.query.id || '');
  if (!isPortalId(id)) return fail(res, 400, 'A valid request id is required.');

  const row = await selectOne(T.backupRequests, { id: `eq.${id}`, select: '*' });
  // The id alone is not enough: the browser must also be the one that asked.
  if (!row || row.portal_id !== req.headers['x-portal-id']) {
    return res.status(200).json({ status: 'unknown' });
  }

  const status = row.status === 'pending' && !isLive(row) ? 'expired' : row.status;
  res.status(200).json({ status });
}

async function backupCollect(req, res, body) {
  if (!isPortalId(body.id)) return fail(res, 400, 'A valid request id is required.');
  if (!isPortalId(body.portal_id)) return fail(res, 400, 'A valid portal id is required.');

  const link = await linkFor(body.portal_id);
  if (!link) return fail(res, 400, 'This browser is not linked to a Telegram account.');

  // Claiming the row is the single use guarantee: the filter demands it still
  // be approved, still belong to this browser, and not yet have lapsed, so two
  // tabs racing to collect cannot both come away with a set.
  const claimed = await rest('PATCH', T.backupRequests, {
    params: {
      id: `eq.${body.id}`,
      portal_id: `eq.${body.portal_id}`,
      status: 'eq.approved',
      expires_at: `gt.${nowIso()}`
    },
    body: { status: 'collected', collected_at: nowIso() }
  });
  if (!claimed.length) {
    return fail(res, 409, 'That request is no longer ready to collect. Please ask again.');
  }

  res.status(200).json({ codes: await generateBackupCodes(link.telegram_id) });
}

// --- housekeeping ----------------------------------------------------------

async function whoami(req, res, body) {
  const link = await linkFor(body.portal_id);
  if (!link) return res.status(200).json({ linked: false });

  res.status(200).json({
    linked: true,
    telegram_username: link.telegram_username || null,
    linked_at: link.created_at,
    favourites: await listFavourites(link.telegram_id),
    backup_codes_left: await countBackupCodes(link.telegram_id)
  });
}

async function unlink(req, res, body) {
  if (!isPortalId(body.portal_id)) return fail(res, 400, 'A valid portal id is required.');
  await rest('DELETE', T.links, {
    params: { portal_id: `eq.${body.portal_id}` },
    prefer: 'return=minimal'
  });
  res.status(200).json({ linked: false });
}
