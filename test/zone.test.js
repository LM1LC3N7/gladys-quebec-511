import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { boundingBox, distanceKm, readGeometry, unionBox } from '../src/geo.js';
import { readLayer, readWork } from '../src/wfs.js';
import { matchConditions, matchWorks, summary, winterCount, workCounts } from '../src/zone.js';
import { formatTime } from '../src/i18n.js';
import { CAPTURED_AT, HOME, collection, segment, work } from './helpers/setup.js';

const zoneOf = (raw) => normalizeConfig(raw).zones[0];
const HOME_ZONE = zoneOf(HOME);
const works = () => readLayer('ms:chantiers_mtmdet', collection('works')).items;
const conditions = () => readLayer('ms:conditions_routieres', collection('conditions')).items;
const read = (f) =>
  readLayer('ms:chantiers_mtmdet', { type: 'FeatureCollection', features: f }).items;
const readSegs = (f) =>
  readLayer('ms:conditions_routieres', { type: 'FeatureCollection', features: f }).items;

test('the box holds the whole circle, even at the edge nearest the pole', () => {
  const zone = { latitude: 59, longitude: -129, radiusKm: 300 };
  const [xmin, ymin, xmax, ymax] = boundingBox(zone);
  for (let bearing = 0; bearing < 360; bearing += 5) {
    // A point at the radius, by the exact spherical formula.
    const R = 6371.0088;
    const d = zone.radiusKm / R;
    const b = (bearing * Math.PI) / 180;
    const lat1 = (zone.latitude * Math.PI) / 180;
    const lon1 = (zone.longitude * Math.PI) / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(b) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    const lat = (lat2 * 180) / Math.PI;
    const lon = (lon2 * 180) / Math.PI;
    assert.ok(lon >= xmin && lon <= xmax && lat >= ymin && lat <= ymax, `bearing ${bearing}`);
  }
});

test('distances: a point, and a line passing near the center (not only its ends)', () => {
  const center = { latitude: 49, longitude: -123 };
  const north = distanceKm(center, [[[-123, 50]]]);
  assert.ok(Math.abs(north - 111.195) < 0.1, `${north}`);
  // A line from 1° west to 1° east, 0.1° north: about 11.1 km, its ends ~74 km.
  const line = readGeometry({
    type: 'LineString',
    coordinates: [
      [-124, 49.1],
      [-122, 49.1],
    ],
  });
  // Two points 146 km apart: the segment between them, not only its ends
  // (a long straight segment bends a little on the plane: 0.5 km here).
  const near = distanceKm(center, line);
  assert.ok(Math.abs(near - 11.12) < 0.6, `${near}`);
  // Dense lines: exact to 10 m.
  const dense = Array.from({ length: 21 }, (_, i) => [-124 + i * 0.1, 49.1]);
  const exact = distanceKm(center, [dense]);
  assert.ok(Math.abs(exact - 11.1195) < 0.01, `${exact}`);
  // A point is exact (great circle), even 300 km away at 60° N.
  const far = distanceKm({ latitude: 60, longitude: -130 }, [[[-130, 60 + 300 / 111.19508]]]);
  assert.ok(Math.abs(far - 300) < 0.01, `${far}`);
  assert.deepEqual(
    readGeometry({ type: 'MultiLineString', coordinates: [[[-123, 49]], [[-122, 49]]] }),
    [[[-123, 49]], [[-122, 49]]],
  );
  assert.equal(readGeometry({ type: 'LineString', coordinates: [[-123, 'x']] }), null);
});

test('the union box holds every zone box', () => {
  const a = boundingBox({ latitude: 45.5, longitude: -73.5, radiusKm: 20 });
  const b = boundingBox({ latitude: 48.8, longitude: -64.5, radiusKm: 50 });
  assert.deepEqual(unionBox([a, b]), [a[0], a[1], b[2], b[3]]);
  assert.deepEqual(unionBox([a]), a);
});

test('the real answer around Montréal at the time of the capture', () => {
  const matches = matchWorks(HOME_ZONE, works(), CAPTURED_AT);
  assert.deepEqual(workCounts(matches), { works: 28, major: 11 });
  // Major first, then by distance.
  assert.deepEqual(
    matches.slice(0, 11).map((m) => m.work.major),
    Array(11).fill(true),
  );
  for (let i = 1; i < 11; i += 1) assert.ok(matches[i].distanceKm >= matches[i - 1].distanceKm);
  for (const m of matches) assert.ok(m.distanceKm <= 20);
  // 19 works of the capture start later: never counted before their start.
  const all = works();
  assert.equal(all.length, 57);
  assert.ok(matches.every((m) => m.work.start === null || m.work.start <= CAPTURED_AT));
  const segs = matchConditions(HOME_ZONE, conditions());
  assert.equal(segs.length, 39);
  assert.equal(winterCount(segs), 0, 'every segment of the capture is bare');
});

test('without a server time, no listed work is taken as over or not started', () => {
  assert.ok(matchWorks(HOME_ZONE, works(), null).length > 28);
});

test('routes: only the named ones; a work without a route number never matches a filter', () => {
  const list = read([work(1), work(2, { routeAutoroute: '40' }), work(3, { routeAutoroute: '' })]);
  assert.deepEqual(
    matchWorks(zoneOf({ ...HOME, zone1_roads: 'A-40' }), list, CAPTURED_AT).map((m) => m.work.id),
    ['2'],
  );
  assert.equal(matchWorks(HOME_ZONE, list, CAPTURED_AT).length, 3);
});

test('duplicated and far works are left out; the circle edge is exact to 10 m', () => {
  const far = work(3);
  far.geometry.coordinates = [[-72, 45.5]];
  const list = read([work(1), work(1), far]);
  assert.deepEqual(
    matchWorks(HOME_ZONE, list, CAPTURED_AT).map((m) => m.work.id),
    ['1'],
  );
  const at = (km) => {
    const w = work(4);
    w.geometry.coordinates = [[-73.5673, 45.5017 + km / 111.19508]];
    return matchWorks(HOME_ZONE, read([w]), CAPTURED_AT).length;
  };
  assert.equal(at(19.99), 1);
  assert.equal(at(20.01), 0);
});

test('the summary: in the language chosen, bounded, a text when empty (never a 0 measure)', () => {
  const matches = matchWorks(HOME_ZONE, works(), CAPTURED_AT);
  const segs = matchConditions(HOME_ZONE, conditions());
  const fr = summary(matches, segs, 'fr');
  assert.match(
    fr,
    /^28 chantiers en cours \(11 entraves majeures\) · Route 136 : Aménagement de la rue Saint-Jacques par la Ville de Montréal \(majeure\), 0,3 km · /,
  );
  assert.match(fr, / · \d+ de plus · Chaussées dégagées$/);
  const en = summary(matches, segs, 'en');
  assert.match(
    en,
    /^28 road works in effect \(11 major\) · Route 136: Redevelopment of Saint-Jacques Street by the City of Montreal \(major\), 0\.3 km/,
  );
  assert.ok([...fr].length <= 600 && [...en].length <= 600);
  assert.equal(
    summary([], [], 'fr'),
    'Aucuns travaux en cours · Aucun tronçon de conditions hivernales dans la zone',
  );
  assert.equal(summary([], null, 'en'), 'No road works in effect · Winter conditions not read');
  const one = matchWorks(
    HOME_ZONE,
    read([work(1, { entraveType: 'Mineure (semaine)' })]),
    CAPTURED_AT,
  );
  assert.equal(
    summary(one, [], 'fr'),
    '1 chantier en cours · Route 20 : Travaux test 1, 0,1 km · Aucun tronçon de conditions hivernales dans la zone',
  );
  // A work without a route number shows its place.
  const local = matchWorks(
    HOME_ZONE,
    read([work(2, { routeAutoroute: '', localisation: 'Rue Notre-Dame' })]),
    CAPTURED_AT,
  );
  assert.match(summary(local, [], 'en'), /· Rue Notre-Dame: Test works 2 \(major\), 0\.1 km ·/);
  // Long lists: both parts cut with "N more", the winter part always there.
  const many = matchWorks(
    HOME_ZONE,
    read(Array.from({ length: 200 }, (_, i) => work(i + 1))),
    CAPTURED_AT,
  );
  const snowy = matchConditions(
    HOME_ZONE,
    readSegs(Array.from({ length: 50 }, (_, i) => segment(i + 1))),
  );
  const long = summary(many, snowy, 'en');
  assert.ok([...long].length <= 600, `${long.length}`);
  assert.match(
    long,
    /^200 road works in effect \(200 major\) · .* · \d+ more · Winter conditions on 50 segments · .* · \d+ more$/,
  );
});

test('times are shown in Eastern time, across midnight UTC and the DST changes', () => {
  // 04:30 UTC on Nov 15 is 23:30 EST the day before.
  assert.equal(formatTime(Date.UTC(2026, 10, 15, 4, 30), 'en'), 'Nov 14, 23:30 ET');
  assert.equal(
    formatTime(Date.UTC(2026, 10, 15, 4, 30), 'fr'),
    "14 nov., 23 h 30 (heure de l'Est)",
  );
  // Summer: UTC-4.
  assert.equal(formatTime(Date.UTC(2026, 6, 1, 12, 0), 'en'), 'Jul 1, 08:00 ET');
  // March 8, 2026: 07:00 UTC is 03:00 EDT (02:00-03:00 skipped).
  assert.equal(formatTime(Date.UTC(2026, 2, 8, 7, 0), 'en'), 'Mar 8, 03:00 ET');
  assert.equal(formatTime(NaN, 'en'), '?');
});

test('a work read from the source keeps both titles and its dates', () => {
  const w = readWork(work(9, { descriptionAnglais: 'Paving\r\nBetween A and B' }));
  assert.equal(w.title, 'Travaux test 9');
  assert.equal(w.titleEn, 'Paving');
  assert.equal(w.start, Date.UTC(2026, 10, 15, 12, 0));
  assert.equal(w.end, Date.UTC(2027, 0, 1, 4, 59));
  assert.equal(w.major, true);
  assert.equal(w.route, 20);
});
