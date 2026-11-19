// -----------------------------------------------------------------------------
// Pauses of every kind, restarts with a /data that cannot tell the last read,
// answers that are not a full list, server time, and the guarantees the
// reviews of the neighbour DriveBC module asked for, carried over to the WFS.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { Quebec511App } from '../src/app.js';
import { createFileStore, createMemoryStore } from '../src/store.js';
import { normalizeConfig } from '../src/config.js';
import { realClock } from './kit/clock.mjs';
import {
  CAPTURED_AT,
  F,
  HOME,
  HOUR,
  MINUTE,
  SECOND,
  THREE_ZONES,
  WORKS_FIXTURE,
  collection,
  createApi,
  html,
  json,
  layerOf,
  published,
  real,
  setup,
  work,
} from './helpers/setup.js';

const INTERVAL = 15 * MINUTE;

// --- A refusal arriving after a config save or a reconnection ---------------------

for (const [name, change] of [
  ['a configuration saved', (app) => app.start({ ...HOME, zone1_radius_km: 31 })],
  [
    'a reconnection',
    async (app) => {
      await app.disconnected();
      await app.connected();
    },
  ],
]) {
  test(`a 429 answered after ${name} still pauses the reads`, async () => {
    let first = true;
    const api = createApi(async (url, a) => {
      if (first) {
        first = false;
        await new Promise((resolve) => a.clock.timers.setTimeout(resolve, 3 * SECOND));
        return html(429, a.clock.wall());
      }
      return real(url);
    });
    const store = createMemoryStore();
    const { app, wait } = await setup({ api, store });
    await app.start(HOME);
    await wait(SECOND);
    await change(app);
    await wait(3 * SECOND);
    assert.ok(app.pausedFor() > 14 * MINUTE, `${app.pausedFor()}`);
    assert.equal(store.data.pause.level429, 1);
    await wait(INTERVAL - 10 * SECOND);
    assert.equal(api.calls.length, 1, 'nothing during the pause');
    await wait(20 * SECOND);
    assert.equal(api.calls.length, 3);
  });
}

// --- The end of a pause on the real clock ----------------------------------------

test('real clock x300: the read after a 5 min pause (5xx) comes at 15 min, the interval', async (t) => {
  const clock = realClock({ speed: 300 });
  const times = [];
  const server = createServer((req, res) => {
    times.push(clock.monotonic());
    const status = times.length === 1 ? 503 : 200;
    res.writeHead(status, {
      'content-type': status === 200 ? 'application/geo+json' : 'text/html',
      date: new Date().toUTCString(),
    });
    res.end(status === 200 ? JSON.stringify(collection('works')) : '<html>503</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gladys = createFakeGladys({ selector: 'quebec-511', config: HOME });
  await gladys.connect();
  const quiet = () => {};
  const app = new Quebec511App({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    wfsBase: `http://127.0.0.1:${server.address().port}/swtq`,
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await app.start(HOME);
  const deadline = performance.now() + 15000;
  while (times.length < 2 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(times.length, 2);
  const gap = times[1] - times[0];
  assert.ok(gap >= INTERVAL * 0.99 && gap < INTERVAL * 1.1, `${Math.round(gap / 1000)} s`);
});

test('a round woken a little before the end of a pause is armed again, not skipped', async () => {
  const { begin, app, api, wait, fake } = await setup();
  await begin();
  await wait(INTERVAL - SECOND);
  app.cancelTimers();
  app.nextDueMono = app.monotonic();
  app.pauseUntilMono = app.monotonic() + 0.8;
  await app.runCycle(app.gen);
  assert.equal(api.calls.length, 2, 'nothing read before the end');
  assert.doesNotMatch(JSON.stringify(fake.connectionStatus), /pause/);
  await wait(10);
  assert.equal(api.calls.length, 3);
});

test('a round woken before its due time is armed again with a 5 ms margin', async () => {
  const { begin, app, wait, api } = await setup();
  await begin();
  await wait(INTERVAL - SECOND);
  app.cancelTimers();
  const delays = [];
  const schedule = app.scheduleCycle.bind(app);
  app.scheduleCycle = (delay, gen) => {
    delays.push(delay);
    return schedule(delay, gen);
  };
  app.nextDueMono = app.monotonic() + 0.8;
  await app.runCycle(app.gen);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 5 && delays[0] < 6, `${delays[0]}`);
  assert.equal(api.calls.length, 2);
  await wait(10);
  assert.equal(api.calls.length, 3);
});

// --- Restarts when /data cannot tell the last attempt -----------------------------

async function storm(makeStore, count = 4) {
  let calls = 0;
  let start = CAPTURED_AT;
  for (let i = 0; i < count; i += 1) {
    const api = createApi();
    const { app, wait } = await setup({ api, store: await makeStore(), start });
    const started = app.start(HOME);
    await wait(0);
    await wait(30 * SECOND);
    await started;
    calls += api.calls.length;
    const stopped = app.stop();
    await wait(3 * SECOND);
    await stopped;
    start += 30 * SECOND;
  }
  return calls;
}

test('restarts every 30 s with an unreadable /data: no read at all', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quebec-511-storm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  await writeFile(file, '{"lastAttemptAt": 17', 'utf8');
  assert.equal(await storm(async () => createFileStore(file)), 0);
});

test('restarts every 30 s with a /data that cannot be written: no read at all', async () => {
  const calls = await storm(async () => {
    const store = createMemoryStore();
    store.failSave = true;
    return store;
  });
  assert.equal(calls, 0);
});

test('restarts every 30 s with a frozen /data: no read at all', async () => {
  const calls = await storm(async () => {
    const store = createMemoryStore();
    store.hold = new Promise(() => {});
    return store;
  });
  assert.equal(calls, 0);
});

test('restarts every 30 s with a writable /data: one round, the first', async () => {
  const store = createMemoryStore();
  assert.equal(await storm(async () => store), 2);
});

test('restarts with a readable but read-only /data holding an old attempt: no read at once', async () => {
  const calls = await storm(async () => {
    const store = createMemoryStore({ lastAttemptAt: CAPTURED_AT - HOUR });
    store.failSave = true;
    return store;
  });
  assert.equal(calls, 0);
});

test('with /data unreadable, a config saved again or a reconnection never reads at once', async () => {
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const { app, api, wait } = await setup({ store });
  await app.connected();
  await wait(0);
  await wait(INTERVAL + 10);
  await wait(REQUEST_GAP_PLUS);
  assert.equal(api.calls.length, 2);
  await app.start({ ...HOME });
  await wait(10 * SECOND);
  await app.disconnected();
  await app.connected();
  await wait(10 * SECOND);
  assert.equal(api.calls.length, 2);
});

const REQUEST_GAP_PLUS = 6 * SECOND;

// --- Answers that are not a full list ---------------------------------------------

test('a list made only of unreadable features is never published as 0', async () => {
  const api = createApi((url) =>
    layerOf(url) === 'works'
      ? { type: 'FeatureCollection', numberMatched: 4, features: [null, 1, {}, { properties: {} }] }
      : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), []);
  assert.match(published(fake, F(1, 'summary'))[0], /^Travaux non lus · /);
  assert.match(
    fake.connectionStatus.message.en,
    /road works: The MTMD sends features that cannot be read/,
  );
  assert.equal(fake.connectionStatus.message.en.includes('paused'), false, 'no pause');
});

test('exactly half unreadable: the readable half is published; a few skipped are not an error', async () => {
  const api = createApi((url) =>
    layerOf(url) === 'works'
      ? { type: 'FeatureCollection', numberMatched: 2, features: [work(1), { properties: {} }] }
      : real(url),
  );
  const { begin, wait, fake, lines } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), [1]);
  assert.ok(lines.some((l) => /1 feature\(s\) without id or place ignored/.test(l)));
});

test('a cut answer (numberMatched larger than the list) is refused, never a count', async () => {
  const api = createApi((url) => {
    if (layerOf(url) !== 'works') return real(url);
    const body = collection('works');
    body.numberMatched += 1;
    return body;
  });
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), []);
  assert.match(fake.connectionStatus.message.en, /MTMD answer incomplete/);
});

test('an empty collection is a real 0 (no works in the box)', async () => {
  const api = createApi((url) =>
    layerOf(url) === 'works'
      ? { type: 'FeatureCollection', numberMatched: 0, features: [] }
      : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), [0]);
  assert.match(published(fake, F(1, 'summary'))[0], /^Aucuns travaux en cours · /);
});

test('the XML ExceptionReport of the WFS (200, text/xml) is not readable, never 0', async () => {
  const api = createApi((url, a) =>
    layerOf(url) === 'works'
      ? new Response('<?xml version="1.0"?><ows:ExceptionReport/>', {
          status: 200,
          headers: { 'content-type': 'text/xml', date: new Date(a.clock.wall()).toUTCString() },
        })
      : real(url),
  );
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), []);
  assert.match(fake.connectionStatus.message.en, /MTMD answer not readable/);
});

test('a body larger than 8 MB is cut before it is read in full', async () => {
  let pulled = 0;
  const api = createApi((url, a) => {
    if (layerOf(url) !== 'works') return real(url);
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled > 100) controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/geo+json',
        date: new Date(a.clock.wall()).toUTCString(),
      },
    });
  });
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.ok(pulled <= 12, `${pulled} MB pulled`);
  assert.match(fake.connectionStatus.message.en, /MTMD answer too large/);
});

// --- Server time ----------------------------------------------------------------------

for (const [name, date] of [
  ['of 1970', () => 0],
  ['3 days ahead', (a) => a.clock.wall() + 72 * HOUR],
  ['30 h behind', (a) => a.clock.wall() - 30 * HOUR],
]) {
  test(`a server Date ${name}: road works not counted (never all listed), said in the status`, async () => {
    const api = createApi((url, a) =>
      layerOf(url) === 'works' ? json(collection('works'), { date: date(a) }) : real(url),
    );
    const { begin, wait, fake } = await setup({ api });
    await begin();
    await wait(REQUEST_GAP_PLUS);
    assert.deepEqual(published(fake, F(1, 'works')), []);
    assert.deepEqual(published(fake, F(1, 'major_works')), []);
    assert.deepEqual(published(fake, F(1, 'winter_segments')), [0]);
    assert.match(published(fake, F(1, 'summary'))[0], /^Travaux non lus · /);
    assert.match(
      fake.connectionStatus.message.en,
      /road works: No believable time to judge the road works in effect/,
    );
    assert.match(fake.connectionStatus.message.fr, /travaux : Pas d'heure fiable/);
    assert.equal(fake.sceneEvents.length, 0);
  });
}

test('no Date header: the local clock, when plausible, judges "in effect"', async () => {
  const api = createApi((url) => json(real(url), { date: null }));
  const { begin, wait, fake } = await setup({ api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), [28], 'the same count as with the Date header');
});

test('no Date header and a local clock of 1970: road works not counted', async () => {
  const api = createApi((url) => json(real(url), { date: null }));
  const { begin, wait, fake } = await setup({ api, start: Date.UTC(1970, 0, 2) });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), []);
  assert.match(fake.connectionStatus.message.en, /No believable time/);
});

test('in effect is judged on the server time, not on a skewed local clock', async () => {
  const wall = { offset: 10 * HOUR };
  const api = createApi((url, a) => json(real(url), { date: a.clock.now() }));
  const { begin, wait, fake } = await setup({ api, wall });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.deepEqual(published(fake, F(1, 'works')), [28]);
});

test('a server Date 23 h off is believed, 25 h off is not', async () => {
  for (const [offset, believed] of [
    [23 * HOUR, true],
    [25 * HOUR, false],
  ]) {
    const api = createApi((url, a) => json(real(url), { date: a.clock.wall() - offset }));
    const { begin, wait, lines } = await setup({ api });
    await begin();
    await wait(REQUEST_GAP_PLUS);
    assert.equal(
      lines.some((l) => /more than a day off/.test(l)),
      !believed,
      `${offset}`,
    );
  }
});

// --- Configuration, /data ---------------------------------------------------------------

test('configurations saved in a row: the ones superseded meanwhile are never applied', async () => {
  const { app, gladys, wait } = await setup();
  const names = [];
  const publish = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.publishDiscoveredDevices = (devices) => {
    names.push(devices[0]?.name);
    return publish(devices);
  };
  await Promise.all([
    app.start({ ...HOME, zone1_name: 'A' }),
    app.start({ ...HOME, zone1_name: 'B' }),
    app.start({ ...HOME, zone1_name: 'C' }),
  ]);
  await wait(0);
  assert.deepEqual(names, ['A', 'C']);
});

test('a state file over 1 MB is unreadable (and left untouched)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quebec-511-big-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }), 'utf8');
  assert.equal(createFileStore(file).load().status, 'unreadable');
});

test('the fingerprint of a zone is salted: two installs never share it', async () => {
  const zone = normalizeConfig(HOME).zones[0];
  const fp = async (salt) => {
    const store = createMemoryStore({ salt });
    const { begin, store: s, wait } = await setup({ store });
    await begin();
    await wait(REQUEST_GAP_PLUS);
    return s.data.zones['1'].fingerprint;
  };
  const a = await fp('a'.repeat(32));
  const b = await fp('b'.repeat(32));
  assert.notEqual(a, b);
  const unsalted = createHash('sha256')
    .update(JSON.stringify(['', zone.latitude, zone.longitude, zone.radiusKm, zone.roads]))
    .digest('hex')
    .slice(0, 32);
  assert.notEqual(a, unsalted);
});

test('a pause started by the first layer is said at once; the second layer is not asked', async () => {
  const api = createApi((url, a) => html(429, a.clock.wall()));
  const { begin, wait, fake } = await setup({ config: THREE_ZONES, api });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.equal(api.calls.length, 1);
  assert.match(
    fake.connectionStatus.message.en,
    /Québec 511 zone 2: road works: .*winter conditions: not read \(pause\)/,
  );
});

test('a failing layer logs and says no coordinate', async () => {
  const api = createApi(() => 'network');
  const config = { ...HOME, zone1_latitude: 45.512345, zone1_longitude: -73.554321 };
  const { begin, lines, fake, wait } = await setup({ api, config });
  await begin();
  await wait(REQUEST_GAP_PLUS);
  assert.ok(lines.some((line) => /read failed/.test(line)));
  assert.doesNotMatch(
    JSON.stringify([lines, fake.connectionStatuses, api.calls.map((c) => c.url)]),
    /45\.512345|73\.554321/,
  );
});

test('the capture itself is the one the tests read (Date header kept)', () => {
  assert.equal(CAPTURED_AT, Date.parse('Sun, 15 Nov 2026 12:42:35 GMT'));
  assert.equal(WORKS_FIXTURE.body.type, 'FeatureCollection');
});
