// Where Singapore is, for anything that treats it differently: NEA's readings in
// place of Open-Meteo's, and lightning alerts, which only NEA can give.
// Kept apart from api/air.js so a function can ask without loading every
// country's outline.

// A coarse outline of Singapore as [lon, lat]. A box would take in Johor Bahru,
// which sits under a kilometre across the strait, so the north edge follows the
// water from Tuas round to Pulau Tekong.
export const SG_OUTLINE = [
  [103.59, 1.19], [104.07, 1.19], [104.07, 1.43], [103.99, 1.44], [103.90, 1.44],
  [103.85, 1.47], [103.80, 1.46], [103.75, 1.455], [103.70, 1.45], [103.64, 1.35],
  [103.59, 1.30]
];

// Even-odd over every ring given, which handles holes too.
export function inRings(rings, lat, lon) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

export const inSingapore = (lat, lon) => inRings([SG_OUTLINE], lat, lon);
