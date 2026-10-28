// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, fake readers and the test
// clock of the kit (it moves at each read): the devices, the values, the
// pace, the failures, the identity, the freshness, /data and the guards of
// the energy counters on the session clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import {
  ADDRESS_A,
  ADDRESS_B,
  CONFIG,
  CONFIG_AB,
  DEVICE_A,
  DEVICE_B,
  FA,
  FB,
  ID_A,
  MINUTE,
  POLL,
  SECOND,
  SERIAL_B,
  START,
  created,
  last,
  result,
  setup,
  statesOf,
  status,
  text,
  unreachable,
} from './helpers/app.js';

const action = async (gladys, key) => (await gladys.fake.action(key)).data.message;

test('nothing configured, or an address invalid or twice: the status says so, nothing is read', async () => {
  for (const [config, words] of [
    [{}, /adresse IP de la batterie A/],
    [{ battery_b: '192.168.1.51' }, /adresse IP de la batterie A/],
    [{ battery_a: 'u:p@x' }, /Batterie A n’est pas une adresse valide/],
    [{ battery_a: '255.255.255.255' }, /Batterie A n’est pas une adresse valide/],
    [{ battery_a: '192.168.1.50', battery_c: '224.0.0.1' }, /Batterie C n’est pas/],
    [{ battery_a: '192.168.1.50', battery_b: '192.168.1.50:502' }, /Batterie B a la même adresse/],
  ]) {
    const { app, gladys, readers } = await setup({ config });
    await app.start(config);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, words);
    assert.equal(readers.calls.length, 0);
    assert.match(String((await action(gladys, ACTIONS.TEST)).fr), words);
    await app.stop();
  }
});

test('the first read: the device of the serial number in Discovery, no value before it is created', async () => {
  const { app, gladys, readers } = await setup();
  await app.start(CONFIG);
  await app.idle();
  assert.equal(readers.calls.length, 1);
  assert.equal(readers.calls[0].address, ADDRESS_A);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE_A);
  assert.equal(device.name, 'SAX Power Home (A, master)');
  assert.ok(device.features.some((f) => f.external_id === FA('system_soc')));
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(
    status(gladys).message.en,
    /Battery A \(192\.168\.1\.50:502\): SAX Power Home sn1234-56 answering; create its device/,
  );
  await app.stop();
});

test('a created device gets the values of the read, the counters through their guards', async () => {
  const { app, gladys } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('soc')), 76);
  assert.equal(last(gladys, FA('power')), -1500);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  assert.equal(last(gladys, FA('energy_consumed')), 13.456);
  assert.equal(last(gladys, FA('system_soc')), 77);
  assert.equal(last(gladys, FA('pv_power')), 3200);
  assert.equal(last(gladys, FA('grid_power')), -450);
  assert.equal(last(gladys, FA('temperature')), 27);
  assert.equal(last(gladys, FA('cell_temperature')), 28);
  assert.match(status(gladys).message.en, /SAX Power Home sn1234-56 answering\./);
  await app.stop();
});

test('without the ADW200 meter (no grid voltage), neither solar nor grid power is published', async () => {
  const { app, gladys } = await setup({
    devices: [created()],
    script: () => result({ values: { gridVoltage: 0, pvPower: 0, gridPower: 0 } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('pv_power')), undefined);
  assert.equal(last(gladys, FA('grid_power')), undefined);
  assert.equal(last(gladys, FA('soc')), 76);
  await app.stop();
});

test('pace: never faster than the interval, whatever asks (test button, Discovery, reconnection, save)', async () => {
  const { app, gladys, readers, advance } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(readers.calls.length, 1);
  await advance(10 * SECOND);
  const message = await action(gladys, ACTIONS.TEST);
  assert.match(message.en, /Not asked now|Last read/);
  await gladys.fake.scanRequest();
  await app.start(CONFIG); // a reconnection
  await app.start(CONFIG, { fresh: true }); // a save of the same form
  await app.idle();
  assert.equal(readers.calls.length, 1);
  await advance(POLL);
  assert.equal(readers.calls.length, 2);
  await app.stop();
});

test('a new address is read at once; the restart of the container waits interval + 1 min', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: START });
  const first = await setup({ store, clock });
  await first.app.start(CONFIG);
  await first.app.idle();
  await first.app.start({ battery_a: '192.168.1.60' }, { fresh: true });
  await first.app.idle();
  assert.deepEqual(
    first.readers.calls.map((c) => c.address),
    [ADDRESS_A, '192.168.1.60:502'],
  );
  await first.app.stop();
  // A new process (a restarted container), same /data.
  const second = await setup({ store, clock: testClock({ start: START + 5 * SECOND }) });
  await second.app.start({ battery_a: '192.168.1.60' });
  await second.app.idle();
  assert.equal(second.readers.calls.length, 0);
  await second.advance(POLL + 40 * SECOND);
  assert.equal(second.readers.calls.length, 0);
  await second.advance(POLL);
  assert.equal(second.readers.calls.length, 1);
  await second.app.stop();
});

test('several batteries: each its own device and values; one that hangs never delays the other', async () => {
  const {
    app,
    gladys,
    readers,
    clock: c,
  } = await setup({
    config: CONFIG_AB,
    devices: [created(), created({ id: `sn${SERIAL_B}`, master: false, field: 'battery_b' })],
    script: (battery, n) => {
      if (battery.address === ADDRESS_B) {
        if (n === 1) return result({ serial: SERIAL_B, master: false, values: { soc: 60 } });
        return new Promise(() => {}); // B hangs from its second read on
      }
      return result({ values: { soc: 70 + n } });
    },
  });
  await app.start(CONFIG_AB);
  await app.idle();
  assert.equal(last(gladys, FA('soc')), 71);
  assert.equal(last(gladys, FB('soc')), 60);
  assert.equal(last(gladys, FB('system_soc')), undefined, 'no system value on battery B');
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE_A, DEVICE_B],
  );
  // B hangs: A still read at its pace (the timers fire, nothing waits for B).
  for (let i = 0; i < 4; i += 1) await c.advance(POLL + 5 * SECOND);
  const aReads = readers.calls.filter((call) => call.address === ADDRESS_A).length;
  const bReads = readers.calls.filter((call) => call.address === ADDRESS_B).length;
  assert.ok(aReads >= 5, `${aReads} reads of A`);
  assert.equal(bReads, 2, 'B never read twice at once');
  assert.equal(last(gladys, FA('soc')), 70 + aReads);
  // A stop cuts the read that hangs.
  await app.stop();
  assert.ok(readers.readers.get(ADDRESS_B).aborts >= 1);
});

test('all batteries unreachable: not connected, retried later (doubled), never faster than a read', async () => {
  const { app, gladys, readers, advance } = await setup({ script: () => unreachable() });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /not read \(unreachable\), new try in 1 min/);
  await advance(POLL);
  assert.equal(readers.calls.length, 1);
  await advance(POLL + 5 * SECOND);
  assert.equal(readers.calls.length, 2);
  await advance(2 * MINUTE + 5 * SECOND);
  assert.equal(readers.calls.length, 3);
  await app.stop();
});

test('getConfig() failing in `connected`: asked again without end, then the start', async () => {
  const { app, gladys, readers, clock: c } = await setup();
  let fails = 2;
  const getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('boom');
    }
    return CONFIG;
  };
  await app.connectedVia(getConfig);
  assert.match(status(gladys).message.en, /could not be read from Gladys: new try in 5 s/);
  await c.advance(5 * SECOND);
  await app.idle();
  assert.match(status(gladys).message.en, /new try in 15 s/);
  assert.equal(readers.calls.length, 0);
  await c.advance(15 * SECOND);
  await app.idle();
  assert.equal(readers.calls.length, 1);
  assert.equal(status(gladys).connected, true);
  await app.stop();
});

test('identity: values only to the serial read; unreadable after known = nothing; another serial = another device', async () => {
  let serial = '1234-56';
  const { app, gladys, advance, logger } = await setup({
    devices: [created()],
    script: () =>
      serial === null
        ? result({ serial: null, outcomes: { identity: 'failed' }, values: { soc: 11 } })
        : result({ serial, values: { soc: serial === '1234-56' ? 50 : 99 } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('soc')), 50);
  serial = null;
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('soc')), 50, 'nothing published without the serial');
  assert.match(status(gladys).message.en, /serial number not readable this time/);
  serial = '9999-1';
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('soc')), 50, 'never to the old device');
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    ['ext:sax-power:battery:sn9999-1'],
  );
  assert.ok(logger.lines.some((l) => /another battery answers/.test(l)));
  await app.stop();
});

test('no SunSpec interface: named after its address after 3 reads where unit 64 answered', async () => {
  const store = createMemoryStore();
  const { app, gladys, advance } = await setup({
    store,
    script: () => result({ serial: null, master: false }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(status(gladys).message.en, /no serial number read yet/);
  await advance(POLL + 5 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  await advance(POLL + 5 * SECOND);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    ['ext:sax-power:battery:ip192-168-1-50-502'],
  );
  assert.equal(store.data.slots[ADDRESS_A].fallback, true);
  await app.stop();
});

test('a battery known by its serial never falls back to its address', async () => {
  const store = createMemoryStore({ slots: { [ADDRESS_A]: { serial: '1234-56' } } });
  const { app, gladys, advance, readers } = await setup({
    store,
    script: () => result({ serial: null }),
  });
  await app.start(CONFIG);
  await app.idle();
  for (let i = 0; i < 5; i += 1) await advance(POLL + 5 * SECOND);
  assert.ok(readers.calls.every((c) => c.identityRequired === true));
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [DEVICE_A],
  );
  assert.equal(store.data.slots[ADDRESS_A].fallback, false);
  await app.stop();
});

test('/data unreadable: no fallback identity, never written over; the values go', async () => {
  const store = createMemoryStore({}, { unreadable: true });
  const { app, gladys, advance } = await setup({
    store,
    devices: [created()],
    script: (b, n) => result({ serial: n <= 5 ? null : '1234-56' }),
  });
  await app.start(CONFIG);
  await app.idle();
  for (let i = 0; i < 4; i += 1) await advance(POLL + 5 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, 0, 'never named after its address');
  assert.equal(last(gladys, FA('soc')), undefined);
  await advance(POLL + 5 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, DEVICE_A);
  assert.equal(last(gladys, FA('soc')), 76);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  assert.equal(store.saves, 0);
  assert.match(status(gladys).message.en, /cannot be read/);
  await app.stop();
});

test('nothing stale: a reconnection republishes no value before the next read', async () => {
  const { app, gladys, advance } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  const before = gladys.fake.states.length;
  await advance(10 * SECOND);
  await app.start(CONFIG); // reconnection: nothing until the next read
  await app.idle();
  assert.equal(gladys.fake.states.length, before);
  await advance(POLL);
  assert.ok(gladys.fake.states.length > before);
  await app.stop();
});

test('a device created later gets the last values while fresh, without a new read; never stale ones', async () => {
  const { app, gladys, readers } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const device = created();
  gladys.fake.devices.push(device);
  await gladys.fake.deviceCreated(device);
  await app.idle();
  assert.equal(last(gladys, FA('soc')), 76);
  assert.equal(readers.calls.length, 1);
  await app.stop();

  // Stale: the last good read is older than two intervals.
  const other = await setup({ script: (b, n) => (n === 1 ? result() : new Promise(() => {})) });
  await other.app.start(CONFIG);
  await other.app.idle();
  for (let i = 0; i < 3; i += 1) await other.clock.advance(POLL);
  const late = created();
  other.gladys.fake.devices.push(late);
  await other.gladys.fake.deviceCreated(late);
  assert.equal(last(other.gladys, FA('soc')), undefined);
  await other.app.stop();
});

test('a read that ends after a stop publishes nothing and sets no status', async () => {
  let release;
  const store = createMemoryStore();
  const { app, gladys, readers } = await setup({
    store,
    devices: [created()],
    script: (b, n) =>
      n === 1
        ? new Promise((resolve) => {
            release = () => resolve(result({ values: { soc: 1 } }));
          })
        : result(),
  });
  await app.start(CONFIG);
  await new Promise((r) => setImmediate(r));
  // A reader whose abort comes too late: its good answer lands after the stop.
  readers.readers.get(ADDRESS_A).abort = () => {};
  const before = status(gladys);
  const stopping = app.stop();
  await new Promise((r) => setImmediate(r));
  release();
  await stopping;
  assert.equal(last(gladys, FA('soc')), undefined);
  assert.deepEqual(status(gladys), before);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  // Nothing of it learned either: /data keeps no serial from a late read.
  assert.equal(store.data.slots[ADDRESS_A]?.serial ?? null, null);
  assert.deepEqual(store.data.info, {});
});

test('a failed read whose /data write ends after a stop sets no status', async () => {
  let release;
  const store = createMemoryStore();
  const { app, gladys, readers } = await setup({
    store,
    script: () =>
      new Promise((resolve) => {
        release = () => resolve(unreachable());
      }),
  });
  await app.start(CONFIG);
  await new Promise((r) => setImmediate(r));
  // A reader that does not stop at once, and a slow /data: the stop comes
  // while the failure is being written.
  readers.readers.get(ADDRESS_A).abort = () => {};
  store.slow = true;
  release();
  await new Promise((r) => setImmediate(r));
  const stopping = app.stop();
  await stopping;
  await app.idle();
  assert.doesNotMatch(status(gladys).message.en, /unreachable/);
});

test('the test button reads when due and shows the values', async () => {
  const { app, gladys, advance } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  await advance(POLL);
  const message = await action(gladys, ACTIONS.TEST);
  assert.match(text(message), /SAX Power Home sn1234-56 answering/);
  assert.match(message.en, /Values: 76 %, -1500 W, system 77 %/);
  await app.stop();
});

test('blocks not read are listed in the status; the energies missing never publish 0', async () => {
  const { app, gladys } = await setup({
    devices: [created()],
    script: () => {
      const r = result({ outcomes: { energy: 'failed' } });
      delete r.values.energyProduced;
      delete r.values.energyConsumed;
      return r;
    },
  });
  await app.start(CONFIG);
  await app.idle();
  assert.match(status(gladys).message.en, /not read this time: energy counters \(unit 40\)/);
  assert.equal(last(gladys, FA('energy_produced')), undefined);
  assert.equal(last(gladys, FA('soc')), 76);
  await app.stop();
});

test('the id rule: no dot nor colon in the platform id', () => {
  assert.doesNotMatch(ID_A, /[.:]/);
});

test('energy counters: published as read, a drop too; 0 is unknown, never published; no hold', async () => {
  let produced = 65.53;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => result({ values: { energyProduced: produced, energyConsumed: 0 } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('energy_produced')), 65.53);
  assert.equal(last(gladys, FA('energy_consumed')), undefined, '0 is never published');
  produced = 0.12; // a 16-bit counter starting over, or a periodic one
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 0.12);
  produced = 0;
  await advance(POLL + 5 * SECOND);
  assert.ok(!statesOf(gladys, FA('energy_produced')).includes(0));
  assert.doesNotMatch(status(gladys).message.en, /held/);
  assert.deepEqual(Object.keys(app.kept), ['lastAttemptAt', 'slots', 'info']);
  await app.stop();
});

test('/data that cannot be written: the values are sent, the status says so', async () => {
  const store = createMemoryStore({}, { failSave: true });
  const { app, gladys } = await setup({ store, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('soc')), 76);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  assert.match(status(gladys).message.en, /cannot be written/);
  await app.stop();
});

test('every block failing (an odd answer, the budget): a failure, said, logged, spaced', async () => {
  for (const [kind, words] of [
    ['protocol', /answer that is not Modbus TCP/],
    ['timeout', /no answer in time/],
  ]) {
    const failing = () => ({
      ...unreachable(),
      reached: true,
      outcomes: { identity: 'failed', battery: 'skipped' },
      error: kind,
    });
    const { app, gladys, readers, logger, advance } = await setup({
      devices: [created()],
      script: (b, n) => (n === 1 ? result() : failing()),
    });
    await app.start(CONFIG);
    await app.idle();
    assert.equal(status(gladys).connected, true);
    await advance(POLL + 5 * SECOND);
    assert.equal(status(gladys).connected, false, kind);
    assert.match(status(gladys).message.en, words);
    assert.ok(logger.lines.some((l) => l.includes(`failed: ${kind}`)));
    // Spaced: not read again before 1 min.
    await advance(POLL);
    assert.equal(readers.calls.length, 2);
    await app.stop();
  }
});

test('after a failure, or a read without identity, no value is kept for a device created then', async () => {
  for (const second of [unreachable(), result({ serial: null })]) {
    const store = createMemoryStore({ slots: { [ADDRESS_A]: { serial: '1234-56' } } });
    const { app, gladys, advance } = await setup({
      store,
      script: (b, n) => (n === 1 ? result() : second),
    });
    await app.start(CONFIG);
    await app.idle();
    await advance(POLL + 5 * SECOND);
    // Nothing of that read is shown as the battery's values either.
    assert.doesNotMatch((await action(gladys, ACTIONS.TEST)).en, /Values:/);
    const device = created();
    gladys.fake.devices.push(device);
    await gladys.fake.deviceCreated(device);
    await app.idle();
    assert.equal(last(gladys, FA('soc')), undefined);
    await app.stop();
  }
});

test('270 states per minute at most: a batch beyond waits for the next read', async () => {
  const { app, gladys, advance } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const batch = (n, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({
      device_feature_external_id: `${DEVICE_A}:x${i + offset}`,
      state: i,
    }));
  await app.send(batch(200));
  await app.send(batch(100, 200));
  assert.equal(gladys.fake.states.length, 200);
  await app.send(batch(70, 400));
  assert.equal(gladys.fake.states.length, 270);
  await advance(61 * SECOND);
  await app.send(batch(100, 500));
  assert.equal(gladys.fake.states.length, 370);
  await app.stop();
});
