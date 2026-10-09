// England's Environment Agency, on environment.data.gov.uk.
//
// - Hydrology: the nearest rain gauge's daily totals for the past week, for
//   the Forecast page. Hydrology is loaded once a day, so its newest day is
//   usually yesterday; it is history, not a live reading.
// - Flood monitoring: the same gauges every fifteen minutes, live, for the
//   map's scrubber (api/gauges.js).
//
// The gauges are England's only. Elsewhere in the UK the lookups find nothing
// and Open-Meteo carries on alone. Open Government Licence v3; the page credits it.

import { cached } from '../cache.js';
import { fetchJSON, num } from '../wx.js';

const HYDROLOGY = 'https://environment.data.gov.uk/hydrology';
const FLOOD = 'https://environment.data.gov.uk/flood-monitoring';
const DAY = 24 * 3600 * 1000;
const SEARCH_KM = 25;
// Gauges drawn on the map around a place, nearest first.
const MAP_GAUGES = 15;
const SLOT_MS = 15 * 60 * 1000;

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const byDistance = (lat, lon) => (a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon);

// ---------- Hydrology: the past week ----------

async function dailyGauge(lat, lon) {
  const key = `ea-hydro-${lat.toFixed(2)},${lon.toFixed(2)}`;
  const { data } = await cached(key, { fresh: 7 * DAY, stale: 60 * DAY }, async () => {
    const j = await fetchJSON(`${HYDROLOGY}/id/stations?observedProperty=rainfall&lat=${lat}&long=${lon}&dist=${SEARCH_KM}`, { label: 'Hydrology' });
    const gauges = (j.items || [])
      .filter((s) => [].concat(s.status || []).every((st) => st.label !== 'Closed'))
      .map((s) => ({
        name: s.label,
        lat: num(s.lat),
        lon: num(s.long),
        measure: [].concat(s.measures || []).find((m) => m.period === 86400)?.['@id']
      }))
      .filter((s) => s.measure && s.lat != null)
      .sort(byDistance(lat, lon));
    if (!gauges.length) throw new Error('no Hydrology rain gauge near here');
    return gauges.slice(0, 3);
  });
  return data;
}

export async function unitedKingdom(lat, lon) {
  const gauges = await dailyGauge(lat, lon);
  const since = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
  // The nearest gauge with readings in the last ten days.
  for (const g of gauges) {
    const j = await fetchJSON(`${g.measure.replace(/^http:/, 'https:')}/readings?mineq-date=${since}`, { label: 'Hydrology' }).catch(() => null);
    const days = (j?.items || [])
      .map((r) => ({ date: r.date, mm: num(r.value) }))
      .filter((r) => r.date && r.mm != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-7);
    if (!days.length) continue;
    return {
      source: 'environment-agency',
      name: 'the Environment Agency',
      history: {
        station: g.name,
        km: Math.round(distanceKm(lat, lon, g.lat, g.lon) * 10) / 10,
        days
      },
      alerts: []
    };
  }
  throw new Error('no Hydrology readings near here this week');
}

// ---------- Flood monitoring: live gauges for the map ----------

async function liveGauges(lat, lon) {
  const key = `ea-flood-${lat.toFixed(1)},${lon.toFixed(1)}`;
  const { data } = await cached(key, { fresh: DAY, stale: 30 * DAY }, async () => {
    const j = await fetchJSON(`${FLOOD}/id/stations?parameter=rainfall&lat=${lat}&long=${lon}&dist=${SEARCH_KM}`, { label: 'Flood monitoring' });
    return (j.items || [])
      .filter((s) => [].concat(s.measures || []).some((m) => m.period === 900))
      // Most are labelled only "Rainfall station"; their reference tells them apart.
      .map((s) => {
        const id = s.stationReference || s.notation;
        return { id, name: !s.label || s.label === 'Rainfall station' ? `Rain gauge ${id}` : s.label, lat: num(s.lat), lon: num(s.long) };
      })
      .filter((s) => s.id && s.lat != null)
      .sort(byDistance(lat, lon))
      .slice(0, MAP_GAUGES);
  });
  return data;
}

/**
 * The gauges round a point and three hours of their fifteen-minute totals:
 * { stations: {id: [name, lat, lon]}, slots: [{ t, rain: {id: mm} }], slotMinutes: 15 }.
 */
export async function ukGauges(lat, lon) {
  const gauges = await liveGauges(lat, lon);
  if (!gauges.length) return { stations: {}, slots: [], slotMinutes: 15 };
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const results = await Promise.allSettled(gauges.map((g) =>
    fetchJSON(`${FLOOD}/id/stations/${encodeURIComponent(g.id)}/readings?parameter=rainfall&since=${since}&_sorted`, { label: 'Flood monitoring' })));

  const slots = new Map();
  const stations = {};
  gauges.forEach((g, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled') return;
    stations[g.id] = [g.name, g.lat, g.lon];
    for (const reading of r.value.items || []) {
      const t = Math.floor(Date.parse(reading.dateTime) / SLOT_MS) * SLOT_MS;
      const mm = num(reading.value);
      if (!Number.isFinite(t) || mm == null) continue;
      if (!slots.has(t)) slots.set(t, {});
      slots.get(t)[g.id] = mm;
    }
  });
  return {
    stations,
    slots: [...slots].sort((a, b) => a[0] - b[0]).map(([t, rain]) => ({ t: new Date(t).toISOString(), rain })),
    slotMinutes: 15
  };
}

/**
 * ukGauges, kept per tenth of a degree for ten minutes, here and in Blob. The
 * map asks through /api/gauges; the places cron keeps it warm.
 */
export function gaugesFor(lat, lon, { fresh = 10 * 60 * 1000 } = {}) {
  const rlat = Number(lat.toFixed(1));
  const rlon = Number(lon.toFixed(1));
  return cached(`ea-gauges-${rlat},${rlon}`, { fresh, stale: 3 * 3600 * 1000 }, () => ukGauges(rlat, rlon));
}
