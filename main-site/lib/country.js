// Which country a point is in, for picking a national weather service and the
// air quality range. Moved out of api/air.js so /api/forecast can ask too.

import COUNTRIES from './countries.js';
import { inRings, inSingapore } from './singapore.js';

export { COUNTRIES };

// About 80 km. A coastal city outside every simplified outline still belongs to
// the country with a sample point this close.
const NEAREST_SAMPLE_DEG = 0.75;

// The country named by the place's label when there is one. Otherwise,
// whichever outline holds the point, and failing that, whichever country has a
// sample point close by.
export function countryFor(code, lat, lon) {
  const named = /^[A-Z]{2}$/.test(code || '') && COUNTRIES.find(c => c.code === code);
  if (named) return named;

  const holder = COUNTRIES.find(({ bbox: [w, s, e, n], polygons }) =>
    lon >= w && lon <= e && lat >= s && lat <= n && inRings(polygons.flat(), lat, lon));
  if (holder) return holder;

  let nearest = null;
  let best = NEAREST_SAMPLE_DEG ** 2;
  for (const country of COUNTRIES) {
    for (const [slat, slon] of country.samples) {
      const d = (slat - lat) ** 2 + (slon - lon) ** 2;
      if (d < best) { best = d; nearest = country; }
    }
  }
  return nearest;
}

/** The two letter code, with Singapore decided by its own finer outline. */
export function countryCode(code, lat, lon) {
  if (inSingapore(lat, lon)) return 'SG';
  return countryFor(code, lat, lon)?.code ?? null;
}
