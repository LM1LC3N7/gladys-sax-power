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
  HOUR,
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

test('/data unreadable: no fallback identity, no counter, never written over', async () => {
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
  assert.equal(last(gladys, FA('energy_produced')), undefined);
  assert.equal(store.saves, 0);
  assert.match(status(gladys).message.en, /cannot be read/);
  await app.stop();
});

test('/data unreadable: a counter never reaches the states, even before the save', async () => {
  const store = createMemoryStore({}, { unreadable: true });
  const { app } = await setup({ store, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  const slot = app.slots[0];
  const states = app.prepare(slot, slot.values, { counters: true });
  assert.ok(states.some((s) => s.device_feature_external_id === FA('soc')));
  assert.ok(!states.some((s) => /energy_/.test(s.device_feature_external_id)));
  assert.equal(app.guards.size, 0);
  await app.stop();
});

test('session clock: the date Gladys gives is turned to the session clock (wall set back)', async () => {
  let produced = 12.345;
  const device = created();
  const {
    app,
    gladys,
    advance,
    wall,
    clock: c,
  } = await setup({
    devices: [],
    script: () => result({ values: { energyProduced: produced } }),
  });
  await app.start(CONFIG);
  await app.idle();
  // NTP sets the wall clock 3 h back; then the user creates the device, which
  // holds 12.345 kWh dated by Gladys on that wall clock.
  wall.jump = -3 * HOUR;
  const feature = device.features.find((f) => f.external_id === FA('energy_produced'));
  feature.last_value = 12.345;
  feature.last_value_changed = new Date(START + c.elapsed - 3 * HOUR).toISOString();
  gladys.fake.devices.push(device);
  await gladys.fake.deviceCreated(device);
  await app.idle();
  // +30 kWh in 35 s: held (never "3 h of margin" from the wall date).
  produced = 42.345;
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  assert.match(status(gladys).message.en, /jumped from 12\.345 to 42\.345 kWh/);
  await app.stop();
});

test('/data that cannot be written: the counters are not sent, the other values are', async () => {
  const store = createMemoryStore({}, { failSave: true });
  const { app, gladys } = await setup({ store, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('soc')), 76);
  assert.equal(last(gladys, FA('energy_produced')), undefined);
  assert.match(status(gladys).message.en, /cannot be written/);
  await app.stop();
});

test('counters: never 0, a drop held (the last value sent again), accepted in two clicks only', async () => {
  let produced = 12.345;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => result({ values: { energyProduced: produced } }),
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  produced = 0;
  await advance(POLL + 5 * SECOND);
  assert.ok(!statesOf(gladys, FA('energy_produced')).includes(0), 'never 0');
  produced = 2.5;
  await advance(POLL + 5 * SECOND);
  assert.ok(statesOf(gladys, FA('energy_produced')).every((v) => v === 12.345));
  assert.match(
    status(gladys).message.en,
    /energy produced": dropped from 12\.345 to 2\.5 kWh, held back/,
  );
  // A save of the form accepts nothing.
  await app.start(CONFIG, { fresh: true });
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  // First click lists; a second click too soon only lists again.
  assert.match(
    (await action(gladys, ACTIONS.ACCEPT_HELD)).en,
    /A second click accepts exactly these values: Battery A, energy produced: 12\.345 → 2\.5 kWh/,
  );
  assert.match((await action(gladys, ACTIONS.ACCEPT_HELD)).en, /A second click accepts/);
  await advance(5 * SECOND);
  assert.match(
    (await action(gladys, ACTIONS.ACCEPT_HELD)).en,
    /Accepted: Battery A, energy produced 2\.5 kWh/,
  );
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 2.5);
  assert.doesNotMatch(status(gladys).message.en, /held back/);
  await app.stop();
});

test('counters: the second click takes only the value listed (plus the margin since)', async () => {
  let produced = 12.345;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => result({ values: { energyProduced: produced } }),
  });
  await app.start(CONFIG);
  await app.idle();
  produced = 2.5;
  await advance(POLL + 5 * SECOND);
  assert.match((await action(gladys, ACTIONS.ACCEPT_HELD)).en, /12\.345 → 2\.5 kWh/);
  // Before the second click, the held value moves by far more than 35 s may add.
  produced = 9;
  await advance(POLL + 5 * SECOND);
  assert.match(
    (await action(gladys, ACTIONS.ACCEPT_HELD)).en,
    /Not accepted, the value changed since the first click: Battery A, energy produced/,
  );
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  await app.stop();
});

test('counters: a jump is held whatever the time, a later value at or above it too', async () => {
  let produced = 12.345;
  const { app, gladys, advance } = await setup({
    devices: [created()],
    script: () => result({ values: { energyProduced: produced } }),
  });
  await app.start(CONFIG);
  await app.idle();
  produced = 60; // +47.6 kWh in 35 s: far beyond 20 kW
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  for (let i = 0; i < 6; i += 1) {
    produced += 0.01;
    await advance(HOUR);
  }
  assert.equal(last(gladys, FA('energy_produced')), 12.345, 'never taken by time');
  await app.stop();
});

test('session clock: NTP setting the wall clock 3 h ahead never widens the margin of a jump', async () => {
  let produced = 12.345;
  const { app, gladys, advance, wall } = await setup({
    devices: [created()],
    script: () => result({ values: { energyProduced: produced } }),
  });
  await app.start(CONFIG);
  await app.idle();
  wall.jump = 3 * HOUR;
  // +30 kWh: plausible over 3 h at 20 kW on the wall clock, not over 35 s.
  produced = 42.345;
  await advance(POLL + 5 * SECOND);
  assert.equal(last(gladys, FA('energy_produced')), 12.345);
  assert.match(status(gladys).message.en, /jumped from 12\.345 to 42\.345 kWh/);
  await app.stop();
});

test('session clock: a hold and its reference survive a restart with the wall clock set back', async () => {
  const store = createMemoryStore();
  let produced = 12.345;
  const script = () => result({ values: { energyProduced: produced } });
  const first = await setup({ store, devices: [created()], script });
  await first.app.start(CONFIG);
  await first.app.idle();
  produced = 5;
  await first.advance(POLL + 5 * SECOND);
  await first.app.stop();
  assert.equal(store.data.counters[FA('energy_produced')].guard.held.to, 5);
  // A new process, its wall clock 2 h behind (NTP not yet set).
  const second = await setup({
    store,
    devices: [created()],
    script,
    clock: testClock({ start: START - 2 * HOUR }),
  });
  await second.app.start(CONFIG);
  await second.advance(2 * MINUTE);
  assert.equal(last(second.gladys, FA('energy_produced')), 12.345);
  assert.match(status(second.gladys).message.en, /dropped from 12\.345 to 5 kWh/);
  await second.app.stop();
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
