// Checks what the page sends before it is stored, as sg-psi's api/_push/validate.js
// does. Anything that fails throws a ValidationError, which the route turns into
// a 400.

import { DEFAULT_RADIUS_KM, RADII_KM, eligible } from './lightning.js';
import { MAX_FAVOURITES, cleanPlace } from './portal.js';

// The server POSTs to whatever endpoint a subscription names, so only the
// browsers' own push services are accepted. Otherwise anyone could point it at an
// arbitrary URL.
const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera
  '.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari, and iOS home screen apps
  '.notify.windows.com' // Edge on Windows
];

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+=*$/;

export class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message);
}

export const isId = (value) => typeof value === 'string' && ID_RE.test(value);

export function parseRadius(value) {
  const n = Number(value ?? DEFAULT_RADIUS_KM);
  if (!RADII_KM.includes(n)) fail(`radiusKm must be one of ${RADII_KM.join(', ')}`);
  return n;
}

// Places outside the covered countries (LIGHTNING_COUNTRIES) are dropped rather
// than refused: the page sends its whole saved list, and only some of it can
// ever be warned about.
function parsePlaces(list) {
  if (!Array.isArray(list)) fail('places must be a list');
  return list.slice(0, MAX_FAVOURITES).map(cleanPlace).filter((p) => p && eligible(p));
}

/** { subscription, places, radiusKm } */
export function parseDevice(body) {
  if (!body || typeof body !== 'object') fail('body must be an object');
  return {
    subscription: parseSubscription(body.subscription),
    places: parsePlaces(body.places),
    radiusKm: parseRadius(body.radiusKm)
  };
}

function parseSubscription(sub) {
  if (!sub || typeof sub !== 'object') fail('subscription is required');

  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    fail('subscription.endpoint must be a URL');
  }
  if (url.protocol !== 'https:') fail('subscription.endpoint must be https');
  const host = url.hostname;
  const known = PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
  if (!known) fail('subscription.endpoint is not a known push service');

  const { p256dh, auth } = sub.keys ?? {};
  if (typeof p256dh !== 'string' || p256dh.length > 200 || !B64URL_RE.test(p256dh)) fail('bad subscription.keys.p256dh');
  if (typeof auth !== 'string' || auth.length > 100 || !B64URL_RE.test(auth)) fail('bad subscription.keys.auth');

  return { endpoint: url.href, keys: { p256dh, auth } };
}
