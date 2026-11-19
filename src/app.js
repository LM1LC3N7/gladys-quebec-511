// -----------------------------------------------------------------------------
// The integration: reads the road works and the winter road conditions of the
// Québec ministry of transport (MTMD) around the watch zones at the chosen
// interval, publishes what each zone sees, fires the "new road works" scene
// trigger, and tells in the status exactly where each zone stands.
//
// Pace and courtesy toward the source:
//   - two requests per round (one per layer, the box holding every zone), one
//     at a time, 5 s at least between the starts of two;
//   - the read period is measured from the start of a round, never shorter
//     than the interval (15 min at least): neither a restart (the time of the
//     last attempt is in /data, written before the round), nor a
//     reconnection, a saved but unchanged configuration, Discovery or the test
//     button reads sooner;
//   - a 429, a 5xx or another unexpected status pauses every read (bounded,
//     doubled, kept in /data).
//
// Each layer stands alone: a layer that fails leaves its own features
// unpublished (never 0) and the other layer is still published.
//
// Clocks: the decisions (gap, pause, period) use the monotonic clock, read
// once per decision; the wall clock serves only /data (restart) and the times
// shown. Whether a work is in effect, or new, is judged against the `Date`
// header of the answer, never against the local clock.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  CONFIG_RETRY_FIRST,
  CONFIG_RETRY_MAX,
  FEATURES,
  FRESH_EVENT,
  LAYERS,
  MINUTE,
  PAUSE_429_FIRST,
  PAUSE_5XX_FIRST,
  PAUSE_MAX,
  PAUSE_MIN,
  REFRESH_MIN,
  REQUEST_GAP,
  SCENE_EVENTS_PER_READ,
  SCENE_TEXT_MAX,
  SCENE_TRIGGER,
  SECOND,
  SEEN_KEEP,
  SEEN_MAX,
  STALE_AFTER,
} from './constants.js';
import { normalizeConfig } from './config.js';
import { buildDevices, zoneIds } from './devices.js';
import { boundingBox, unionBox } from './geo.js';
import { M, configErrors, failure, formatTime, zoneLabel } from './i18n.js';
import { getJson, layerUrl, readLayer } from './wfs.js';
import { createFileStore } from './store.js';
import { matchConditions, matchWorks, summary, winterCount, workCounts } from './zone.js';

const SAVE_BOUND = 2 * SECOND;
const STATUS_MAX = 1500;
const LANGS = ['en', 'fr'];

const isTime = (value) => Number.isFinite(value) && value > 0;
/** The answers that pause every read: 429, 5xx, other unexpected statuses. */
const PAUSING = ['rate', 'server', 'http'];
/** A server `Date` further than this from the local clock is not believed. */
const DATE_SANITY = 24 * 60 * MINUTE;
/** A local clock before this is not believed (a device that lost its time). */
const LOCAL_FLOOR = Date.UTC(2026, 10, 1);
/** /data unreadable at start: read again on its own timer, bounded. */
const RELOAD_EVERY = 10 * SECOND;
const LOAD_BOUND = 2 * SECOND;
const NO_PAUSE = () => ({
  until: null,
  kind: null,
  status: null,
  level429: 0,
  level5xx: 0,
  levelHttp: 0,
});

export class Quebec511App {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    wfsBase,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.wfsBase = wfsBase;

    /** Bumped by every start and stop: an older round goes quiet. */
    this.gen = 0;
    /** Bumped by every connection and disconnection (config retry loop). */
    this.connGen = 0;
    this.config = null;
    this.cycleTimer = null;
    this.reloadTimer = null;
    this.abortInflight = null;
    this.sleeps = new Set();
    this.pendingStart = undefined;
    this.starting = null;

    this.lastRequestMono = -Infinity;
    this.inflight = null;
    this.pauseUntilMono = null;
    this.nextDueMono = null;
    this.zoneResults = new Map();
    this.lastStatus = null;
    this.lastFingerprints = null;

    this.loaded = false;
    this.storeStatus = 'absent';
    this.persisted = { zones: {} };

    /** The start of the process, and the last round started in it. */
    this.startMono = this.monotonic();
    this.lastAttemptMono = null;
    /** Whether /data tells the last attempt (null: not known yet). */
    this.dataTells = null;
    this.saveFailed = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * A connection to Gladys: read the configuration, then start. A failing
   * `getConfig()` is retried forever, spaced out (5 s doubled up to 5 min),
   * with the status saying so.
   */
  async connected() {
    const conn = ++this.connGen;
    // A new connection: Gladys gets the status again, even unchanged.
    this.lastStatus = null;
    let delay = CONFIG_RETRY_FIRST;
    for (;;) {
      let raw;
      try {
        raw = await this.gladys.getConfig();
      } catch (err) {
        if (conn !== this.connGen) return;
        this.logger.warn(
          `Configuration not read (${err?.name ?? 'Error'}); retry in ${delay / SECOND} s`,
        );
        await this.setStatus(
          false,
          M.configRetry({ seconds: Math.round(delay / SECOND) }),
          this.gen,
        );
        await this.sleep(delay);
        if (conn !== this.connGen) return;
        delay = Math.min(delay * 2, CONFIG_RETRY_MAX);
        continue;
      }
      if (conn !== this.connGen) return;
      await this.start(raw);
      return;
    }
  }

  async disconnected() {
    this.connGen += 1;
    await this.stop();
  }

  /**
   * Apply a configuration. Configurations saved in a row apply one after the
   * other, the last one winning: a start asked while one runs is kept and
   * applied next (only the latest of them).
   */
  start(raw) {
    this.pendingStart = { raw };
    if (!this.starting) {
      this.starting = (async () => {
        try {
          while (this.pendingStart) {
            const { raw: next } = this.pendingStart;
            this.pendingStart = undefined;
            await this.applyConfig(next);
          }
        } finally {
          this.starting = null;
        }
      })();
    }
    return this.starting;
  }

  async stop() {
    this.gen += 1;
    this.cancelTimers();
    this.abortInflight?.abort();
    await this.persist();
  }

  /** Waits for the start in progress and the request in flight (tests). */
  async idle() {
    while (this.starting || this.inflight) {
      await this.starting;
      await this.inflight;
    }
  }

  cancelTimers() {
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    if (this.reloadTimer) this.timers.clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    for (const sleep of this.sleeps) {
      this.timers.clearTimeout(sleep.timer);
      sleep.resolve();
    }
    this.sleeps.clear();
  }

  /** A wait on the injected timers, released at once by a stop. */
  sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.timer = this.timers.setTimeout(
        () => {
          this.sleeps.delete(entry);
          resolve();
        },
        Math.max(0, ms),
      );
      this.sleeps.add(entry);
    });
  }

  async applyConfig(raw) {
    this.gen += 1;
    const gen = this.gen;
    this.cancelTimers();
    const config = normalizeConfig(raw);
    this.config = config;
    await this.load();
    if (gen !== this.gen) return;
    this.armReload();
    for (const error of config.errors) {
      this.logger.warn(`Configuration: field ${error.field} refused (${error.code})`);
    }
    await this.publishDevices(gen);
    if (gen !== this.gen) return;
    if (config.zones.length === 0) {
      const errors = configErrors(config.errors);
      await this.setStatus(
        false,
        { en: `${M.noZone.en} ${errors.en}`.trim(), fr: `${M.noZone.fr} ${errors.fr}`.trim() },
        gen,
      );
      return;
    }
    // Forget the zones that are gone or moved; keep what the others saw.
    const fingerprints = new Map(config.zones.map((zone) => [zone.slot, this.fingerprint(zone)]));
    for (const slot of this.zoneResults.keys()) {
      if (this.zoneResults.get(slot).fingerprint !== fingerprints.get(slot)) {
        this.zoneResults.delete(slot);
      }
    }
    if (this.dataTells === null) await this.checkData();
    if (gen !== this.gen) return;
    const changed =
      this.lastFingerprints !== null &&
      JSON.stringify([...fingerprints]) !== JSON.stringify([...this.lastFingerprints]);
    this.lastFingerprints = fingerprints;

    // When is the first round due? One clock read for the decision.
    const wall = this.now();
    const mono = this.monotonic();
    const interval = config.refreshMinutes * MINUTE;
    let wait = 0;
    const last = this.persisted.lastAttemptAt;
    if (!changed) {
      if (this.lastAttemptMono !== null) {
        // A round already ran in this process: its monotonic time decides.
        wait = Math.max(0, this.lastAttemptMono + interval - mono);
      } else if (!this.dataTells) {
        // /data cannot tell the last attempt (unreadable, not writable, a
        // date in the future): a restart never reads at once.
        wait = Math.max(0, this.startMono + REFRESH_MIN * MINUTE - mono);
      } else if (isTime(last)) {
        wait = Math.max(0, last + interval - wall);
      }
    }
    const pause = this.persisted.pause;
    if (pause && isTime(pause.until) && pause.until > wall && pause.until - wall <= PAUSE_MAX) {
      const left = pause.until - wall;
      if (this.pauseUntilMono === null || this.pauseUntilMono < mono + left) {
        this.pauseUntilMono = mono + left;
      }
    }
    if (this.pauseUntilMono !== null && this.pauseUntilMono > mono) {
      wait = Math.max(wait, this.pauseUntilMono - mono);
    }
    this.nextDueMono = mono + wait;
    await this.updateStatus(gen);
    if (gen !== this.gen) return;
    this.scheduleCycle(wait, gen);
  }

  /**
   * Whether /data tells when the source was last read: readable, with no date in
   * the future, and writable (checked by writing it back before any read).
   */
  async checkData() {
    const last = this.persisted.lastAttemptAt;
    if (this.storeStatus === 'unreadable') this.dataTells = false;
    else if (isTime(last) && last > this.now()) {
      this.logger.warn('The last attempt in /data is in the future: not believed');
      this.dataTells = false;
    } else {
      // Readable is not enough: a /data that cannot be written (read-only,
      // frozen) would keep an old attempt time and let every restart read.
      this.dataTells = await this.persist();
      if (!this.dataTells) this.saveFailed = true;
    }
  }

  scheduleCycle(delay, gen) {
    if (gen !== this.gen) return;
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = this.timers.setTimeout(
      () => {
        this.cycleTimer = null;
        this.runCycle(gen).catch((err) =>
          this.logger.error(`Read failed (${err?.name ?? 'Error'})`),
        );
      },
      Math.max(0, delay),
    );
  }

  /** Reads /data once per process (bounded); an unreadable file is read again every 10 s. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const result = await this.readStore();
    this.storeStatus = result.status;
    if (result.status === 'unreadable') {
      this.logger.warn(
        'The state file of /data is unreadable: left untouched, running from memory',
      );
    }
    this.persisted = parseState(result.data ?? {});
  }

  /** One read of /data, never waiting more than LOAD_BOUND for it. */
  async readStore() {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ status: 'unreadable', data: {} }), LOAD_BOUND);
    });
    try {
      const read =
        typeof this.store.loadAsync === 'function'
          ? this.store.loadAsync()
          : Promise.resolve().then(() => this.store.load());
      return await Promise.race([read, late]);
    } catch {
      return { status: 'unreadable', data: {} };
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /**
   * While /data is unreadable, one read every 10 s on its own timer. Once it
   * reads again, what it holds comes back (pause, works seen, salt), the
   * latest attempt and the longest pause winning over what memory holds.
   */
  armReload() {
    if (this.reloadTimer || this.storeStatus !== 'unreadable') return;
    const gen = this.gen;
    this.reloadTimer = this.timers.setTimeout(async () => {
      this.reloadTimer = null;
      const result = await this.readStore();
      if (gen !== this.gen) return;
      if (result.status === 'unreadable') {
        this.armReload();
        return;
      }
      const restored = parseState(result.data ?? {});
      const memory = this.persisted;
      if (isTime(memory.lastAttemptAt) && !(restored.lastAttemptAt >= memory.lastAttemptAt)) {
        restored.lastAttemptAt = memory.lastAttemptAt;
      }
      if (memory.pause && !(restored.pause?.until >= (memory.pause.until ?? 0))) {
        restored.pause = memory.pause;
      }
      const wall = this.now();
      const until = restored.pause?.until;
      if (isTime(until) && until > wall && until - wall <= PAUSE_MAX) {
        const mono = this.monotonic();
        if (this.pauseUntilMono === null || this.pauseUntilMono < mono + (until - wall)) {
          this.pauseUntilMono = mono + (until - wall);
        }
      }
      this.storeStatus = result.status;
      this.persisted = restored;
      this.logger.info('The state file of /data reads again');
      await this.persist();
      if (gen !== this.gen) return;
      await this.updateStatus(gen);
    }, RELOAD_EVERY);
  }

  /** A salted fingerprint of the zone: never its coordinates in clear. */
  fingerprint(zone) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.persisted.salt ?? '',
          zone.latitude,
          zone.longitude,
          zone.radiusKm,
          zone.roads,
        ]),
      )
      .digest('hex')
      .slice(0, 32);
  }

  /** Saves /data without ever waiting more than SAVE_BOUND for it. */
  async persist() {
    if (!this.loaded || this.storeStatus === 'unreadable') return false;
    let timer;
    const bound = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('late'), SAVE_BOUND);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(this.store.save(this.persisted)).then(() => 'saved'),
        bound,
      ]);
      if (outcome === 'late') this.logger.warn('Saving /data is slow: going on without waiting');
      return outcome === 'saved';
    } catch (err) {
      this.logger.warn(`Saving /data failed (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  // --- Discovery, actions ----------------------------------------------------

  async publishDevices(gen = this.gen) {
    const config = this.config ?? normalizeConfig(this.gladys.config);
    try {
      if (gen !== this.gen) return;
      await this.gladys.publishDiscoveredDevices(buildDevices(this.gladys, config));
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the zones of the configuration, never a read. */
  scan() {
    return this.publishDevices();
  }

  /**
   * The test button: what the last read of each zone gave and when the next
   * one comes. It never reads (the interval and the gap hold for it too).
   */
  testConnection() {
    const status = this.composeStatus();
    return status.message;
  }

  // --- The read round --------------------------------------------------------

  async runCycle(gen) {
    if (gen !== this.gen) return;
    // A timer may fire a little before the end of a pause: armed again for
    // what is left, the round is never skipped for it.
    // The same for the interval itself: never a round before it is due.
    const mono0 = this.monotonic();
    const left = Math.max(this.pausedFor(mono0), (this.nextDueMono ?? mono0) - mono0);
    if (left > 0) {
      this.nextDueMono = mono0 + left;
      this.scheduleCycle(left + 5, gen);
      return;
    }
    await this.round(gen);
  }

  /** One round: both layers, one request at a time, then every zone. */
  async round(gen) {
    const config = this.config;
    const start = this.monotonic();
    this.lastAttemptMono = start;
    this.nextDueMono = start + config.refreshMinutes * MINUTE;
    // The time of the attempt is in /data before the first request.
    this.persisted.lastAttemptAt = this.now();
    const saved = await this.persist();
    this.saveFailed = !saved && this.storeStatus !== 'unreadable';
    if (gen !== this.gen) return;
    const box = unionBox(config.zones.map(boundingBox));
    const layers = {};
    for (const [key, layer] of [
      ['works', LAYERS.WORKS],
      ['conditions', LAYERS.CONDITIONS],
    ]) {
      if (this.pausedFor() > 0) {
        layers[key] = { ok: false, kind: 'paused' };
        continue;
      }
      const result = await this.readLayerOnce(layer, box, gen);
      // A refusal of the source pauses the reads even when the configuration
      // changed or Gladys reconnected while the request was out.
      if (!result.ok && PAUSING.includes(result.kind)) {
        this.startPause(result);
        if (gen !== this.gen) {
          await this.persist();
          return;
        }
      }
      if (gen !== this.gen) return;
      if (result.ok) {
        result.at = this.referenceTime(result.at);
        // A success lifts the pauses.
        this.pauseUntilMono = null;
        if (this.persisted.pause) this.persisted.pause = NO_PAUSE();
      } else if (result.kind !== 'stopped') {
        this.logger.warn(
          `Layer ${key}: read failed (${result.kind}${result.status ? ` ${result.status}` : ''})`,
        );
      }
      // Without a time to judge "in effect" on, the works are not counted at all
      // (never every listed work, never 0): said in the status.
      layers[key] =
        result.ok && key === 'works' && result.at === null
          ? { ok: false, kind: 'no_time' }
          : result;
    }
    for (const zone of config.zones) {
      await this.onZoneRead(zone, layers, gen);
      if (gen !== this.gen) return;
    }
    // The next round is armed before /data and the status: neither a slow
    // save nor a slow Gladys holds it back.
    const mono = this.monotonic();
    let delay = Math.max(0, this.nextDueMono - mono);
    if (this.pauseUntilMono !== null && this.pauseUntilMono > mono) {
      delay = Math.max(delay, this.pauseUntilMono - mono);
      this.nextDueMono = mono + delay;
    }
    this.scheduleCycle(delay, gen);
    const savedAfter = await this.persist();
    if (this.storeStatus !== 'unreadable') this.saveFailed = this.saveFailed || !savedAfter;
    if (gen !== this.gen) return;
    await this.updateStatus(gen);
  }

  /**
   * The time "in effect" is judged on: the server `Date` when it agrees with
   * the local clock within a day; without a `Date`, the local clock when it is
   * plausible; otherwise `null` (one of the two clocks is wrong, which one is
   * unknown).
   */
  referenceTime(at) {
    const local = this.now();
    if (at !== null) {
      if (Math.abs(at - local) <= DATE_SANITY) return at;
      this.logger.warn(
        'The Date of the MTMD answer is more than a day off the local clock: works not counted',
      );
      return null;
    }
    if (local >= LOCAL_FLOOR) return local;
    this.logger.warn(
      'No Date in the MTMD answer and the local clock is not plausible: works not counted',
    );
    return null;
  }

  /** The pause left, in ms (0 when none). */
  pausedFor(mono = this.monotonic()) {
    if (this.pauseUntilMono === null) return 0;
    return Math.max(0, this.pauseUntilMono - mono);
  }

  /**
   * One request, when its turn comes: after the one in flight, 5 s after
   * the start of the previous one. `null` when stopped meanwhile.
   */
  async request(url, gen) {
    for (;;) {
      if (gen !== this.gen) return null;
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      const wait = this.lastRequestMono + REQUEST_GAP - this.monotonic();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      break;
    }
    // A pause started meanwhile (a late 429 of an older round) holds this one.
    if (this.pausedFor() > 0) return { ok: false, kind: 'paused' };
    this.lastRequestMono = this.monotonic();
    const abort = new AbortController();
    this.abortInflight = abort;
    const job = getJson(url, {
      fetchImpl: this.fetchImpl,
      timers: this.timers,
      signal: abort.signal,
    });
    this.inflight = job.then(
      () => {},
      () => {},
    );
    try {
      return await job;
    } finally {
      this.inflight = null;
    }
  }

  /** One layer in the box of the zones: `{ ok, items, at, skipped }` or a failure. */
  async readLayerOnce(layer, box, gen) {
    const answer = await this.request(layerUrl(layer, box, this.wfsBase), gen);
    if (answer === null) return { ok: false, kind: 'stopped' };
    if (!answer.ok) return answer;
    const read = readLayer(layer, answer.json);
    if (!read) return { ok: false, kind: 'format', status: 200 };
    if (read.incomplete) return { ok: false, kind: 'incomplete' };
    // Features the source sends but that cannot be read: said as such,
    // nothing published, no pause (the source answered; its format may have changed).
    if (read.unreadable) return { ok: false, kind: 'unreadable_events' };
    if (read.skipped > 0) {
      this.logger.info(`Layer ${layer}: ${read.skipped} feature(s) without id or place ignored`);
    }
    return { ok: true, items: read.items, at: answer.serverDate, skipped: read.skipped };
  }

  /** What a zone sees: each layer on its own, nothing published for a failed one. */
  async onZoneRead(zone, layers, gen) {
    const language = this.config.language;
    const fingerprint = this.fingerprint(zone);
    const before = this.zoneResults.get(zone.slot);
    const kept = before && before.fingerprint === fingerprint ? before : null;
    const wall = this.now();
    const mono = this.monotonic();
    const record = (key, result, value) => {
      const previous = kept?.[key];
      if (result.ok) return { ok: true, readAt: wall, readMono: mono, ...value };
      return {
        ok: false,
        failure: { kind: result.kind, status: result.status },
        lastOkAt: previous?.ok ? previous.readAt : (previous?.lastOkAt ?? null),
        lastOkMono: previous?.ok ? previous.readMono : (previous?.lastOkMono ?? null),
      };
    };
    const works = layers.works.ok ? matchWorks(zone, layers.works.items, layers.works.at) : null;
    const conditions = layers.conditions.ok ? matchConditions(zone, layers.conditions.items) : null;
    const counts = works ? workCounts(works) : null;
    const winter = conditions ? winterCount(conditions) : null;
    this.zoneResults.set(zone.slot, {
      fingerprint,
      works: record('works', layers.works, { counts }),
      conditions: record('conditions', layers.conditions, { winter }),
    });
    const ids = zoneIds(this.gladys, zone.slot);
    const states = [];
    if (counts) {
      states.push(
        { device_feature_external_id: ids.feature(FEATURES.WORKS), state: counts.works },
        { device_feature_external_id: ids.feature(FEATURES.MAJOR), state: counts.major },
      );
    }
    if (winter !== null) {
      states.push({ device_feature_external_id: ids.feature(FEATURES.WINTER), state: winter });
    }
    // The summary follows what was read: a failed layer is said in it.
    if (works || conditions) {
      states.push({
        device_feature_external_id: ids.feature(FEATURES.SUMMARY),
        text: summary(works, conditions, language),
      });
    }
    const created = this.gladys.devices?.some((device) => device.external_id === ids.device);
    if (created && states.length > 0) {
      try {
        await this.gladys.publishStates(states);
      } catch (err) {
        this.logger.warn(`Zone ${zone.slot}: values not published (${err?.name ?? 'Error'})`);
      }
    }
    if (gen !== this.gen || !works) return;
    await this.announceNew(zone, works, layers.works.at, gen);
  }

  /**
   * The scene trigger: road works seen for the first time in this zone, in
   * effect, started or updated within 24 h of the server time. The first read
   * of a zone (or of a moved zone, or after an unreadable /data) only learns
   * what is there.
   */
  async announceNew(zone, matches, at, gen) {
    const fingerprint = this.fingerprint(zone);
    const wall = this.now();
    const previous = this.persisted.zones[zone.slot];
    const baseline = !previous || previous.fingerprint !== fingerprint;
    // A Map: an id such as "constructor" or "__proto__" is an id like any other.
    const seen = new Map(baseline ? [] : Object.entries(previous.seen));
    const fresh = [];
    if (!baseline && at !== null) {
      for (const match of matches) {
        if (seen.has(match.work.id)) continue;
        const { work } = match;
        const times = [work.start, work.updated].filter((v) => v !== null && v <= at + 5 * MINUTE);
        const latest = times.length > 0 ? Math.max(...times) : null;
        if (latest !== null && at - latest <= FRESH_EVENT) fresh.push(match);
      }
    }
    // Past 20 new works in one read, the others stay unseen: announced by the
    // next read (when still fresh), never dropped.
    const held = new Set(fresh.slice(SCENE_EVENTS_PER_READ).map((m) => m.work.id));
    for (const match of matches) if (!held.has(match.work.id)) seen.set(match.work.id, wall);
    // Bounded: entries not seen for 14 days go, then the oldest past SEEN_MAX.
    const kept = [...seen]
      .filter(([, when]) => wall - when <= SEEN_KEEP)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_MAX);
    this.persisted.zones[zone.slot] = { fingerprint, seen: Object.fromEntries(kept) };
    const device = zoneIds(this.gladys, zone.slot).device;
    for (const match of fresh.slice(0, SCENE_EVENTS_PER_READ)) {
      if (gen !== this.gen) return;
      try {
        await this.gladys.publishSceneEvent(SCENE_TRIGGER, sceneData(device, match));
      } catch (err) {
        this.logger.warn(`Zone ${zone.slot}: scene event not sent (${err?.name ?? 'Error'})`);
      }
    }
  }

  startPause(result) {
    const pause = this.persisted.pause ?? NO_PAUSE();
    let duration;
    if (result.kind === 'rate') {
      pause.level429 = Math.min(pause.level429 + 1, 30);
      duration = PAUSE_429_FIRST * 2 ** (pause.level429 - 1);
    } else if (result.kind === 'server') {
      pause.level5xx = Math.min(pause.level5xx + 1, 30);
      duration = PAUSE_5XX_FIRST * 2 ** (pause.level5xx - 1);
    } else {
      // 400, 403, 404...: spaced out like a server error.
      pause.levelHttp = Math.min(pause.levelHttp + 1, 30);
      duration = PAUSE_5XX_FIRST * 2 ** (pause.levelHttp - 1);
    }
    pause.kind = result.kind;
    pause.status = Number.isInteger(result.status) ? result.status : null;
    if (Number.isFinite(result.retryAfter) && result.retryAfter > duration)
      duration = result.retryAfter;
    duration = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, duration));
    const mono = this.monotonic();
    this.pauseUntilMono = Math.max(this.pauseUntilMono ?? 0, mono + duration);
    pause.until = this.now() + (this.pauseUntilMono - mono);
    this.persisted.pause = pause;
  }

  // --- Status ----------------------------------------------------------------

  composeStatus() {
    const config = this.config;
    const lines = { en: [], fr: [] };
    const push = (en, fr) => {
      lines.en.push(en);
      lines.fr.push(fr);
    };
    const mono = this.monotonic();
    const wall = this.now();
    const toWall = (m) => wall + (m - mono);
    let anyOk = false;
    if (!config) return { connected: false, message: M.starting };
    const paused = this.pausedFor(mono);
    if (paused > 0) {
      const kind = this.persisted.pause?.kind ?? 'rate';
      const status = this.persisted.pause?.status ?? null;
      push(
        `${failure(kind, status, 'en')}: reads paused until ${formatTime(wall + paused, 'en')}.`,
        `${failure(kind, status, 'fr')} : lectures en pause jusqu'à ${formatTime(wall + paused, 'fr')}.`,
      );
    }
    const why = (layer) =>
      layer.failure.kind === 'paused'
        ? { en: 'not read (pause)', fr: 'non lus (pause)' }
        : {
            en: failure(layer.failure.kind, layer.failure.status, 'en'),
            fr: failure(layer.failure.kind, layer.failure.status, 'fr'),
          };
    const since = (layer) =>
      layer.lastOkAt !== null
        ? {
            en: `, last data ${formatTime(layer.lastOkAt, 'en')}${mono - layer.lastOkMono > STALE_AFTER ? ', stale' : ''}, nothing published since`,
            fr: `, dernières données ${formatTime(layer.lastOkAt, 'fr')}${mono - layer.lastOkMono > STALE_AFTER ? ', périmées' : ''}, rien publié depuis`,
          }
        : { en: ', no data yet', fr: ', pas encore de données' };
    for (const zone of config.zones) {
      const name = { en: zoneLabel(zone, 'en'), fr: zoneLabel(zone, 'fr') };
      const result = this.zoneResults.get(zone.slot);
      if (!result) {
        push(`${name.en}: no read yet.`, `${name.fr} : pas encore lue.`);
        continue;
      }
      const parts = { en: [], fr: [] };
      const { works, conditions } = result;
      if (works.ok) {
        const stale = mono - works.readMono > STALE_AFTER;
        if (!stale) anyOk = true;
        const c = works.counts;
        parts.en.push(
          `${c.works} road work(s), ${c.major} major, read ${formatTime(works.readAt, 'en')}${stale ? ' (stale, over 2 h)' : ''}`,
        );
        parts.fr.push(
          `${c.works} chantier(s), ${c.major} entrave(s) majeure(s), lu ${formatTime(works.readAt, 'fr')}${stale ? ' (périmé, plus de 2 h)' : ''}`,
        );
      } else {
        const w = why(works);
        const s = since(works);
        parts.en.push(`road works: ${w.en}${s.en}`);
        parts.fr.push(`travaux : ${w.fr}${s.fr}`);
      }
      if (conditions.ok) {
        const stale = mono - conditions.readMono > STALE_AFTER;
        if (!stale) anyOk = true;
        parts.en.push(
          `${conditions.winter} segment(s) in winter conditions${stale ? ' (stale, over 2 h)' : ''}`,
        );
        parts.fr.push(
          `${conditions.winter} tronçon(s) en conditions hivernales${stale ? ' (périmé, plus de 2 h)' : ''}`,
        );
      } else {
        const w = why(conditions);
        const s = since(conditions);
        parts.en.push(`winter conditions: ${w.en}${s.en}`);
        parts.fr.push(`conditions hivernales : ${w.fr}${s.fr}`);
      }
      push(`${name.en}: ${parts.en.join('; ')}.`, `${name.fr} : ${parts.fr.join(' ; ')}.`);
    }
    if (this.nextDueMono !== null) {
      push(
        `Next read ${formatTime(toWall(this.nextDueMono), 'en')}.`,
        `Prochaine lecture ${formatTime(toWall(this.nextDueMono), 'fr')}.`,
      );
    }
    if (config.errors.length > 0) {
      const errors = configErrors(config.errors);
      push(`Configuration: ${errors.en}.`, `Configuration : ${errors.fr}.`);
    }
    if (this.dataTells === false && this.lastAttemptMono === null) {
      push(
        '/data does not tell when the source was last read: the first read waits 15 min after the start.',
        '/data ne dit pas quand la source a été lue : la première lecture attend 15 min après le démarrage.',
      );
    }
    if (this.saveFailed) {
      push(
        'The time of the last read could not be written in /data: a restart may read sooner than the interval.',
        "L'heure de la dernière lecture n'a pas pu être écrite dans /data : un redémarrage peut lire plus tôt que l'intervalle.",
      );
    }
    if (this.storeStatus === 'unreadable') {
      push(
        'The state file of /data is unreadable: left untouched, the integration runs from memory.',
        "Le fichier d'état de /data est illisible : laissé tel quel, l'intégration tourne en mémoire.",
      );
    }
    const message = {};
    for (const lang of LANGS)
      message[lang] = [...lines[lang].join(' ')].slice(0, STATUS_MAX).join('');
    return { connected: anyOk, message };
  }

  async updateStatus(gen) {
    const { connected, message } = this.composeStatus();
    await this.setStatus(connected, message, gen);
  }

  async setStatus(connected, message, gen) {
    if (gen !== this.gen) return;
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not published (${err?.name ?? 'Error'})`);
    }
  }
}

/** The state of /data read strictly: anything unexpected is left out. */
function parseState(data) {
  const persisted = { zones: {} };
  if (isTime(data.lastAttemptAt)) persisted.lastAttemptAt = data.lastAttemptAt;
  if (data.pause && typeof data.pause === 'object') {
    const level = (n) => (Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0);
    persisted.pause = {
      until: isTime(data.pause.until) ? data.pause.until : null,
      kind: PAUSING.includes(data.pause.kind) ? data.pause.kind : 'rate',
      status:
        Number.isInteger(data.pause.status) && data.pause.status >= 100 && data.pause.status <= 599
          ? data.pause.status
          : null,
      level429: level(data.pause.level429),
      level5xx: level(data.pause.level5xx),
      levelHttp: level(data.pause.levelHttp),
    };
  }
  if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) persisted.salt = data.salt;
  else persisted.salt = randomBytes(16).toString('hex');
  if (data.zones && typeof data.zones === 'object') {
    for (const [slot, zone] of Object.entries(data.zones)) {
      if (!/^[1-3]$/.test(slot) || !zone || typeof zone.fingerprint !== 'string') continue;
      // No prototype: an id "__proto__" is a key like any other.
      const seen = Object.create(null);
      if (zone.seen && typeof zone.seen === 'object') {
        for (const [id, at] of Object.entries(zone.seen).slice(0, SEEN_MAX)) {
          if (id.length <= 120 && isTime(at)) seen[id] = at;
        }
      }
      persisted.zones[slot] = { fingerprint: zone.fingerprint, seen };
    }
  }
  return persisted;
}

/** The flat data of the scene trigger (≤ 30 keys, texts bounded). */
export function sceneData(device, match) {
  const { work } = match;
  const text = (value) => [...String(value ?? '')].slice(0, SCENE_TEXT_MAX).join('');
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  return {
    device,
    works_id: text(work.id),
    route: work.route,
    major: work.major,
    severity: work.major ? 'major' : 'minor',
    restriction_type: text(work.type),
    title: text(work.title),
    title_en: text(work.titleEn),
    place: text(work.place),
    impact: text(work.impact),
    direction: text(work.direction),
    start: iso(work.start),
    end: iso(work.end),
    distance_km: Math.round(match.distanceKm * 10) / 10,
  };
}
