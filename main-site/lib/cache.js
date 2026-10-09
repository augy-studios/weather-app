// Caching upstream answers, and keeping the free tiers inside their limits.
//
// cached(): one answer per key, kept in this instance's memory and in Vercel
// Blob, so a cold instance or the next cron run starts from the last copy
// rather than from upstream. A copy past `fresh` is rebuilt; when the rebuild
// fails, a copy younger than `stale` is served instead and marked as such.
//
// allow(): a shared per-minute and per-day count for each keyed provider
// (OpenWeather, WeatherAPI, Xweather), in Upstash when it is set up so every
// instance draws on one budget. Asked only when a fallback is about to be
// called, so the count costs nothing while Open-Meteo and NEA answer.

import { getJSON, putJSON } from './blob.js';
import { redis, storeConfigured } from './kv.js';

const memory = new Map();
const inflight = new Map();
const MAX_MEMORY = 400;

const HOUR = 3600 * 1000;

function remember(key, entry) {
  memory.set(key, entry);
  if (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
}

/**
 * The answer for `key`, built by `build()` when there is no fresh copy.
 * Returns { data, savedAt, stale }.
 */
export async function cached(key, { fresh, stale = 24 * HOUR, blob = true }, build) {
  const now = Date.now();
  let kept = memory.get(key);
  if (kept && now - kept.savedAt < fresh) return { ...kept, stale: false };

  if (blob) {
    const stored = await getJSON(`cache/${key}.json`);
    if (stored?.savedAt && (!kept || stored.savedAt > kept.savedAt)) kept = stored;
    if (kept && now - kept.savedAt < fresh) {
      remember(key, kept);
      return { ...kept, stale: false };
    }
  }

  // Two requests for one place at once build it once.
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const entry = { savedAt: Date.now(), data: await build() };
      remember(key, entry);
      if (blob) await putJSON(`cache/${key}.json`, entry).catch((err) => console.warn('cache write failed:', err.message));
      return entry;
    })().finally(() => inflight.delete(key)));
  }
  try {
    return { ...(await inflight.get(key)), stale: false };
  } catch (err) {
    if (kept && now - kept.savedAt < stale) {
      console.warn(`cache ${key}: rebuild failed, serving a copy from ${new Date(kept.savedAt).toISOString()}:`, err.message);
      return { ...kept, stale: true };
    }
    throw err;
  }
}

/** Store a freshly built answer, for the crons, which build ahead of anyone asking. */
export async function store(key, data) {
  const entry = { savedAt: Date.now(), data };
  remember(key, entry);
  await putJSON(`cache/${key}.json`, entry);
  return entry;
}

/** The last copy, however old, or null. */
export async function peek(key) {
  return memory.get(key) || (await getJSON(`cache/${key}.json`));
}

// ---------- the free tiers' budgets ----------

// A little under each free plan's published limit, so a burst from several
// instances at once still lands inside it. Change these if a plan changes.
export const QUOTAS = {
  openweather: { minute: 50, day: 900 },
  weatherapi: { minute: 30, day: 3000 },
  xweather: { minute: 8, day: 500 }
};

const local = new Map();

async function bump(key, seconds) {
  if (storeConfigured()) {
    const n = Number(await redis('INCR', key));
    if (n === 1) await redis('EXPIRE', key, seconds);
    return n;
  }
  const hit = local.get(key);
  const live = hit && hit.until > Date.now();
  const n = (live ? hit.n : 0) + 1;
  local.set(key, { n, until: live ? hit.until : Date.now() + seconds * 1000 });
  return n;
}

/** True when one more call to `provider` fits its budget, counting it. */
export async function allow(provider, cost = 1) {
  const quota = QUOTAS[provider];
  if (!quota) return true;
  const minute = Math.floor(Date.now() / 60000);
  const day = new Date().toISOString().slice(0, 10);
  try {
    const perMinute = await bump(`uwuweather:quota:${provider}:m:${minute}`, 120);
    if (perMinute > quota.minute) return false;
    const perDay = await bump(`uwuweather:quota:${provider}:d:${day}`, 26 * 3600);
    return perDay + cost - 1 <= quota.day;
  } catch (err) {
    // A counter that can't be read is not a reason to go over: say no.
    console.warn('quota check failed:', err.message);
    return false;
  }
}
