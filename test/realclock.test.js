// -----------------------------------------------------------------------------
// The app on the REAL moving clock (performance.now, Date.now, setTimeout)
// sped up 60 times, against a real local HTTP server playing the WFS with the
// captured answers: the rounds really start at the interval (measured on the
// method that decides), the two layer requests are 5 s apart, the timers stay
// bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { Quebec511App } from '../src/app.js';
import { REQUEST_GAP } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { HOME, MINUTE, collection } from './helpers/setup.js';

const SPEED = 60;
const REFRESH = 15;

test('real clock x60: one round per interval, requests 5 s apart, bounded timers', async (t) => {
  const clock = realClock({ speed: SPEED });
  const requests = [];
  // The start of each request as the app sends it (the server sees it a few
  // real milliseconds later, which the speed-up turns into simulated seconds).
  const sent = [];
  const server = createServer((req, res) => {
    requests.push({ at: clock.monotonic(), url: req.url, ua: req.headers['user-agent'] });
    const works = req.url.includes('chantiers');
    res.writeHead(200, { 'content-type': 'application/geo+json', date: new Date().toUTCString() });
    res.end(JSON.stringify(collection(works ? 'works' : 'conditions')));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ...HOME,
    zone2_latitude: 46.81,
    zone2_longitude: -71.21,
    refresh_minutes: REFRESH,
  };
  const gladys = createFakeGladys({ selector: 'quebec-511', config });
  await gladys.connect();
  const quiet = () => {};
  const app = new Quebec511App({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: (...args) => {
      sent.push(clock.monotonic());
      return fetch(...args);
    },
    wfsBase: `http://127.0.0.1:${server.address().port}/swtq`,
  });
  const spy = spyOn(app, 'round', clock);
  // Cleanup in t.after: a failing or hanging assertion never leaves the app alive.
  t.after(async () => {
    await app.stop();
    clock.close();
    spy.restore();
    await new Promise((resolve) => server.close(resolve));
  });
  await app.start(config);
  const gaps = await measurePeriod(spy, { count: 3, period: REFRESH * MINUTE });
  assert.equal(gaps.length, 2);
  await app.stop();
  // Two layers per round: 5 s (simulated) at least between two starts, as
  // sent by the app; the server still answers every one of them.
  assert.ok(requests.length >= 4, `${requests.length} requests`);
  assert.ok(sent.length >= requests.length);
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i] - sent[i - 1];
    assert.ok(gap >= 0.9 * REQUEST_GAP, `gap ${Math.round(gap)} ms`);
  }
  assert.match(requests[0].ua, /^gladys-quebec-511\//);
  assert.match(
    requests[0].url,
    /^\/swtq\?service=WFS&version=2\.0\.0&request=GetFeature&typeNames=ms%3Achantiers_mtmdet&/,
  );
  assert.ok(clock.timersSet < 40, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
