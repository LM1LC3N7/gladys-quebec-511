// -----------------------------------------------------------------------------
// The points of review r1: guards that had no test (scene loop after a stop,
// update time in the future, bounds of the ids seen, points per geometry),
// ids named like Object properties, more than 20 new works in one read, /data
// read again while unreadable, a stop cutting the request in flight, works
// whose dates cannot be read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGeometry } from '../src/geo.js';
import { createMemoryStore } from '../src/store.js';
import {
  F,
  HOME,
  HOUR,
  MINUTE,
  SECOND,
  collection,
  createApi,
  layerOf,
  published,
  real,
  setup,
  work,
} from './helpers/setup.js';

const INTERVAL = 15 * MINUTE;
const GAP = 6 * SECOND;
const DAY = 24 * HOUR;

/** A scripted WFS whose works layer is whatever `state.works` holds. */
function worksApi(state) {
  return createApi((url) =>
    layerOf(url) === 'works' ? collection('works', () => state.works) : real(url),
  );
}

test('a stop during the scene events: none sent after it', async () => {
  const state = { works: [] };
  const { begin, wait, gladys, app } = await setup({ api: worksApi(state) });
  await begin();
  await wait(GAP);
  state.works = [1, 2, 3, 4, 5].map((i) => work(500 + i));
  let calls = 0;
  const original = gladys.publishSceneEvent.bind(gladys);
  gladys.publishSceneEvent = async (key, data) => {
    calls += 1;
    if (calls === 1) await app.stop();
    return original(key, data);
  };
  await wait(INTERVAL);
  await wait(GAP);
  assert.equal(calls, 1);
});

test('an update time in the future of the server is ignored: no scene', async () => {
  const state = { works: [] };
  const { begin, wait, fake } = await setup({ api: worksApi(state) });
  await begin();
  await wait(GAP);
  // Started in October; "updated" 2 h after the server time.
  state.works = [work(9, { debut: '2026/10/01 07:00:00', miseAJour: '2026/11/15 10:00:00' })];
  await wait(INTERVAL);
  await wait(GAP);
  assert.deepEqual(published(fake, F(1, 'works')).at(-1), 1);
  assert.equal(fake.sceneEvents.length, 0);
});

test('the ids seen in /data: 2000 at most', async () => {
  const state = { works: Array.from({ length: 2001 }, (_, i) => work(10000 + i)) };
  const store = createMemoryStore();
  const { begin, wait } = await setup({ api: worksApi(state), store });
  await begin();
  await wait(GAP);
  assert.equal(Object.keys(store.data.zones['1'].seen).length, 2000);
});

test('an id not seen for 14 days is forgotten', async () => {
  const state = { works: [work('old'), work('kept')] };
  const store = createMemoryStore();
  const wall = { offset: 0 };
  const { begin, wait } = await setup({ api: worksApi(state), store, wall });
  await begin();
  await wait(GAP);
  state.works = [work('kept')];
  wall.offset = 13 * DAY;
  await wait(INTERVAL);
  await wait(GAP);
  assert.ok('old' in store.data.zones['1'].seen, 'still kept at 13 days');
  wall.offset = 15 * DAY;
  await wait(INTERVAL);
  await wait(GAP);
  assert.ok(!('old' in store.data.zones['1'].seen), 'forgotten at 15 days');
  assert.ok('kept' in store.data.zones['1'].seen);
});

test('a geometry is cut at 5000 points', () => {
  const coordinates = Array.from({ length: 6000 }, (_, i) => [-73.5 + i * 1e-5, 45.5]);
  const lines = readGeometry({ type: 'LineString', coordinates });
  assert.equal(lines[0].length, 5000);
});

test('ids named like Object properties are ids like any other, across a restart', async () => {
  const state = { works: [] };
  const store = createMemoryStore();
  const first = await setup({ api: worksApi(state), store });
  await first.begin();
  await first.wait(GAP);
  state.works = ['constructor', 'toString', '__proto__'].map((id) => work(id));
  await first.wait(INTERVAL);
  await first.wait(GAP);
  assert.deepEqual(first.fake.sceneEvents.map((e) => e.data.works_id).sort(), [
    '__proto__',
    'constructor',
    'toString',
  ]);
  await first.app.stop();
  const second = await setup({ api: worksApi(state), store, start: first.clock.wall() + HOUR });
  await second.begin();
  await second.wait(GAP);
  assert.equal(second.fake.sceneEvents.length, 0, 'already seen, kept in /data');
  assert.ok(Object.hasOwn(store.data.zones['1'].seen, '__proto__'), 'a key of its own');
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});

test('past 20 new works in one read, the others come with the next read', async () => {
  const state = { works: [] };
  const { begin, wait, fake } = await setup({ api: worksApi(state) });
  await begin();
  await wait(GAP);
  state.works = Array.from({ length: 25 }, (_, i) => work(700 + i));
  await wait(INTERVAL);
  await wait(GAP);
  assert.equal(fake.sceneEvents.length, 20);
  await wait(INTERVAL);
  await wait(GAP);
  assert.equal(fake.sceneEvents.length, 25);
  assert.equal(new Set(fake.sceneEvents.map((e) => e.data.works_id)).size, 25);
  await wait(INTERVAL);
  await wait(GAP);
  assert.equal(fake.sceneEvents.length, 25);
});

test('/data unreadable at start is read again every 10 s; its pause comes back', async () => {
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const { begin, wait, fake, app, clock } = await setup({ store });
  await begin();
  assert.match(fake.connectionStatus.message.en, /state file of \/data is unreadable/);
  await wait(9 * SECOND);
  assert.equal(store.saves, 0);
  store.status = undefined;
  store.data = {
    pause: { until: clock.wall() + 2 * HOUR, kind: 'rate', status: 429, level429: 2 },
  };
  await wait(2 * SECOND);
  assert.doesNotMatch(fake.connectionStatus.message.en, /unreadable/);
  assert.ok(app.pausedFor() > HOUR, `${app.pausedFor()}`);
  assert.ok(store.saves >= 1, 'written again once readable');
  assert.equal(store.data.pause.level429, 2);
});

test('a /data that never answers is given up after 2 s, then read again', async () => {
  const store = createMemoryStore();
  let reads = 0;
  store.loadAsync = () => {
    reads += 1;
    return new Promise(() => {});
  };
  store.save = async () => {};
  const { app, wait, fake } = await setup({ store });
  app.start(HOME);
  await wait(2 * SECOND + 10);
  assert.match(fake.connectionStatus.message.en, /state file of \/data is unreadable/);
  await wait(12 * SECOND);
  assert.ok(reads >= 2, `${reads} reads`);
  assert.ok(reads <= 3, 'one read at a time, every 10 s');
});

test('a stop cuts the request in flight', async () => {
  const api = createApi(() => 'timeout');
  const { begin, app, api: a } = await setup({ api });
  await begin();
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].init.signal.aborted, false);
  await app.stop();
  assert.equal(a.calls[0].init.signal.aborted, true);
});

test('works whose dates mostly cannot be read: the layer is refused, never all in effect', async () => {
  const state = {
    works: [
      work(1, { fin: '2026-12-31T23:59:00Z' }),
      work(2, { debut: '2025/05/05 05:00:00.5' }),
      work(3, { fin: '' }),
      work(4),
    ],
  };
  const { begin, wait, fake } = await setup({ api: worksApi(state) });
  await begin();
  await wait(GAP);
  assert.deepEqual(published(fake, F(1, 'works')), []);
  assert.match(
    fake.connectionStatus.message.en,
    /road works: The MTMD sends features that cannot be read/,
  );
  // A few undated ones among readable ones are kept (in effect).
  state.works = [work(1, { fin: '' }), work(2), work(3)];
  await wait(INTERVAL);
  await wait(GAP);
  assert.deepEqual(published(fake, F(1, 'works')), [3]);
});
