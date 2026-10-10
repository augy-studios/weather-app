// Run by Vercel Cron every ten minutes (vercel.json). Takes in the European
// weather warnings MeteoAlarm's members sent since the last run, through
// MeteoGate, and keeps those in force in Blob, one file per country, for
// lib/place.js to match against each place (lib/sources/meteogate.js).
//
// The first run, or one after a long gap, goes back two days, which can take
// more than one run; each picks up where the last one stopped.

import { blobConfigured } from '../../lib/blob.js';
import { ingestWarnings } from '../../lib/sources/meteogate.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!blobConfigured()) {
    return res.status(200).json({ skipped: 'needs Blob to keep the warnings' });
  }
  try {
    return res.status(200).json(await ingestWarnings({ budgetMs: 200 * 1000 }));
  } catch (err) {
    console.warn('warnings cron failed:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
