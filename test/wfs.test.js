// -----------------------------------------------------------------------------
// The strict reading of the WFS: local dates of Québec (DST included), the
// envelope of a layer, each feature, the bounded GET.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getJson,
  inEffect,
  layerUrl,
  readCondition,
  readHttpDate,
  readLayer,
  readLocalTime,
  readRetryAfter,
  readRoute,
  readString,
  readWork,
} from '../src/wfs.js';
import { collection, segment, work } from './helpers/setup.js';

const WORKS = 'ms:chantiers_mtmdet';
const CONDITIONS = 'ms:conditions_routieres';

test('local dates of Québec: winter UTC-5, summer UTC-4, both spellings', () => {
  assert.equal(readLocalTime('2026/11/15 07:42:35'), Date.UTC(2026, 10, 15, 12, 42, 35));
  assert.equal(readLocalTime('2026-11-15T04:07:47'), Date.UTC(2026, 10, 15, 9, 7, 47));
  assert.equal(readLocalTime('2026/07/01 08:00:00'), Date.UTC(2026, 6, 1, 12, 0));
  assert.equal(readLocalTime('2026-07-01T08:00'), Date.UTC(2026, 6, 1, 12, 0));
  // Around midnight: 23:30 local on Dec 31 is 04:30 UTC on Jan 1.
  assert.equal(readLocalTime('2026/12/31 23:30:00'), Date.UTC(2027, 0, 1, 4, 30));
  // March 8, 2026: 01:59 EST, 03:00 EDT; 02:30 does not exist (read as EST).
  assert.equal(readLocalTime('2026/03/08 01:59:00'), Date.UTC(2026, 2, 8, 6, 59));
  assert.equal(readLocalTime('2026/03/08 03:00:00'), Date.UTC(2026, 2, 8, 7, 0));
  assert.equal(readLocalTime('2026/03/08 02:30:00'), Date.UTC(2026, 2, 8, 7, 30));
  // November 1, 2026: 01:30 happens twice; the first (EDT) is taken; 02:30 is EST.
  assert.equal(readLocalTime('2026/11/01 01:30:00'), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(readLocalTime('2026/11/01 02:30:00'), Date.UTC(2026, 10, 1, 7, 30));
  for (const bad of [
    '',
    '2026/02/30 10:00:00',
    '2026/11/15 24:00:00',
    '2026-11-15T04:07:47Z',
    'demain',
    null,
    17,
  ]) {
    assert.equal(readLocalTime(bad), null, String(bad));
  }
});

test('in effect: start included, end excluded, unknown dates in effect', () => {
  const w = { start: 100, end: 200 };
  assert.equal(inEffect(w, 99), false);
  assert.equal(inEffect(w, 100), true);
  assert.equal(inEffect(w, 199), true);
  assert.equal(inEffect(w, 200), false);
  assert.equal(inEffect({ start: null, end: null }, 5), true);
  assert.equal(inEffect({ start: 300, end: 400 }, null), true);
});

test('the layer envelope: a FeatureCollection only; numberMatched must equal the list', () => {
  assert.equal(readLayer(WORKS, null), null);
  assert.equal(readLayer(WORKS, []), null);
  assert.equal(readLayer(WORKS, { features: [] }), null);
  assert.equal(readLayer(WORKS, { type: 'FeatureCollection', features: {} }), null);
  assert.equal(readLayer('ms:other', collection('works')), null);
  assert.deepEqual(
    readLayer(WORKS, { type: 'FeatureCollection', numberMatched: 3, features: [work(1)] }),
    {
      incomplete: true,
    },
  );
  assert.deepEqual(
    readLayer(WORKS, { type: 'FeatureCollection', numberMatched: '1', features: [work(1)] }),
    {
      incomplete: true,
    },
  );
  assert.deepEqual(
    readLayer(WORKS, { type: 'FeatureCollection', features: [] }),
    { incomplete: true },
    'numberMatched absent: never 0',
  );
  const ok = readLayer(WORKS, { type: 'FeatureCollection', numberMatched: 1, features: [work(1)] });
  assert.equal(ok.items.length, 1);
  assert.deepEqual(
    readLayer(WORKS, { type: 'FeatureCollection', features: Array(5001).fill(work(1)) }),
    {
      incomplete: true,
    },
  );
});

test('a work: id and place required, texts cleaned and bounded', () => {
  assert.equal(readWork(work('x y')), null, 'id with a space');
  const noGeo = work(1);
  noGeo.geometry = null;
  assert.equal(readWork(noGeo), null);
  const bad = work(1);
  bad.geometry.coordinates = [[-73.5, 'x']];
  assert.equal(readWork(bad), null);
  const w = readWork(
    work(2, {
      entrave: 'Fermeture\r\n\u0007 complète<br/>la nuit' + 'x'.repeat(1000),
      routeAutoroute: 'A-20',
      entraveType: 'Mineure (fin de semaine)',
    }),
  );
  assert.ok(w.impact.startsWith('Fermeture complète la nuit'));
  assert.equal([...w.impact].length, 500);
  assert.equal(w.route, null, 'only a plain number is a route');
  assert.equal(w.major, false);
});

test('a condition segment: known codes only; an unknown code is neither bare nor winter', () => {
  assert.equal(readCondition(segment(1, 'Ds')).winter, false);
  assert.equal(readCondition(segment(1, 'Dm')).winter, false);
  for (const code of ['PE', 'E', 'PCND', 'CND', 'PG', 'G']) {
    assert.equal(readCondition(segment(1, code)).winter, true, code);
  }
  assert.equal(readCondition(segment(1, 'ds')).winter, null);
  assert.equal(readCondition(segment(1, '')).winter, null);
  const s = readCondition(segment(7, 'G', { CodeVisibilite: 'Z', NumeroRoute: '117' }));
  assert.equal(s.visibility, null);
  assert.equal(s.route, 117);
  assert.equal(s.since, Date.UTC(2026, 10, 15, 11, 0));
  assert.equal(readCondition(segment(null)), null);
});

test('routes and texts', () => {
  assert.equal(readRoute('20'), 20);
  assert.equal(readRoute(' 138 '), 138);
  assert.equal(readRoute(40), 40);
  for (const bad of ['', '0', 'A-20', '20a', 1.5, -3, 10000, null])
    assert.equal(readRoute(bad), null);
  assert.equal(readString('a<br/><br/>b\n\tc'), 'a b c');
  assert.equal(readString(42), '');
});

test('the real captures read whole: no feature skipped', () => {
  for (const [layer, name] of [
    [WORKS, 'works'],
    [CONDITIONS, 'conditions'],
  ]) {
    const read = readLayer(layer, collection(name));
    assert.equal(read.skipped, 0, name);
    assert.ok(read.items.length > 30, name);
  }
});

test('the URL: WFS 2.0 GetFeature, geojson, EPSG:4326, URN box in lat/lon order', () => {
  const url = new URL(layerUrl(WORKS, [-73.8, 45.3, -73.3, 45.7]));
  assert.equal(url.searchParams.get('service'), 'WFS');
  assert.equal(url.searchParams.get('version'), '2.0.0');
  assert.equal(url.searchParams.get('request'), 'GetFeature');
  assert.equal(url.searchParams.get('typeNames'), WORKS);
  assert.equal(url.searchParams.get('bbox'), '45.3,-73.8,45.7,-73.3,urn:ogc:def:crs:EPSG::4326');
});

test('HTTP dates and Retry-After', () => {
  assert.equal(readHttpDate('Sun, 15 Nov 2026 12:42:35 GMT'), Date.UTC(2026, 10, 15, 12, 42, 35));
  assert.equal(readHttpDate('2026-11-15'), null);
  assert.equal(readRetryAfter('120', null), 120000);
  const at = Date.UTC(2026, 10, 15, 12, 0);
  assert.equal(readRetryAfter('Sun, 15 Nov 2026 12:10:00 GMT', at), 600000);
  assert.equal(readRetryAfter('soon', at), null);
});

const respond = (body, init) => async () => new Response(body, init);

test('the GET: statuses, type, declared and real size', async () => {
  const kind = async (fetchImpl) => (await getJson('https://x.test/', { fetchImpl })).kind;
  assert.equal(await kind(respond('{}', { status: 404 })), 'http');
  assert.equal(await kind(respond('{}', { status: 502 })), 'server');
  assert.equal(await kind(respond('{}', { status: 429 })), 'rate');
  assert.equal(await kind(respond('{}', { headers: { 'content-type': 'text/plain' } })), 'format');
  assert.equal(
    await kind(respond('{x', { headers: { 'content-type': 'application/geo+json' } })),
    'format',
  );
  assert.equal(
    await kind(
      respond('{}', {
        headers: { 'content-type': 'application/json', 'content-length': String(9e6) },
      }),
    ),
    'too_big',
  );
  assert.equal(
    await kind(async () => {
      throw new TypeError('fetch failed');
    }),
    'network',
  );
  const ok = await getJson('https://x.test/', {
    fetchImpl: respond('{"a":1}', {
      headers: { 'content-type': 'application/geo+json', date: 'Sun, 15 Nov 2026 12:42:35 GMT' },
    }),
  });
  assert.deepEqual(ok, {
    ok: true,
    json: { a: 1 },
    serverDate: Date.UTC(2026, 10, 15, 12, 42, 35),
  });
});
