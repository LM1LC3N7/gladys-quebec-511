// -----------------------------------------------------------------------------
// The WFS of the Québec ministry of transport: one GetFeature of a layer in
// a box, read with an honest User-Agent, an explicit GeoJSON Accept, a bounded
// time and a bounded body (cut before it is read in full), then each feature
// read strictly into a small object. Nothing here retries, waits or keeps
// state: the app paces the requests (one at a time) and decides.
//
// Format, checked on the live service (2026-11-15): `outputFormat=geojson`
// answers `application/geo+json`, a FeatureCollection with `numberMatched`;
// `srsName=EPSG:4326` gives `[lon, lat]` coordinates; the box is given as an
// URN, so in latitude, longitude order. Dates carry no offset and are Québec
// local time: `2025/05/05 05:00:00` (works), `2026-11-15T04:07:47`
// (conditions, 04:07 EST for a `Date` header of 09:19 GMT). An unknown layer
// answers 200 with an XML ExceptionReport (read here as "not readable").
// -----------------------------------------------------------------------------

import {
  BARE_CODES,
  LAYERS,
  MAX_BODY_BYTES,
  MAX_FEATURES,
  REQUEST_TIMEOUT,
  SURFACE_CODES,
  TIME_ZONE,
  USER_AGENT,
  VISIBILITY_CODES,
  WFS_BASE,
} from './constants.js';
import { readGeometry } from './geo.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const TEXT_MAX = 2000;

/**
 * The URL of a layer inside a box `[minLon, minLat, maxLon, maxLat]`. The
 * WFS 2.0 box with an EPSG URN is in latitude, longitude order.
 */
export function layerUrl(layer, bbox, base = WFS_BASE) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: layer,
    outputFormat: 'geojson',
    srsName: 'EPSG:4326',
    bbox: `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`,
  });
  return `${base}?${params}`;
}

/**
 * One GET. Resolves `{ ok: true, json, serverDate }` or `{ ok: false, kind,
 * status?, retryAfter?, serverDate }`, `kind` among `network`, `timeout`,
 * `rate` (429), `server` (5xx), `http` (other status), `format`, `too_big`.
 * Never throws.
 */
export async function getJson(url, { fetchImpl = fetch, timers = globalThis } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/geo+json, application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    timers.clearTimeout(timer);
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate: null };
  }
  const serverDate = readHttpDate(response.headers.get('date'));
  try {
    if (response.status === 429) {
      return {
        ok: false,
        kind: 'rate',
        status: 429,
        retryAfter: readRetryAfter(response.headers.get('retry-after'), serverDate),
        serverDate,
      };
    }
    if (response.status >= 500) {
      return {
        ok: false,
        kind: 'server',
        status: response.status,
        retryAfter: readRetryAfter(response.headers.get('retry-after'), serverDate),
        serverDate,
      };
    }
    if (response.status !== 200) {
      return { ok: false, kind: 'http', status: response.status, serverDate };
    }
    const type = response.headers.get('content-type') ?? '';
    if (!/\bjson\b/i.test(type)) return { ok: false, kind: 'format', status: 200, serverDate };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return { ok: false, kind: 'too_big', status: 200, serverDate };
    }
    const text = await readBounded(response);
    if (text === null) return { ok: false, kind: 'too_big', status: 200, serverDate };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, kind: 'format', status: 200, serverDate };
    }
    return { ok: true, json, serverDate };
  } catch {
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate };
  } finally {
    timers.clearTimeout(timer);
    // A body left unread is released, never kept open.
    response.body?.cancel?.().catch?.(() => {});
  }
}

/** The body as text, or `null` past `max` bytes (the rest never read). */
async function readBounded(response, max = MAX_BODY_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/** An HTTP date (`Sun, 15 Nov 2026 09:19:25 GMT`) in ms, or `null`. */
export function readHttpDate(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `Retry-After` in ms (seconds or an HTTP date read against the server's). */
export function readRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{1,6}$/.test(text)) return Number(text) * 1000;
  const at = readHttpDate(text);
  if (at !== null && serverDate !== null) return Math.max(0, at - serverDate);
  return null;
}

let zoneFormat;

/** The offset of Québec time from UTC at the instant `ms`, in ms. */
function zoneOffset(ms) {
  zoneFormat ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(
    zoneFormat.formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]),
  );
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
  );
}

const LOCAL = /^(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A date of the source (Québec local time, no offset) in ms, or `null`. A
 * time skipped by the spring change is read with the offset before the
 * change (standard time); a time repeated in the fall is read as its first
 * occurrence.
 */
export function readLocalTime(value) {
  if (typeof value !== 'string') return null;
  const match = LOCAL.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(guess);
  if (
    check.getUTCFullYear() !== +y ||
    check.getUTCMonth() !== +mo - 1 ||
    check.getUTCDate() !== +d ||
    +h > 23 ||
    +mi > 59 ||
    +s > 59
  ) {
    return null;
  }
  // The offsets in force half a day before and after: one of them, or both
  // around a change, gives back the wall time read.
  const before = zoneOffset(guess - 12 * 3600 * 1000);
  const after = zoneOffset(guess + 12 * 3600 * 1000);
  const fits = [guess - before, guess - after].filter((t) => t + zoneOffset(t) === guess);
  // Twice in the fall: the first; never in the spring: the offset before the change.
  return fits.length > 0 ? Math.min(...fits) : guess - before;
}

/** A text from the source, bounded, without control bytes; `''` when absent. */
export function readString(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, max).join('');
}

/** A route number (`"20"`, `40`), or `null` (no number: a local road, a tunnel name). */
export function readRoute(value) {
  if (typeof value === 'number')
    return Number.isInteger(value) && value > 0 && value < 10000 ? value : null;
  if (typeof value !== 'string' || !/^\s*\d{1,4}\s*$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

const readId = (value) => {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[0-9A-Za-z_-]{1,40}$/.test(text) ? text : null;
};

/**
 * One road work of `ms:chantiers_mtmdet`, or `null` when it lacks what
 * identifies or places it. `start` / `end` are null when unreadable (then the
 * work is taken as in effect: without a readable time it never expires).
 */
export function readWork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw.properties;
  if (!p || typeof p !== 'object') return null;
  const id = readId(p.identifiant);
  if (!id) return null;
  const lines = readGeometry(raw.geometry);
  if (!lines) return null;
  const type = readString(p.entraveType, 80);
  return {
    id,
    route: readRoute(p.routeAutoroute),
    major: /^majeure\b/i.test(type),
    type,
    start: readLocalTime(p.debut),
    end: readLocalTime(p.fin),
    updated: readLocalTime(p.miseAJour),
    title: readString(p.identificationDesTravaux, 200),
    // The English text has the title on its first line.
    titleEn: readString(
      typeof p.descriptionAnglais === 'string' ? p.descriptionAnglais.split(/\r?\n/)[0] : '',
      200,
    ),
    place: readString(p.localisation, 300),
    impact: readString(p.entrave, 500),
    direction: readString(p.direction, 60),
    descriptionFr: readString(p.descriptionFrancais),
    descriptionEn: readString(p.descriptionAnglais),
    lines,
  };
}

/** One segment of `ms:conditions_routieres`, or `null`. */
export function readCondition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw.properties;
  if (!p || typeof p !== 'object') return null;
  const id = readId(p.NumeroSegment);
  if (!id) return null;
  const lines = readGeometry(raw.geometry);
  if (!lines) return null;
  const surface = SURFACE_CODES.includes(p.CodeEtatChaussee) ? p.CodeEtatChaussee : null;
  const visibility = VISIBILITY_CODES.includes(p.CodeVisibilite) ? p.CodeVisibilite : null;
  return {
    id,
    route: readRoute(p.NumeroRoute),
    road: readString(p.NomRoute, 80),
    from: {
      fr: readString(p.LocalisationDebutFR, 200),
      en: readString(p.LocalisationDebutEN, 200),
    },
    to: { fr: readString(p.LocalisationFinFR, 200), en: readString(p.LocalisationFinEN, 200) },
    surface,
    surfaceText: {
      fr: readString(p.DescriptionEtatChausseeFR, 80),
      en: readString(p.DescriptionEtatChausseeEN, 80),
    },
    // Unknown surface code: unknown, never "bare" nor "winter".
    winter: surface === null ? null : !BARE_CODES.includes(surface),
    visibility,
    since: readLocalTime(p.EnVigueurDepuis),
    lines,
  };
}

const READERS = { [LAYERS.WORKS]: readWork, [LAYERS.CONDITIONS]: readCondition };

/**
 * A layer answer: `{ items, skipped, raw }`; `{ unreadable }` when more than
 * half of its features cannot be read (never "nothing"); `{ incomplete }`
 * when the server matched more features than it sent; `null` when the
 * envelope is not a GeoJSON FeatureCollection (an error, an HTML page...).
 */
export function readLayer(layer, json) {
  const read = READERS[layer];
  if (!read || !json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.type !== 'FeatureCollection' || !Array.isArray(json.features)) return null;
  if (json.features.length > MAX_FEATURES) return { incomplete: true };
  // A count from the server larger than the list: a cut answer, never a count.
  if (
    json.numberMatched !== undefined &&
    !(Number.isInteger(json.numberMatched) && json.numberMatched === json.features.length)
  ) {
    return { incomplete: true };
  }
  const items = [];
  const ids = new Set();
  let skipped = 0;
  for (const raw of json.features) {
    const item = read(raw);
    if (!item) skipped += 1;
    else if (!ids.has(item.id)) {
      ids.add(item.id);
      items.push(item);
    }
  }
  if (json.features.length > 0 && skipped * 2 > json.features.length) {
    return { unreadable: true, skipped, raw: json.features.length };
  }
  return { items, skipped, raw: json.features.length };
}

/** Whether a work is in effect at `at` (server time); unknown = in effect. */
export function inEffect(work, at) {
  if (at === null) return true;
  if (work.start !== null && work.start > at) return false;
  if (work.end !== null && work.end <= at) return false;
  return true;
}
