// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted MTMD WFS and a virtual
// clock (gladys-testkit `testClock`: each clock read moves 1 µs, timers fire
// only through `advance`). The WFS answers through a `world(url, api, call)`
// function: a JSON body (200), a Response, 'timeout' (never answers),
// 'network' (refused), or a promise of one of them (a slow answer). `layerOf`
// tells which layer a URL asks for.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { Quebec511App } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevices } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SELECTOR = 'quebec-511';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
/** The real answers captured on 2026-11-15 around Montréal (geometries thinned). */
export const WORKS_FIXTURE = fixture('montreal-works.json');
export const CONDITIONS_FIXTURE = fixture('montreal-conditions.json');

/** The time of the capture (its `Date` header). */
export const CAPTURED_AT = Date.parse(WORKS_FIXTURE.date);

export const HOME = {
  zone1_name: 'Home',
  zone1_latitude: 45.5017,
  zone1_longitude: -73.5673,
  zone1_radius_km: 20,
};
export const THREE_ZONES = {
  ...HOME,
  zone2_latitude: 45.55,
  zone2_longitude: -73.75,
  zone2_radius_km: 10,
  zone3_latitude: 45.45,
  zone3_longitude: -73.45,
};

export const F = (slot, key) => `ext:${SELECTOR}:zone:${slot}:${key}`;

/** `works` or `conditions` from a WFS URL. */
export function layerOf(url) {
  const name = new URL(url).searchParams.get('typeNames');
  return name === 'ms:chantiers_mtmdet'
    ? 'works'
    : name === 'ms:conditions_routieres'
      ? 'conditions'
      : null;
}

/** A copy of a fixture body, with its features changed by `edit`. */
export function collection(layer, edit = (features) => features) {
  const body = structuredClone((layer === 'works' ? WORKS_FIXTURE : CONDITIONS_FIXTURE).body);
  body.features = edit(body.features);
  body.numberMatched = body.features.length;
  return body;
}

/** The default world: the captured answer of the layer asked. */
export const real = (url) => collection(layerOf(url));

/** A road work at the Home center, in effect around the capture (local time). */
export function work(id, over = {}) {
  return {
    type: 'Feature',
    id,
    properties: {
      identifiant: String(id),
      identifiantChantier: '1',
      routeAutoroute: '20',
      entraveType: 'Majeure (semaine et fin de semaine)',
      debut: '2026/11/15 07:00:00',
      fin: '2026/12/31 23:59:00',
      miseAJour: '2026/11/15 07:30:00',
      identificationDesTravaux: `Travaux test ${id}`,
      localisation: 'Montréal',
      entrave: 'Fermeture de 1 voie sur 2',
      direction: 'Est',
      descriptionFrancais: `Travaux test ${id}`,
      descriptionAnglais: `Test works ${id}\nMontreal`,
      couleurLigne: '#FF0000',
      source: 'https://www.quebec511.info',
      ...over,
    },
    geometry: {
      type: 'LineString',
      coordinates: [
        [-73.567, 45.501],
        [-73.566, 45.502],
      ],
    },
  };
}

/** A winter condition segment at the Home center. */
export function segment(id, code = 'PE', over = {}) {
  const texts = {
    Ds: ['Dégagée et sèche', 'Bare and Dry'],
    PE: ['Partiellement enneigée', 'Partly Snow Covered'],
    G: ['Glacée', 'Ice Covered'],
  }[code] ?? ['?', '?'];
  return {
    type: 'Feature',
    properties: {
      NumeroSegment: id,
      NumeroRoute: 20,
      NomRoute: 'autoroute 20',
      NomRegion: 'Montréal',
      LocalisationDebutFR: 'A',
      LocalisationFinFR: 'B',
      LocalisationDebutEN: 'A',
      LocalisationFinEN: 'B',
      CodeEtatChaussee: code,
      DescriptionEtatChausseeFR: texts[0],
      DescriptionEtatChausseeEN: texts[1],
      CodeCouleurEtatChaussee: 'FFCF0D',
      CodeVisibilite: 'B',
      DescriptionVisibiliteFR: 'Bonne',
      DescriptionVisibiliteEN: 'Good',
      CodeCouleurVisibilite: '0D0D0D',
      IndicateurPresenceLamesNeige: 'N',
      EnVigueurDepuis: '2026-11-15T06:00:00',
      ...over,
    },
    geometry: {
      type: 'LineString',
      coordinates: [
        [-73.568, 45.5],
        [-73.567, 45.502],
      ],
    },
  };
}

export function json(body, { status = 200, date, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/geo+json',
      ...(date === null ? {} : { date: new Date(date).toUTCString() }),
      ...headers,
    },
  });
}

export function html(status, date, headers = {}) {
  return new Response('<html><body>Error</body></html>', {
    status,
    headers: { 'content-type': 'text/html', date: new Date(date).toUTCString(), ...headers },
  });
}

const abortable = (signal, kind) =>
  new Promise((_, reject) => {
    if (kind === 'network') reject(new TypeError('fetch failed'));
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

/** A scripted WFS: every request is recorded with the virtual time. */
export function createApi(world = real) {
  const api = { world, calls: [], open: 0, peak: 0, clock: null };
  api.fetch = async (url, init) => {
    const call = { url: String(url), init, at: api.clock.elapsed, wall: api.clock.wall() };
    api.calls.push(call);
    api.open += 1;
    api.peak = Math.max(api.peak, api.open);
    try {
      const answer = await api.world(call.url, api, call);
      if (answer === 'timeout' || answer === 'network')
        return await abortable(init?.signal, answer);
      if (answer instanceof Response) return answer;
      return json(answer, { date: api.clock.wall() });
    } finally {
      api.open -= 1;
    }
  };
  return api;
}

/** The devices of a configuration as created by the user in Gladys. */
export function createdDevices(config) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevices(gladys, normalizeConfig(config));
}

export async function setup({
  config = HOME,
  devices,
  store = createMemoryStore(),
  api = createApi(),
  created = true,
  start = CAPTURED_AT,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devices ?? (created ? createdDevices(config) : []),
  });
  await gladys.connect();
  const clock = testClock({ start });
  clock.wall = () => clock.now() + wall.offset;
  api.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new Quebec511App({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.wall(),
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: api.fetch,
  });
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  const begin = async (cfg = config) => {
    await app.start(cfg);
    await wait(0);
  };
  return { app, gladys, fake: gladys.fake, clock, store, api, wait, begin, lines, wall };
}

/** The values published for a feature, in order. */
export const published = (fake, id) =>
  fake.states
    .filter((s) => s.device_feature_external_id === id)
    .map((s) => (s.text !== undefined ? s.text : s.state));
