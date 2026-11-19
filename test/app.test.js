// -----------------------------------------------------------------------------
// The app on the virtual clock against a scripted MTMD WFS: pace, pauses,
// restart, status, publication per layer and the scene trigger.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_GAP, REQUEST_TIMEOUT } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import {
  CAPTURED_AT,
  F,
  HOME,
  HOUR,
  MINUTE,
  SECOND,
  THREE_ZONES,
  collection,
  createApi,
  html,
  json,
  layerOf,
  published,
  real,
  segment,
  setup,
  work,
} from './helpers/setup.js';

const INTERVAL = 15 * MINUTE;
const status = (fake) => fake.connectionStatus;

test('the first round reads both layers, 5 s apart, and publishes counts and summary', async () => {
  const { fake, begin, api, wait } = await setup();
  await begin();
  assert.equal(api.calls.length, 1);
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(
    api.calls.map((c) => layerOf(c.url)),
    ['works', 'conditions'],
  );
  assert.ok(api.calls[1].at - api.calls[0].at >= REQUEST_GAP);
  assert.deepEqual(published(fake, F(1, 'works')), [28]);
  assert.deepEqual(published(fake, F(1, 'major_works')), [11]);
  assert.deepEqual(published(fake, F(1, 'winter_segments')), [0]);
  const [text] = published(fake, F(1, 'summary'));
  assert.match(text, /^28 chantiers en cours \(11 entraves majeures\) · Route 136 : /);
  assert.match(text, / · Chaussées dégagées$/);
  // The summary goes as a text, never as a number.
  const summaryState = fake.states.find((s) => s.device_feature_external_id === F(1, 'summary'));
  assert.equal(summaryState.state, undefined);
  assert.equal(status(fake).connected, true);
  assert.match(
    status(fake).message.en,
    /^Home: 28 road work\(s\), 11 major, read Nov 15, 07:42 ET; 0 segment\(s\) in winter conditions\. Next read Nov 15, 07:57 ET\.$/,
  );
  assert.match(
    status(fake).message.fr,
    /^Home : 28 chantier\(s\), 11 entrave\(s\) majeure\(s\), lu 15 nov\., 07 h 42 \(heure de l'Est\) ; 0 tronçon\(s\)/,
  );
});

test('the request: geojson in EPSG:4326, box of every zone in lat/lon order, honest headers', async () => {
  const { begin, api, wait } = await setup({ config: THREE_ZONES });
  await begin();
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 2, 'two requests a round, whatever the number of zones');
  const url = new URL(api.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://ws.mapserver.transports.gouv.qc.ca/swtq');
  assert.equal(url.searchParams.get('outputFormat'), 'geojson');
  assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
  const [minLat, minLon, maxLat, maxLon, crs] = url.searchParams.get('bbox').split(',');
  assert.equal(crs, 'urn:ogc:def:crs:EPSG::4326');
  assert.ok(+minLat < 45.3 && +maxLat > 45.6 && +minLon < -73.8 && +maxLon > -73.3);
  const headers = api.calls[0].init.headers;
  assert.match(
    headers['User-Agent'],
    /^gladys-quebec-511\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-quebec-511\)$/,
  );
  assert.match(headers.Accept, /application\/geo\+json/);
  assert.equal(api.calls[0].init.redirect, 'error');
});

test('a zone not created in Gladys is read but nothing is published for it', async () => {
  const { fake, begin, api, wait } = await setup({ created: false });
  await begin();
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 2);
  assert.equal(fake.states.length, 0);
  assert.equal(fake.discoveredDevices.length, 1);
});

test('the period: rounds at 0, the interval, twice the interval; never sooner', async () => {
  const { begin, api, wait, fake, app } = await setup();
  await begin();
  await wait(INTERVAL - 1);
  assert.equal(api.calls.length, 2, 'never before the interval');
  await wait(1);
  assert.equal(api.calls.length, 3);
  await wait(INTERVAL);
  assert.deepEqual(
    api.calls.filter((c) => layerOf(c.url) === 'works').map((c) => Math.round(c.at)),
    [0, INTERVAL, 2 * INTERVAL],
  );
  // Discovery and the test button never read.
  await fake.scanRequest();
  app.testConnection();
  await wait(INTERVAL - 1);
  assert.equal(api.calls.length, 6);
});

test('a slow source never shortens nor stretches the period (measured from the round start)', async () => {
  const api = createApi(async (url, a) => {
    await new Promise((resolve) => a.clock.timers.setTimeout(resolve, 20 * SECOND));
    return real(url);
  });
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(INTERVAL * 2 + 45 * SECOND);
  assert.deepEqual(
    api.calls.filter((c) => layerOf(c.url) === 'works').map((c) => Math.round(c.at)),
    [0, INTERVAL, 2 * INTERVAL],
  );
  assert.equal(api.peak, 1, 'never two requests at once');
  assert.equal(fake.connectionStatus.connected, true);
});

test('the interval is 15 min at least; 120 at most; refused values fall back to 15', async () => {
  const { begin, api, wait, fake } = await setup({ config: { ...HOME, refresh_minutes: 5 } });
  await begin();
  await wait(INTERVAL - 1);
  assert.equal(api.calls.length, 2);
  await wait(1);
  assert.equal(api.calls.length, 3);
  assert.match(
    fake.connectionStatus.message.en,
    /refresh_minutes must be a whole number of minutes between 15 and 120/,
  );
});

test('a restart never reads sooner than the interval (time of the last attempt in /data)', async () => {
  const store = createMemoryStore();
  const first = await setup({ store });
  await first.begin();
  assert.ok(store.data.lastAttemptAt > 0, 'written before the read');
  await first.wait(REQUEST_GAP);
  await first.app.stop();

  const second = await setup({ store, start: CAPTURED_AT + MINUTE });
  await second.begin();
  assert.equal(second.api.calls.length, 0);
  assert.equal(second.fake.states.length, 0, 'nothing stale published at start');
  assert.match(
    second.fake.connectionStatus.message.en,
    /Home: no read yet\. Next read Nov 15, 07:57 ET\./,
  );
  await second.wait(14 * MINUTE - 1);
  assert.equal(second.api.calls.length, 0);
  await second.wait(10);
  assert.equal(second.api.calls.length, 1);
});

test('the attempt time is saved before the first request', async () => {
  const store = createMemoryStore();
  let savedBefore = null;
  const api = createApi((url) => {
    savedBefore ??= store.data?.lastAttemptAt ?? 0;
    return real(url);
  });
  const { begin } = await setup({ store, api });
  await begin();
  assert.ok(savedBefore > 0);
});

test('a date of /data in the future is not believed: the first read waits 15 min after the start', async () => {
  const store = createMemoryStore({ lastAttemptAt: CAPTURED_AT + HOUR });
  const { begin, api, wait, fake } = await setup({ store });
  await begin();
  assert.equal(api.calls.length, 0);
  assert.match(
    fake.connectionStatus.message.en,
    /\/data does not tell when the source was last read: the first read waits 15 min/,
  );
  await wait(INTERVAL - 10);
  assert.equal(api.calls.length, 0);
  await wait(20);
  assert.equal(api.calls.length, 1);
});

test('a configuration saved unchanged reads no sooner; a moved zone reads at once', async () => {
  const { begin, api, wait, app } = await setup();
  await begin();
  await wait(MINUTE);
  await app.start({ ...HOME });
  await wait(0);
  assert.equal(api.calls.length, 2, 'unchanged: no read');
  await wait(INTERVAL - MINUTE);
  assert.equal(api.calls.length, 3, 'the period kept');
  await wait(REQUEST_GAP);
  await app.start({ ...HOME, zone1_latitude: 45.6 });
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 5, 'moved: read at once, after the 5 s gap');
});

test('configurations saved in a row apply one after the other, the last one winning', async () => {
  const { app, wait, fake, api } = await setup();
  const a = app.start({ ...HOME, zone1_name: 'A' });
  const b = app.start({ ...HOME, zone1_name: 'B' });
  const c = app.start({ ...HOME, zone1_name: 'C', language: 'en' });
  await Promise.all([a, b, c]);
  await wait(0);
  await wait(REQUEST_GAP);
  assert.equal(fake.discoveredDevices[0].name, 'C');
  assert.equal(api.calls.length, 2, 'one round, for the last configuration');
  assert.match(published(fake, F(1, 'summary'))[0], /^28 road works in effect \(11 major\)/);
});

test('getConfig() failing on a connection is retried, spaced out, forever; then it starts', async () => {
  const { app, gladys, fake, wait, api } = await setup();
  const original = gladys.getConfig.bind(gladys);
  let failures = 4;
  gladys.getConfig = async () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('Gladys busy');
    }
    return original();
  };
  const connected = app.connected();
  await wait(0);
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(fake.connectionStatus.message.en, /next try in 5 s/);
  await wait(5 * SECOND);
  assert.match(fake.connectionStatus.message.en, /next try in 10 s/);
  await wait(10 * SECOND);
  await wait(20 * SECOND);
  assert.match(fake.connectionStatus.message.en, /next try in 40 s/);
  assert.equal(api.calls.length, 0);
  await wait(40 * SECOND);
  await connected;
  await wait(0);
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 2);
  assert.equal(fake.connectionStatus.connected, true);
});

test('a disconnection stops the config retries and the reads; a reconnection never reads sooner', async () => {
  const { app, gladys, wait, api } = await setup();
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    throw new Error('down');
  };
  app.connected();
  await wait(0);
  await app.disconnected();
  await wait(HOUR);
  assert.equal(calls, 1);
  delete gladys.getConfig;
  await app.connected();
  await wait(0);
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 2);
  await app.disconnected();
  await app.connected();
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 2, 'a reconnection is not a read');
  await wait(INTERVAL);
  assert.equal(api.calls.length, 4);
});

test('a 429 pauses every read (15 min, doubled), kept in /data across a restart', async () => {
  let limited = true;
  const api = createApi((url, a) => (limited ? html(429, a.clock.wall()) : real(url)));
  const store = createMemoryStore();
  const { begin, wait, fake, app } = await setup({ api, store });
  await begin();
  await wait(MINUTE);
  assert.equal(api.calls.length, 1, 'the other layer is not asked during the pause');
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(
    fake.connectionStatus.message.en,
    /The MTMD service asked to slow down \(429\): reads paused until Nov 15, 07:57 ET\./,
  );
  assert.match(
    fake.connectionStatus.message.en,
    /Home: road works: The MTMD service asked to slow down \(429\), no data yet; winter conditions: not read \(pause\), no data yet\./,
  );
  assert.ok(store.data.pause.until > CAPTURED_AT);
  await wait(INTERVAL - MINUTE);
  assert.equal(api.calls.length, 2, 'retried at the end of the pause');
  await wait(29 * MINUTE);
  assert.equal(api.calls.length, 2, 'second pause: 30 min');
  await app.stop();

  // Restart during the pause: still paused.
  const second = await setup({ api, store, start: api.clock.wall() });
  await second.begin();
  assert.equal(api.calls.length, 2);
  limited = false;
  await second.wait(MINUTE);
  await second.wait(REQUEST_GAP);
  assert.equal(api.calls.length, 4);
  assert.equal(second.fake.connectionStatus.connected, true);
  assert.equal(store.data.pause.level429, 0, 'a success resets the doubling');
});

test('a 5xx pauses for 5 min (doubled); Retry-After is honored, bounded to 6 h', async () => {
  let answer = (a) => json({ error: 'x' }, { status: 503, date: a.clock.wall() });
  const api = createApi((url, a) => answer(a));
  const { begin, wait, fake } = await setup({ api });
  await begin();
  assert.match(
    fake.connectionStatus.message.en,
    /MTMD server error \(HTTP 503\): reads paused until Nov 15, 07:47 ET/,
  );
  await wait(INTERVAL - 1);
  assert.equal(api.calls.length, 1);
  await wait(1);
  assert.equal(api.calls.length, 2, 'next read at the interval (longer than the pause)');
  answer = (a) => html(429, a.clock.wall(), { 'retry-after': String(100 * 3600) });
  await wait(INTERVAL);
  assert.equal(api.calls.length, 3, 'answered 429 with a 100 h Retry-After');
  await wait(6 * HOUR - 10);
  assert.equal(api.calls.length, 3);
  await wait(20);
  assert.equal(api.calls.length, 4, 'six hours at most');
});

test('a 403 (Cloudflare, HTML) is spaced out like a server error, with its own wording', async () => {
  const api = createApi((url, a) => html(403, a.clock.wall()));
  const { begin, wait, fake, store } = await setup({ api });
  await begin();
  assert.match(
    fake.connectionStatus.message.en,
    /Unexpected answer from the MTMD service \(HTTP 403\): reads paused/,
  );
  assert.equal(store.data.pause.levelHttp, 1);
  await wait(INTERVAL);
  await wait(INTERVAL);
  assert.equal(api.calls.length, 3);
  assert.equal(store.data.pause.levelHttp, 3);
  assert.equal(fake.states.length, 0);
});

test('one layer failing: its features are not published, the other layer is', async () => {
  let fail = 'conditions';
  const api = createApi((url) => (layerOf(url) === fail ? 'network' : real(url)));
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  assert.deepEqual(published(fake, F(1, 'works')), [28]);
  assert.deepEqual(published(fake, F(1, 'winter_segments')), [], 'never 0 for a failed read');
  assert.match(published(fake, F(1, 'summary'))[0], / · Conditions hivernales non lues$/);
  assert.match(
    fake.connectionStatus.message.en,
    /Home: 28 road work\(s\), 11 major, read Nov 15, 07:42 ET; winter conditions: The MTMD service could not be reached, no data yet\./,
  );
  assert.equal(fake.connectionStatus.connected, true);
  fail = 'works';
  await wait(INTERVAL);
  await wait(REQUEST_GAP);
  assert.deepEqual(published(fake, F(1, 'works')), [28], 'nothing published for the failed layer');
  assert.deepEqual(published(fake, F(1, 'winter_segments')), [0]);
  assert.equal(published(fake, F(1, 'summary')).length, 1);
  assert.match(
    fake.connectionStatus.message.en,
    /Home: road works: The MTMD service could not be reached, last data Nov 15, 07:42 ET, nothing published since; 0 segment/,
  );
  // Over 2 h without success: said stale.
  await wait(2 * HOUR + INTERVAL);
  assert.match(fake.connectionStatus.message.en, /last data Nov 15, 07:42 ET, stale, nothing/);
  assert.match(
    fake.connectionStatus.message.fr,
    /travaux : Service du MTMD injoignable, dernières données 15 nov\., 07 h 42 \(heure de l'Est\), périmées/,
  );
});

test('every layer failing is not "connected", and nothing is published', async () => {
  const api = createApi(() => 'network');
  const { begin, fake, wait } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(
    fake.connectionStatus.message.en,
    /^Home: road works: The MTMD service could not be reached, no data yet; winter/,
  );
  assert.equal(fake.states.length, 0);
});

test('a request that never answers is cut at 30 s and the other layer goes on', async () => {
  const api = createApi((url) => (layerOf(url) === 'works' ? 'timeout' : real(url)));
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_TIMEOUT);
  await wait(0);
  assert.equal(api.calls.length, 2);
  assert.match(
    fake.connectionStatus.message.en,
    /road works: The MTMD service did not answer in time, no data yet/,
  );
  assert.deepEqual(published(fake, F(1, 'winter_segments')), [0]);
});

test('winter conditions: snow and ice counted, bare and unknown codes not; routes filter', async () => {
  const conditions = [
    segment(1, 'PE'),
    segment(2, 'G', { CodeVisibilite: 'R' }),
    segment(3, 'Ds'),
    segment(4, 'XX'),
    segment(5, 'PE', { NumeroRoute: 40 }),
  ];
  const api = createApi((url) =>
    layerOf(url) === 'conditions' ? collection('conditions', () => conditions) : real(url),
  );
  const config = {
    ...HOME,
    language: 'en',
    zone2_latitude: 45.5017,
    zone2_longitude: -73.5673,
    zone2_roads: 'A-40, 117',
  };
  const { begin, wait, fake } = await setup({ api, config });
  await begin();
  await wait(REQUEST_GAP);
  assert.deepEqual(published(fake, F(1, 'winter_segments')), [3]);
  assert.deepEqual(published(fake, F(2, 'winter_segments')), [1]);
  assert.match(
    published(fake, F(1, 'summary'))[0],
    / · Winter conditions on 3 segments · Route 20: Partly Snow Covered · Route 20: Ice Covered, reduced visibility · Route 40: Partly Snow Covered$/,
  );
  // Zone 2 counts only the works on routes 40 and 117 (none in the capture).
  assert.deepEqual(published(fake, F(2, 'works')), [0]);
});

test('works: in effect judged on the server time, local dates of Québec', async () => {
  // 12:42 UTC = 07:42 EST. A work starting 07:45 local is not yet in effect;
  // one ended 07:40 local is over.
  const works = [
    work(1, { debut: '2026/11/15 07:40:00' }),
    work(2, { debut: '2026/11/15 07:45:00' }),
    work(3, { debut: '2026/11/01 07:00:00', fin: '2026/11/15 07:40:00' }),
    work(4, { debut: '', fin: 'n/a' }),
    work(5, { entraveType: 'Mineure (semaine)' }),
  ];
  const api = createApi((url) =>
    layerOf(url) === 'works' ? collection('works', () => works) : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  assert.deepEqual(published(fake, F(1, 'works')), [3], 'works 1, 4 (unknown dates) and 5');
  assert.deepEqual(published(fake, F(1, 'major_works')), [2]);
  await wait(INTERVAL);
  assert.deepEqual(published(fake, F(1, 'works')), [3, 4], 'work 2 started meanwhile');
});

test('the scene trigger: first read learns, a new fresh work fires once, an old one never', async () => {
  let works = [work('old', { debut: '2026/10/01 07:00:00', miseAJour: '2026/10/01 07:00:00' })];
  const api = createApi((url) =>
    layerOf(url) === 'works' ? collection('works', () => works) : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  assert.equal(fake.sceneEvents.length, 0, 'the first read only learns');
  works = [
    ...works,
    work(77),
    work('stale', { debut: '2026/11/01 07:00:00', miseAJour: '2026/11/02 07:00:00' }),
    work('later', { debut: '2026/11/20 07:00:00' }),
  ];
  await wait(INTERVAL);
  assert.equal(fake.sceneEvents.length, 1);
  assert.deepEqual(fake.sceneEvents[0], {
    key: 'new_works',
    data: {
      device: 'ext:quebec-511:zone:1',
      works_id: '77',
      route: 20,
      major: true,
      severity: 'major',
      restriction_type: 'Majeure (semaine et fin de semaine)',
      title: 'Travaux test 77',
      title_en: 'Test works 77',
      place: 'Montréal',
      impact: 'Fermeture de 1 voie sur 2',
      direction: 'Est',
      start: '2026-11-15T12:00:00.000Z',
      end: '2027-01-01T04:59:00.000Z',
      distance_km: 0.1,
    },
  });
  await wait(INTERVAL);
  assert.equal(fake.sceneEvents.length, 1, 'never twice');
});

test('a planned work is announced when it comes into effect', async () => {
  const planned = work('planned', {
    debut: '2026/11/15 07:50:00',
    miseAJour: '2026/10/01 07:00:00',
  });
  const api = createApi((url) =>
    layerOf(url) === 'works' ? collection('works', () => [planned]) : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  assert.deepEqual(published(fake, F(1, 'works')), [0]);
  await wait(INTERVAL);
  assert.deepEqual(published(fake, F(1, 'works')), [0, 1]);
  assert.equal(fake.sceneEvents.length, 1);
});

test('no scene event without a readable server time, nor after a moved zone', async () => {
  let works = [];
  let date = true;
  const api = createApi((url, a) =>
    layerOf(url) === 'works'
      ? json(
          collection('works', () => works),
          { date: date ? a.clock.wall() : null },
        )
      : real(url),
  );
  const { begin, wait, fake, app } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  date = false;
  works = [
    work('a'),
    work('epoch', { debut: '1970/01/01 00:01:00', miseAJour: '1970/01/01 00:01:00' }),
  ];
  await wait(INTERVAL);
  await wait(REQUEST_GAP);
  assert.equal(api.calls.length, 4);
  assert.equal(fake.sceneEvents.length, 0, 'no Date header: nothing said new');
  assert.deepEqual(
    published(fake, F(1, 'works')).at(-1),
    2,
    'without a time, every listed work counts',
  );
  date = true;
  await app.start({ ...HOME, zone1_radius_km: 21 });
  works = [work('a'), work('b')];
  await wait(2 * REQUEST_GAP);
  assert.equal(api.calls.length, 6, 'the moved zone was read');
  assert.equal(fake.sceneEvents.length, 0, 'a moved zone starts a new baseline');
});

test('at most 20 scene events per zone and per read', async () => {
  let works = [];
  const api = createApi((url) =>
    layerOf(url) === 'works' ? collection('works', () => works) : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP);
  works = Array.from({ length: 30 }, (_, i) => work(1000 + i));
  await wait(INTERVAL);
  assert.equal(fake.sceneEvents.length, 20);
});

test('an unreadable /data is never overwritten; the app runs from memory and says so', async () => {
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const { begin, fake, wait, api } = await setup({ store });
  await begin();
  assert.equal(api.calls.length, 0, 'never at once: /data cannot tell the last read');
  await wait(INTERVAL + 10);
  assert.equal(api.calls.length, 1);
  await wait(INTERVAL);
  assert.equal(api.calls.length, 3);
  assert.equal(store.saves, 0);
  assert.match(
    fake.connectionStatus.message.en,
    /state file of \/data is unreadable: left untouched/,
  );
  assert.equal(fake.sceneEvents.length, 0);
});

test('a failing or frozen /data never holds the reads back', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const { begin, wait, api, fake } = await setup({ store });
  await begin();
  assert.equal(api.calls.length, 0, 'a /data that cannot be written: no read at once');
  await wait(INTERVAL + 10);
  assert.equal(api.calls.length, 1);
  await wait(REQUEST_GAP);
  assert.match(
    fake.connectionStatus.message.en,
    /could not be written in \/data: a restart may read sooner/,
  );
  store.failSave = false;
  store.hold = new Promise(() => {});
  await wait(INTERVAL);
  await wait(10 * SECOND);
  assert.equal(api.calls.length, 4);
  await wait(INTERVAL);
  await wait(10 * SECOND);
  assert.equal(api.calls.length, 6, 'a frozen save never stops the next rounds');
});

test('/data holds no coordinates in clear; logs and status neither', async () => {
  const store = createMemoryStore();
  const config = { ...HOME, zone1_latitude: 45.512345, zone1_longitude: -73.554321 };
  const { begin, lines, fake, wait } = await setup({ store, config });
  await begin();
  await wait(REQUEST_GAP);
  const text = JSON.stringify([store.data, lines, fake.connectionStatuses]);
  assert.doesNotMatch(text, /45\.512345|73\.554321/);
  assert.match(store.data.zones['1'].fingerprint, /^[0-9a-f]{32}$/);
  assert.match(store.data.salt, /^[0-9a-f]{32}$/);
});

test('no valid zone: no read, the status names the field', async () => {
  const { begin, fake, api } = await setup({
    config: { zone1_latitude: 49.28, zone1_longitude: -123.12 },
  });
  await begin();
  assert.equal(api.calls.length, 0);
  assert.equal(fake.connectionStatus.connected, false);
  assert.match(
    fake.connectionStatus.message.en,
    /No valid zone.*Field zone1_latitude places the zone outside Québec/,
  );
});

test('the test button tells the last read and the next, without reading', async () => {
  const { begin, app, api, wait } = await setup();
  await begin();
  await wait(REQUEST_GAP);
  const message = app.testConnection();
  assert.equal(api.calls.length, 2);
  assert.match(message.en, /Home: 28 road work\(s\).*Next read Nov 15, 07:57 ET\./);
  assert.match(message.fr, /Prochaine lecture 15 nov\., 07 h 57/);
});

test('Discovery publishes the zones, no feature with options, nothing writable', async () => {
  const { fake, begin } = await setup({ config: THREE_ZONES });
  await begin();
  await fake.scanRequest();
  const devices = fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    ['ext:quebec-511:zone:1', 'ext:quebec-511:zone:2', 'ext:quebec-511:zone:3'],
  );
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Home', 'Québec 511 zone 2', 'Québec 511 zone 3'],
  );
  for (const device of devices) {
    assert.equal(device.poll_frequency, undefined);
    assert.deepEqual(
      device.features.map((f) => f.external_id.split(':').at(-1)),
      ['works', 'major_works', 'winter_segments', 'summary'],
    );
    for (const feature of device.features) {
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.category, 'switch');
      assert.equal(feature.supported_options, undefined);
      assert.ok(Number.isFinite(feature.min) && Number.isFinite(feature.max));
    }
  }
});

test('a stop leaves no timer and no read behind', async () => {
  const { begin, app, clock, wait, api } = await setup({ config: THREE_ZONES });
  await begin();
  await app.stop();
  assert.equal(clock.pending, 0);
  await wait(HOUR);
  assert.equal(api.calls.length, 1);
});

test('a reconnection republishes the status, even unchanged', async () => {
  const { app, fake, wait } = await setup();
  await app.connected();
  await wait(0);
  await wait(REQUEST_GAP);
  const count = fake.connectionStatuses.length;
  await app.disconnected();
  await app.connected();
  await wait(0);
  assert.ok(fake.connectionStatuses.length > count);
  assert.equal(fake.connectionStatus.connected, true);
});

test('a pause of /data longer than 6 h is invalid: ignored', async () => {
  const store = createMemoryStore({
    pause: { until: CAPTURED_AT + 100 * HOUR, level429: 3, level5xx: 0 },
  });
  const { begin, api } = await setup({ store });
  await begin();
  assert.equal(api.calls.length, 1);
});

test('a successful read older than 2 h is stale: not "connected"', async () => {
  const { begin, app, wait } = await setup();
  await begin();
  await wait(REQUEST_GAP);
  assert.equal(app.composeStatus().connected, true);
  await app.stop();
  await wait(2 * HOUR + MINUTE);
  const { connected, message } = app.composeStatus();
  assert.equal(connected, false);
  assert.match(
    message.en,
    /^Home: 28 road work\(s\).* \(stale, over 2 h\); 0 segment\(s\) in winter conditions \(stale, over 2 h\)\./,
  );
});

test('a request still in flight from an older configuration delays the next one', async () => {
  let slow = true;
  const api = createApi(async (url, a) => {
    if (slow) {
      slow = false;
      await new Promise((resolve) => a.clock.timers.setTimeout(resolve, 25 * SECOND));
    }
    return real(url);
  });
  const { app, wait } = await setup({ api });
  await app.start(HOME);
  await wait(0);
  assert.equal(api.calls.length, 1);
  await app.start({ ...HOME, zone1_latitude: 45.6 });
  await wait(20 * SECOND);
  assert.equal(api.calls.length, 1, 'not while the old one is in flight');
  await wait(7 * SECOND);
  assert.equal(api.calls.length, 2);
  assert.equal(api.peak, 1);
  assert.ok(api.calls[1].at >= 25 * SECOND);
});
