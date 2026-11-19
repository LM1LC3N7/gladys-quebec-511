// -----------------------------------------------------------------------------
// The fixed values of the integration: the WFS of the Québec ministry of
// transport (MTMD), its pace, the bounds of what is read, and the keys shared
// with the manifest.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The public WFS of the Ministère des Transports et de la Mobilité durable du
 * Québec, the source of the Données Québec datasets "Travaux routiers" and
 * "Condition routière hivernale du réseau routier" (CC BY 4.0), no key.
 */
export const WFS_BASE = 'https://ws.mapserver.transports.gouv.qc.ca/swtq';

/** The two layers read (WFS type names). */
export const LAYERS = Object.freeze({
  WORKS: 'ms:chantiers_mtmdet',
  CONDITIONS: 'ms:conditions_routieres',
});

/** An honest User-Agent naming the integration, never a browser's. */
export const USER_AGENT = `gladys-quebec-511/${pkg.version} (+https://github.com/LM1LC3N7/gladys-quebec-511)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** The WFS publishes no rate limit: one request at a time, 5 s between two starts. */
export const REQUEST_GAP = 5 * SECOND;
/** One request never lasts longer (connection, answer and body). */
export const REQUEST_TIMEOUT = 30 * SECOND;
/** A body larger than this is cut before it is read in full (the whole province is ~1.3 MB). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Features read per layer: past this, the answer is refused (never a partial count). */
export const MAX_FEATURES = 5000;
/** Points read per geometry; the rest of a longer line is ignored. */
export const MAX_POINTS = 5000;

/** The read interval, in minutes (config `refresh_minutes`): 15 at least. */
export const REFRESH_DEFAULT = 15;
export const REFRESH_MIN = 15;
export const REFRESH_MAX = 120;

/** Pauses after a 429 (rate limit) and a 5xx, doubled each time, bounded. */
export const PAUSE_429_FIRST = 15 * MINUTE;
export const PAUSE_5XX_FIRST = 5 * MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;

/** `getConfig()` failing on a connection: retried forever, spaced out. */
export const CONFIG_RETRY_FIRST = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/** Road works that started or were updated longer ago are never announced as new. */
export const FRESH_EVENT = 24 * HOUR;
/** Zone data older than this is said stale in the status. */
export const STALE_AFTER = 2 * HOUR;
/** Work ids remembered per zone (scene trigger), and for how long. */
export const SEEN_MAX = 2000;
export const SEEN_KEEP = 14 * 24 * HOUR;
/** Scene events fired per zone and per read, at most. */
export const SCENE_EVENTS_PER_READ = 20;

/** Watch zones (one Gladys device each). */
export const ZONE_SLOTS = [1, 2, 3];
export const RADIUS_DEFAULT = 20;
export const RADIUS_MIN = 1;
export const RADIUS_MAX = 300;
export const ROADS_MAX = 10;
export const ZONE_NAME_MAX = 60;
/**
 * The envelope a zone center must be in: Québec and its borders (the layers
 * hold nothing elsewhere).
 */
export const QC_ENVELOPE = { minLat: 44.9, maxLat: 63, minLon: -80, maxLon: -57 };

/** Counts are bounded: never more than a layer can return. */
export const MAX_COUNT = MAX_FEATURES;
/** The summary text published on the zone device, in characters. */
export const SUMMARY_MAX = 600;
/** The texts handed to a scene (the core accepts 1000 characters). */
export const SCENE_TEXT_MAX = 900;

export const DEVICE_TYPE = 'zone';
export const FEATURES = Object.freeze({
  WORKS: 'works',
  MAJOR: 'major_works',
  WINTER: 'winter_segments',
  SUMMARY: 'summary',
});

export const ACTIONS = Object.freeze({ TEST: 'test' });
export const SCENE_TRIGGER = 'new_works';

/** Road surface codes of the data dictionary that mean a bare road. */
export const BARE_CODES = Object.freeze(['Ds', 'Dm']);
/** Every road surface code of the data dictionary (2026). */
export const SURFACE_CODES = Object.freeze(['Ds', 'Dm', 'PE', 'E', 'PCND', 'CND', 'PG', 'G']);
/** Visibility codes: B good, R reduced, N none. */
export const VISIBILITY_CODES = Object.freeze(['B', 'R', 'N']);

/** The time zone of the source: its dates carry no offset and are local to Québec. */
export const TIME_ZONE = 'America/Toronto';

export const STATE_FILE = '/data/quebec-511-state.json';
