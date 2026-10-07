// Upstash Redis over its REST API with plain fetch, as in sg-psi. Holds what the
// lightning alerts and the map's timeline need between function runs: each
// device's push subscription and places, when each place was last warned, the
// last lightning record seen, a lock so two cron runs never overlap, a per-IP
// request count, and three hours of station snapshots and strikes.
//
// Connected from the Vercel Marketplace, Upstash sets KV_REST_API_URL and
// KV_REST_API_TOKEN; set up on Upstash directly, it's UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN. Either pair works.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Every key starts with this, so one store can serve several projects.
const KEY = 'uwuweather';
const DEVICES = `${KEY}:push:devices`;

export const storeConfigured = () => Boolean(REDIS_URL && TOKEN);

export async function redis(...command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command.map(String)),
    cache: 'no-store'
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) throw new Error(`redis ${command[0]} failed: ${data?.error ?? res.status}`);
  return data.result;
}

const parse = (value) => (value == null ? null : JSON.parse(value));

// Pairs out of HGETALL's flat [field, value, ...].
function pairs(flat) {
  const out = [];
  for (let i = 0; i < (flat ?? []).length; i += 2) out.push([flat[i], parse(flat[i + 1])]);
  return out;
}

// ---------- devices: { subscription, places, radiusKm, updatedAt } by device id ----------

export const devices = {
  async has(id) {
    return (await redis('HEXISTS', DEVICES, id)) === 1;
  },
  async get(id) {
    return parse(await redis('HGET', DEVICES, id));
  },
  async set(id, device) {
    await redis('HSET', DEVICES, id, JSON.stringify(device));
  },
  async delete(id) {
    await redis('HDEL', DEVICES, id);
  },
  async size() {
    return Number(await redis('HLEN', DEVICES)) || 0;
  },
  async all() {
    return pairs(await redis('HGETALL', DEVICES));
  }
};

// ---------- small named values ----------

export async function getState(name) {
  return parse(await redis('GET', `${KEY}:state:${name}`));
}

export async function setState(name, value) {
  if (value == null) await redis('DEL', `${KEY}:state:${name}`);
  else await redis('SET', `${KEY}:state:${name}`, JSON.stringify(value));
}

// ---------- once per window: true the first time, false until it lapses ----------

export async function takeLock(name, seconds) {
  return (await redis('SET', `${KEY}:lock:${name}`, '1', 'NX', 'EX', seconds)) === 'OK';
}

export async function releaseLock(name) {
  await redis('DEL', `${KEY}:lock:${name}`);
}

// ---------- requests per IP per minute ----------

export async function rateLimited(ip, limit) {
  const key = `${KEY}:rate:${ip}`;
  const n = Number(await redis('INCR', key));
  if (n === 1) await redis('EXPIRE', key, 60);
  return n > limit;
}

// ---------- the timeline: hashes keyed by an ISO time, trimmed to a window ----------

const series = (name) => `${KEY}:timeline:${name}`;

export const timeline = {
  async put(name, iso, value) {
    await redis('HSET', series(name), iso, JSON.stringify(value));
  },
  async has(name, iso) {
    return (await redis('HEXISTS', series(name), iso)) === 1;
  },
  async keys(name) {
    return (await redis('HKEYS', series(name))) ?? [];
  },
  /** Every entry, oldest first. */
  async all(name) {
    return pairs(await redis('HGETALL', series(name))).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  },
  /** Drop every entry older than `since`. */
  async trim(name, since) {
    const old = (await this.keys(name)).filter((iso) => !(Date.parse(iso) >= since));
    if (old.length) await redis('HDEL', series(name), ...old);
    return old.length;
  }
};
