// Lightning alerts: when NEA detects lightning within a chosen distance of a
// saved place in Singapore, tell whoever saved it. Called by the collect cron
// (api/cron/collect.js) with each new lightning record, about every two minutes.
//
// Two ways to hear, both opt in:
// - Web push, to a browser that turned alerts on. Its places and distance live
//   with its subscription in Upstash (lib/kv.js), sent by /api/push/devices.
// - Telegram, for an account linked to the bot that turned it on in the alerts
//   panel. Its places are the synced favourites, and the message goes through the
//   notice queue the bot already polls, so the bot needs no new endpoint.
//
// A place that was warned about stays quiet for half an hour, NEA's advice for how
// long to wait after the last flash, so a storm overhead is one message and not
// one every two minutes.
//
// Only places inside Singapore count: NEA's lightning detection is the only
// source, and it does not reach far beyond the island.

import webpush from 'web-push';
import { km } from './datagov.js';
import { devices, storeConfigured, takeLock } from './kv.js';
import { T, placeKey, rest, syncConfigured } from './portal.js';
import { inSingapore } from './singapore.js';

export const RADII_KM = [5, 10, 20];
export const DEFAULT_RADIUS_KM = 10;
const QUIET_SECONDS = 30 * 60;

// A warning that arrives late is worse than none: the storm has moved on.
const PUSH_TTL = 15 * 60;
const TEST_TTL = 5 * 60;
const SEND_BATCH = 50;

export const pushConfigured = () => {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  return storeConfigured() && Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
};

export const eligible = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && inSingapore(p.lat, p.lon);

function sgTime(iso) {
  return new Date(iso)
    .toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(/\s/g, '')
    .toLowerCase();
}

// The closest strike to a place, as { km, strike }, or null with none.
function closest(place, strikes) {
  let best = null;
  for (const s of strikes) {
    const d = km(place.lat, place.lon, s.lat, s.lon);
    if (!best || d < best.km) best = { km: d, strike: s };
  }
  return best;
}

const kmText = (d) => (d < 1 ? 'under 1 km' : `${Math.round(d)} km`);

// The places within reach, nearest first, leaving out any still in their quiet
// half hour. Taking the lock is what starts that half hour, so only call this
// when a message will actually go.
async function placesHit(scope, places, radiusKm, strikes) {
  const hits = [];
  for (const place of places.filter(eligible)) {
    const near = closest(place, strikes);
    if (!near || near.km > radiusKm) continue;
    if (!(await takeLock(`warn:${scope}:${placeKey(place.lat, place.lon)}`, QUIET_SECONDS))) continue;
    hits.push({ ...place, ...near });
  }
  return hits.sort((a, b) => a.km - b.km);
}

function message(hits) {
  const [first, ...rest] = hits;
  const kind = first.strike.type === 'ground' ? 'Cloud to ground lightning' : 'Lightning';
  const also = rest.length ? ` Also near ${rest.map((h) => `${h.name} (${kmText(h.km)})`).join(', ')}.` : '';
  return {
    title: `Lightning ${kmText(first.km)} from ${first.name}`,
    body: `${kind} at ${sgTime(first.strike.t)}. Head indoors, and wait 30 minutes after the last flash before going back out.${also}`
  };
}

// ---------- web push ----------

function useVapid() {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function send(id, device, payload, options = { TTL: PUSH_TTL, urgency: 'high' }) {
  try {
    await webpush.sendNotification(device.subscription, payload, options);
    return 'sent';
  } catch (err) {
    // 404 and 410 mean the subscription is gone for good: permission revoked,
    // app uninstalled, or site data cleared.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await devices.delete(id).catch(() => {});
      return 'dropped';
    }
    console.error(`push to ${id} failed:`, err.statusCode ?? '', err.body ?? err.message);
    return 'failed';
  }
}

async function pushAll(strikes) {
  if (!pushConfigured()) return 'web push is not set up';
  useVapid();
  const sends = [];
  for (const [id, device] of await devices.all()) {
    if (!device?.places?.length) continue;
    const hits = await placesHit(`push:${id}`, device.places, device.radiusKm, strikes);
    if (hits.length) sends.push([id, device, JSON.stringify({ type: 'lightning-alert', ...message(hits), url: '/#map' })]);
  }
  let sent = 0;
  let dropped = 0;
  for (let i = 0; i < sends.length; i += SEND_BATCH) {
    const results = await Promise.all(sends.slice(i, i + SEND_BATCH).map(([id, d, p]) => send(id, d, p)));
    sent += results.filter((r) => r === 'sent').length;
    dropped += results.filter((r) => r === 'dropped').length;
  }
  return { sent, dropped };
}

/** One push through the same keys, payload and service worker handler as a real alert. */
export async function pushTest(id, device) {
  useVapid();
  const places = (device.places || []).filter(eligible);
  const payload = JSON.stringify({
    type: 'lightning-alert',
    title: 'Test alert from UwU Weather',
    body: places.length
      ? `Alerts work on this device. You'll hear when lightning is within ${device.radiusKm} km of ${places.map((p) => p.name).join(', ')}.`
      : 'Alerts work on this device. Save a place in Singapore to start hearing about lightning near it.',
    url: '/#map'
  });
  return send(id, device, payload, { TTL: TEST_TTL, urgency: 'high' });
}

// ---------- Telegram ----------

async function telegramAll(strikes) {
  if (!syncConfigured || !storeConfigured()) return 'Telegram alerts are not set up';
  const subs = await rest('GET', T.lightning, { params: { enabled: 'eq.true', select: 'telegram_id,radius_km' } });
  if (!subs.length) return { queued: 0 };

  const ids = subs.map((s) => s.telegram_id).join(',');
  const favourites = await rest('GET', T.favourites, {
    params: { telegram_id: `in.(${ids})`, deleted_at: 'is.null', select: 'telegram_id,name,lat,lon' }
  });

  const notices = [];
  for (const sub of subs) {
    const places = favourites
      .filter((f) => String(f.telegram_id) === String(sub.telegram_id))
      .map((f) => ({ name: f.name, lat: Number(f.lat), lon: Number(f.lon) }));
    const hits = await placesHit(`tg:${sub.telegram_id}`, places, sub.radius_km, strikes);
    if (!hits.length) continue;
    const { title, body } = message(hits);
    notices.push({
      telegram_id: sub.telegram_id,
      kind: 'lightning',
      data: {
        title,
        text: body,
        at: hits[0].strike.t,
        places: hits.map((h) => ({ name: h.name, km: Math.round(h.km * 10) / 10 }))
      }
    });
  }
  if (notices.length) await rest('POST', T.notices, { body: notices, prefer: 'return=minimal' });
  return { queued: notices.length };
}

/** Warn everyone with a place near any of these strikes. */
export async function notifyLightning(strikes) {
  if (!strikes.length) return { strikes: 0 };
  const [push, telegram] = await Promise.allSettled([pushAll(strikes), telegramAll(strikes)]);
  const out = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
  if (push.status === 'rejected') console.error('lightning push failed:', push.reason);
  if (telegram.status === 'rejected') console.error('lightning telegram failed:', telegram.reason);
  return { strikes: strikes.length, push: out(push), telegram: out(telegram) };
}
