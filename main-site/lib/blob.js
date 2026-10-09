// Vercel Blob, for what the crons keep between runs that is too big or too
// frequent for Upstash: NEA's radar frames, NEA's bundle, and each recently
// viewed place's weather. Upstash keeps only the small indexes.
//
// Reads go to the store's public URL with plain fetch, which Blob's CDN answers
// without counting an API operation; only writes and deletes use the SDK. The
// store's id is the fourth part of BLOB_READ_WRITE_TOKEN, which is how the SDK
// builds the same URL.
//
// Without BLOB_READ_WRITE_TOKEN everything here is a no-op that reads nothing,
// and every route falls back to asking upstream itself.

import { del, put } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const STORE_ID = TOKEN?.split('_')[3] || '';
const BASE = STORE_ID ? `https://${STORE_ID}.public.blob.vercel-storage.com` : '';

// Everything this site writes sits under one folder, so a shared store stays tidy.
const ROOT = 'uwuweather';

export const blobConfigured = () => Boolean(TOKEN && BASE);

export const blobUrl = (path) => `${BASE}/${ROOT}/${path}`;

async function read(path, timeout = 4000) {
  if (!blobConfigured()) return null;
  const res = await fetch(blobUrl(path), { signal: AbortSignal.timeout(timeout) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`blob ${path} answered ${res.status}`);
  return res;
}

/** The JSON at a path, or null when there is none (or no store). */
export async function getJSON(path) {
  const res = await read(path).catch((err) => {
    console.warn('blob read failed:', err.message);
    return null;
  });
  return res ? res.json().catch(() => null) : null;
}

/** The bytes at a path, or null. */
export async function getBytes(path) {
  const res = await read(path, 6000).catch(() => null);
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}

// `maxAge` is how long Blob's CDN may hold the copy. A path written over and
// over (a place's weather) wants the floor of a minute; a radar frame, which
// never changes, wants a year.
async function write(path, body, contentType, maxAge) {
  if (!blobConfigured()) return null;
  return put(`${ROOT}/${path}`, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge: maxAge
  });
}

export const putJSON = (path, value, maxAge = 60) =>
  write(path, JSON.stringify(value), 'application/json', maxAge);

export const putBytes = (path, bytes, contentType, maxAge = 31536000) =>
  write(path, bytes, contentType, maxAge);

/** Delete paths, quietly: a frame that outlived its index costs a few KB, nothing more. */
export async function remove(paths) {
  if (!blobConfigured() || !paths.length) return;
  await del(paths.map(blobUrl)).catch((err) => console.warn('blob delete failed:', err.message));
}
