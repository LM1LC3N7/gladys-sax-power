// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. And the devices
// only use the units the core accepts for their categories, never an index of
// the energy monitoring, and every supported_options they would publish
// follows the rules of the core.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, BATTERY_FIELDS, POLL_DEFAULT, POLL_MAX, POLL_MIN } from '../src/constants.js';
import { CATALOG, COUNTERS, buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

// The core's own validator of supported_options, when a Gladys clone is at hand
// (not on GitHub CI): the rules below are its schema, this is the proof.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const gladys = createFakeGladys({ selector: 'sax-power' });
const master = buildDevice(gladys, {
  id: 'sn1-2',
  address: 'x:502',
  master: true,
  field: 'battery_a',
});
const other = buildDevice(gladys, {
  id: 'sn1-3',
  address: 'y:502',
  master: false,
  field: 'battery_b',
});

test('the store basics; the same version everywhere (semver, never pinned by hand)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-sax-power:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-sax-power');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^/);
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.network_discovery, undefined, 'no network scan');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the docs say it was never tested with a real device', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+appareil/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+device/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
      assert.equal(typeof text[lang], 'string', `${path}.${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
  }
});

test('the configuration matches the code; no secret, no gladys_ key', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', ...BATTERY_FIELDS, 'poll_interval']);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/);
  assert.ok(!manifest.config_schema.some((f) => f.type === 'secret'), 'no secret');
  assert.equal(fields.battery_a.required, true);
  assert.equal(fields.battery_b.required, undefined);
  assert.equal(fields.poll_interval.default, POLL_DEFAULT);
  assert.equal(fields.poll_interval.min, POLL_MIN);
  assert.equal(fields.poll_interval.max, POLL_MAX);
  for (const link of fields.intro.links) {
    assert.match(link.url, /^https:\/\//);
  }
  assert.match(fields.intro.description.en, /Never tested with a real device/);
  assert.match(fields.intro.description.en, /Read-only/);
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(handlers.includes('onAction(ACTIONS.TEST'));
  assert.ok(handlers.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(handlers.includes("on('connected'"));
  assert.ok(!handlers.includes('onSetValue'), 'no command: read-only');
  assert.ok(!read('index.js').includes('onSetValue'));
  assert.match(manifest.actions[1].description.en, /First click: lists.*Second click/);
  // Only function 3 is ever built.
  assert.doesNotMatch(read('src/sax/registers.js'), /WRITE|0x06|0x10\b|FC\.WRITE/);
  assert.doesNotMatch(read('src/constants.js'), /WRITE/);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /sax_battery_ha/);
  assert.match(notices, /Apache License/);
});

test('the code never feeds the energy consumption endpoint, nor publishes a scene event', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js', 'src/handlers.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(|publishSceneEvent\(/, file);
  }
});

// The units the core accepts per category (server/utils/constants.js
// DEVICE_FEATURE_UNITS_BY_CATEGORY), for the categories used here.
const UNITS_BY_CATEGORY = {
  [C.BATTERY_STORAGE]: [U.PERCENT, U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.ENERGY_PRODUCTION_SENSOR]: [U.WATT, U.KILOWATT, U.WATT_HOUR, U.KILOWATT_HOUR],
  [C.TEMPERATURE_SENSOR]: [U.CELSIUS, U.FAHRENHEIT],
  [C.UNKNOWN]: [],
};

test('every feature uses a unit the core accepts for its category; keys unique; read-only', () => {
  const ext = (d) => d.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(ext(master).includes('system_soc'));
  assert.ok(!ext(other).includes('system_soc'), 'the system values on the master only');
  // A device created as master keeps its features when it is no longer the master.
  const kept = buildDevice(
    gladys,
    { id: 'sn1-2', address: 'x', master: false, field: 'battery_b' },
    { created: master },
  );
  assert.deepEqual(ext(kept), ext(master));
  assert.equal(master.external_id, 'ext:sax-power:battery:sn1-2');
  assert.equal(master.name, 'SAX Power Home (A, master)');
  assert.equal(other.name, 'SAX Power Home (B)');
  for (const device of [master, other]) {
    const keys = new Set();
    for (const f of device.features) {
      assert.ok(f.category in UNITS_BY_CATEGORY, `${f.external_id}: ${f.category}`);
      if (f.unit !== undefined) {
        assert.ok(UNITS_BY_CATEGORY[f.category].includes(f.unit), `${f.external_id}: ${f.unit}`);
      } else {
        assert.equal(f.category, C.UNKNOWN, `${f.external_id}: a unit for its category`);
      }
      assert.equal(f.read_only, true, f.external_id);
      assert.notEqual(f.type, 'binary', 'never a switch');
      assert.ok(!keys.has(f.external_id));
      assert.doesNotMatch(f.external_id.split(':').slice(3).join(':'), /\./);
      keys.add(f.external_id);
    }
  }
});

test('no energy monitoring: no index, no grid-sensor; every counter guarded and plain', () => {
  const indexTypes = new Set([
    TYPES.ENERGY_SENSOR.INDEX,
    TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
    TYPES.GRID_SENSOR.INPUT_INDEX,
    TYPES.GRID_SENSOR.OUTPUT_INDEX,
    TYPES.HOME_OUTPUT_SENSOR.INDEX,
    TYPES.BATTERY_STORAGE.CHARGE_INDEX,
    TYPES.BATTERY_STORAGE.DISCHARGE_INDEX,
  ]);
  assert.ok(!CATALOG.some((e) => e.spec.category !== C.UNKNOWN && indexTypes.has(e.spec.type)));
  assert.ok(!CATALOG.some((e) => e.spec.category === C.ENERGY_SENSOR));
  assert.ok(!CATALOG.some((e) => e.spec.category === C.GRID_SENSOR));
  assert.ok(!CATALOG.some((e) => /daily|thirty/.test(e.spec.type)));
  for (const key of ['power', 'system_power', 'grid_power']) {
    const spec = CATALOG.find((e) => e.key === key).spec;
    assert.equal(spec.category, C.UNKNOWN, key);
    assert.ok(spec.min < 0, `${key} is signed`);
  }
  for (const { key } of COUNTERS) {
    const entry = CATALOG.find((e) => e.key === key);
    assert.ok(entry, key);
    assert.equal(entry.value, undefined, `${key}: only through its guard`);
    assert.equal(entry.spec.category, C.UNKNOWN, key);
    assert.match(entry.spec.name, /kWh.*not counted/);
  }
});

test('supported_options: every one published follows the rules of the core', () => {
  for (const device of [master, other]) {
    for (const f of device.features) {
      if (f.supported_options === undefined) continue;
      assert.ok(Array.isArray(f.supported_options) && f.supported_options.length > 0);
      const values = new Set();
      for (const o of f.supported_options) {
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
        assert.equal(typeof o.label, 'string');
        assert.equal(o.label, o.label.trim());
        assert.ok(o.label.length > 0);
        assert.ok(Number.isInteger(o.value) || typeof o.value === 'string');
        assert.ok(!values.has(String(o.value)), 'unique values');
        values.add(String(o.value));
      }
      if (normalizeSupportedOptions) {
        assert.doesNotThrow(() => normalizeSupportedOptions(f));
      }
    }
  }
  // None today: the codes of the state are in the name of their feature.
  assert.ok(![master, other].some((d) => d.features.some((f) => f.supported_options)));
});
