import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, readNumber, readRoads } from '../src/config.js';
import { configErrors } from '../src/i18n.js';

test('numbers are strict: blank is absent (never 0), only plain decimals', () => {
  assert.equal(readNumber(''), null);
  assert.equal(readNumber('   '), null);
  assert.equal(readNumber(null), null);
  assert.equal(readNumber(undefined), null);
  assert.equal(readNumber(' 49.2827 '), 49.2827);
  assert.equal(readNumber('-123.1'), -123.1);
  assert.equal(readNumber(12), 12);
  for (const bad of ['1e3', '0x10', '12,5', 'abc', '1.2.3', Infinity, NaN, true, {}]) {
    assert.ok(Number.isNaN(readNumber(bad)), String(bad));
  }
});

test('zone 1 is required; an empty zone 2 or 3 is off; a half-filled one is an error', () => {
  const none = normalizeConfig({});
  assert.deepEqual(none.zones, []);
  assert.deepEqual(none.errors, [{ slot: 1, field: 'zone1_latitude', code: 'required' }]);

  const config = normalizeConfig({
    zone1_latitude: '45.50',
    zone1_longitude: '-73.56',
    zone2_latitude: '46.8',
  });
  assert.deepEqual(
    config.zones.map((z) => z.slot),
    [1],
  );
  assert.deepEqual(config.errors, [{ slot: 2, field: 'zone2_longitude', code: 'required' }]);
  assert.equal(config.zones[0].radiusKm, 20, 'default radius');
  assert.equal(config.refreshMinutes, 15);
  assert.equal(config.language, 'fr');
});

test('a zone outside Québec, a radius out of bounds, a bad interval are refused', () => {
  const config = normalizeConfig({
    zone1_latitude: 48.85,
    zone1_longitude: 2.35,
    zone2_latitude: 46.8,
    zone2_longitude: -71.2,
    zone2_radius_km: 301,
    zone3_latitude: 46.8,
    zone3_longitude: -71.2,
    zone3_radius_km: '0',
    refresh_minutes: '14',
    language: 'de',
  });
  assert.deepEqual(config.zones, []);
  assert.deepEqual(
    config.errors.map((e) => `${e.field}:${e.code}`),
    [
      'refresh_minutes:refresh',
      'zone1_latitude:outside_qc',
      'zone2_radius_km:radius',
      'zone3_radius_km:radius',
    ],
  );
  assert.equal(config.refreshMinutes, 15, 'the default is used');
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ refresh_minutes: 15.5 }).errors[0].code, 'refresh');
  assert.equal(normalizeConfig({ refresh_minutes: 121 }).errors[0].code, 'refresh');
  assert.equal(normalizeConfig({ refresh_minutes: 120 }).refreshMinutes, 120);
  assert.equal(normalizeConfig({ refresh_minutes: '15' }).refreshMinutes, 15);
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  // Vancouver, Toronto, Paris: outside; Gaspé, Kuujjuaq: inside.
  for (const [lat, lon, ok] of [
    [49.28, -123.12, false],
    [43.65, -79.38, false],
    [48.85, 2.35, false],
    [48.83, -64.48, true],
    [58.1, -68.4, true],
  ]) {
    const c = normalizeConfig({ zone1_latitude: lat, zone1_longitude: lon });
    assert.equal(c.zones.length === 1, ok, `${lat},${lon}`);
  }
});

test('routes: numbers, with or without A-/R-/autoroute/route, unique, bounded', () => {
  assert.deepEqual(readRoads(' 20 ; A-40,a40, R-117 ,route 117, autoroute 15,Rte. 132, 20, '), {
    roads: [20, 40, 117, 15, 132],
  });
  assert.deepEqual(readRoads(''), { roads: [] });
  assert.deepEqual(readRoads(Array.from({ length: 11 }, (_, i) => `${i + 1}`).join(',')), {
    error: 'roads_too_many',
  });
  for (const bad of ['Highway 1 West', 'chemin du Lac', '0', '12345', '20\r\nX: y', '-20']) {
    assert.deepEqual(readRoads(bad), { error: 'roads_invalid' }, bad);
  }
});

test('a name with a control byte or over 60 characters is refused', () => {
  const base = { zone1_latitude: 45.5, zone1_longitude: -73.5 };
  assert.equal(
    normalizeConfig({ ...base, zone1_name: 'Home\u0007' }).errors[0].code,
    'name_invalid',
  );
  assert.equal(
    normalizeConfig({ ...base, zone1_name: 'é'.repeat(61) }).errors[0].code,
    'name_invalid',
  );
  assert.equal(
    normalizeConfig({ ...base, zone1_name: 'é'.repeat(60) }).zones[0].name,
    'é'.repeat(60),
  );
  assert.equal(normalizeConfig({ ...base, zone1_name: '  ' }).zones[0].name, null);
});

test('an error names the field, never the value typed (the user home)', () => {
  const config = normalizeConfig({ zone1_latitude: '47.123456', zone1_longitude: '-123.987654' });
  assert.equal(config.errors[0].code, 'outside_qc');
  const text = JSON.stringify(configErrors(config.errors));
  assert.match(text, /zone1_latitude/);
  assert.doesNotMatch(text, /47\.123456|123\.987654/);
});
