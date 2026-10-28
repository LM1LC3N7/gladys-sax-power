// -----------------------------------------------------------------------------
// The registers (pure): the requests, the answers of the exact size only, the
// SunSpec markers and scale factors, the "not implemented" words, the offset
// of unit 64, the identity rule, and the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import {
  BLOCK,
  BLOCKS,
  decodeBlock,
  decodeIdentity,
  parseRead,
  readRequest,
  singleRegisters,
} from '../src/sax/registers.js';
import { addressId, resolveIdentity, validSlot } from '../src/sax/identity.js';
import { OUTCOME } from '../src/sax/reader.js';
import { readState } from '../src/store.js';
import { sunspecRegisters, unit40Registers, unit64Registers } from './helpers/fakeSax.js';

const pdu = (words) => {
  const b = Buffer.alloc(2 + words.length * 2);
  b[0] = 3;
  b[1] = words.length * 2;
  words.forEach((w, i) => b.writeUInt16BE(w, 2 + i * 2));
  return b;
};

test('requests: function 3 only, bounded; the blocks are those of the documentation', () => {
  assert.deepEqual([...readRequest(95, 20)], [3, 0, 95, 0, 20]);
  assert.throws(() => readRequest(0, 0), RangeError);
  assert.throws(() => readRequest(0, 126), RangeError);
  assert.throws(() => readRequest(0xffff, 2), RangeError);
  assert.deepEqual(
    BLOCKS.map((b) => [b.key, b.unit, b.address, b.count]),
    [
      ['identity', 100, 0, 15],
      ['battery', 64, 45, 4],
      ['inverter', 100, 15, 32],
      ['meter', 100, 54, 41],
      ['storage', 100, 95, 20],
      ['details', 40, 40115, 3],
      ['energy', 40, 40096, 2],
    ],
  );
  for (const block of BLOCKS) {
    assert.ok(block.count <= 125);
    for (const a of singleRegisters(block)) {
      assert.ok(a >= block.address && a < block.address + block.count, `${block.key} ${a}`);
    }
  }
});

test('answers: only the exact size asked', () => {
  assert.deepEqual(parseRead(2, pdu([1, 2])), [1, 2]);
  assert.equal(parseRead(3, pdu([1, 2])), undefined);
  assert.equal(parseRead(2, Buffer.from([3, 4, 0, 1, 0])), undefined);
  assert.equal(parseRead(1, Buffer.from([4, 2, 0, 1])), undefined);
  assert.equal(parseRead(1, 'x'), undefined);
});

test('identity: the SunS marker and model 1 required; serial as two decimal words', () => {
  const regs = sunspecRegisters({ serial: [4660, 22136], plus: true });
  assert.deepEqual(decodeIdentity(regs), {
    serial: '4660-22136',
    model: 'SAX Power Home Plus',
    master: 61,
    gateway: 54,
  });
  assert.equal(decodeIdentity(sunspecRegisters({ overrides: { 0: 0 } })), undefined);
  assert.equal(decodeIdentity(sunspecRegisters({ overrides: { 2: 2 } })), undefined);
  assert.equal(decodeIdentity(sunspecRegisters({ serial: [0, 0] })).serial, undefined);
  assert.equal(decodeIdentity(sunspecRegisters({ serial: [0xffff, 0xffff] })).serial, undefined);
  assert.equal(decodeIdentity(sunspecRegisters({ overrides: { 8: 0x4142 } })).model, undefined);
});

test('SunSpec values: scale factors, not implemented words, ranges', () => {
  const regs = sunspecRegisters();
  assert.deepEqual(decodeBlock(BLOCK.inverter, regs), {
    acPower: -1500,
    cellTemp: 28,
    state: 4,
    event: 0,
    pvPower: 3200,
  });
  assert.deepEqual(decodeBlock(BLOCK.meter, regs), { gridVoltage: 230.1, gridPower: -450 });
  assert.deepEqual(decodeBlock(BLOCK.storage, regs), {
    systemCapacity: 5.76,
    chargeAvailable: 4600,
    dischargeAvailable: 4600,
    systemSoc: 77,
    storageEvent: 0,
  });
  // Not implemented (0x8000 / 0xFFFF), a scale factor out of range: unknown, never 0.
  const odd = sunspecRegisters({
    overrides: { 29: -32768, 102: 0xffff, 46: 11, 76: -32768, 41: 500 },
  });
  const inverter = decodeBlock(BLOCK.inverter, odd);
  assert.equal(inverter.acPower, undefined);
  assert.equal(inverter.pvPower, undefined);
  assert.equal(inverter.cellTemp, undefined, '500 °C is not a measure');
  assert.equal(decodeBlock(BLOCK.storage, odd).systemSoc, undefined);
  assert.equal(decodeBlock(BLOCK.meter, odd).gridPower, undefined);
  // A scale factor just out of range, even where the value would fit.
  assert.equal(
    decodeBlock(BLOCK.inverter, sunspecRegisters({ overrides: { 46: -11 } })).pvPower,
    undefined,
  );
  // The "not implemented" words even where the raw value would fit the range.
  const unset = sunspecRegisters({ overrides: { 98: 0xffff, 72: -32768, 76: 0 } });
  assert.equal(decodeBlock(BLOCK.storage, unset).chargeAvailable, undefined);
  assert.equal(decodeBlock(BLOCK.storage, unset).dischargeAvailable, 4600);
  assert.equal(decodeBlock(BLOCK.meter, unset).gridPower, undefined);
  // A model id that is not the documented one: nothing from the block.
  assert.deepEqual(decodeBlock(BLOCK.meter, sunspecRegisters({ overrides: { 54: 201 } })), {});
  // A negative scale factor is exact.
  const sf = sunspecRegisters({ overrides: { 61: 2303, 69: -1 } });
  assert.equal(decodeBlock(BLOCK.meter, sf).gridVoltage, 230.3);
});

test('unit 64: the offset of 16384 and the signed word of sax_battery_ha', () => {
  const at = (power) => decodeBlock(BLOCK.battery, unit64Registers({ power })).power;
  assert.equal(at(-1500), -1500);
  assert.equal(at(2300), 2300);
  assert.equal(at(0), 0);
  // raw 0xC000 and above: below -16384 after the reference's formula, not a measure.
  assert.equal(decodeBlock(BLOCK.battery, new Map([[47, 0xc100]])).power, undefined);
  assert.equal(decodeBlock(BLOCK.battery, new Map([[46, 101]])).soc, undefined);
  assert.equal(decodeBlock(BLOCK.battery, new Map([[45, 0xffff]])).status, undefined);
});

test('unit 40: energies in Wh read as kWh, capacity x 10 Wh, cycles, temperature', () => {
  const regs = unit40Registers();
  assert.deepEqual(decodeBlock(BLOCK.energy, regs), {
    energyProduced: 12.345,
    energyConsumed: 13.456,
  });
  assert.deepEqual(decodeBlock(BLOCK.details, regs), {
    capacity: 5.76,
    cycles: 210,
    temperature: 27,
  });
  assert.equal(decodeBlock(BLOCK.details, unit40Registers({ cycles: 0 })).cycles, undefined);
  assert.equal(
    decodeBlock(BLOCK.details, unit40Registers({ temperature: 0xffd8 })).temperature,
    -40,
  );
});

test('the identity rule: serial first, the address only after 3 misses with unit 64 answering', () => {
  const slot = validSlot({});
  const where = { host: '192.168.1.50', port: 502 };
  const miss = { outcomes: { identity: OUTCOME.ABSENT, battery: OUTCOME.OK } };
  assert.deepEqual(resolveIdentity(slot, where, miss), { id: undefined, note: 'identifying' });
  // A read where unit 64 did not answer counts nothing.
  resolveIdentity(slot, where, { outcomes: { identity: OUTCOME.FAILED, battery: OUTCOME.FAILED } });
  // Skipped: counts nothing.
  resolveIdentity(slot, where, { outcomes: { identity: OUTCOME.SKIPPED, battery: OUTCOME.OK } });
  assert.equal(slot.misses, 1);
  resolveIdentity(slot, where, miss);
  assert.deepEqual(resolveIdentity(slot, where, miss), {
    id: 'ip192-168-1-50-502',
    note: undefined,
  });
  // Then a serial: the serial wins, forever.
  const ok = { identity: { serial: '1-2' }, outcomes: { identity: OUTCOME.OK } };
  assert.deepEqual(resolveIdentity(slot, where, ok), { id: 'sn1-2', note: undefined });
  assert.deepEqual(resolveIdentity(slot, where, miss), { id: undefined, note: 'unreadable' });
  assert.deepEqual(resolveIdentity(slot, where, { identity: { serial: '3-4' }, outcomes: {} }), {
    id: 'sn3-4',
    note: 'otherSerial',
  });
  assert.equal(addressId('FE80::1', 1502), 'ipfe80-1-1502');
  assert.doesNotMatch(addressId('a.b.c', 502), /[.:]/);
});

test('configuration: up to three addresses, the master first, port 502 by default', () => {
  assert.deepEqual(parseAddress('http://192.168.1.50:1502/x'), {
    address: '192.168.1.50:1502',
    host: '192.168.1.50',
    port: 1502,
  });
  assert.deepEqual(parseAddress('[fe80::1]'), {
    address: '[fe80::1]:502',
    host: 'fe80::1',
    port: 502,
  });
  for (const bad of ['0.0.0.0', '239.1.1.1', 'a:0', 'a:70000', 'u@h', '[ff02::1]', '::']) {
    assert.equal(parseAddress(bad).error, 'invalid', bad);
  }
  const config = normalizeConfig({
    battery_a: ' 192.168.1.50 ',
    battery_c: '192.168.1.52',
    poll_interval: '5',
  });
  assert.deepEqual(
    config.batteries.map((b) => [b.field, b.address, b.master]),
    [
      ['battery_a', '192.168.1.50:502', true],
      ['battery_c', '192.168.1.52:502', false],
    ],
  );
  assert.equal(config.pollInterval, 15);
  assert.equal(normalizeConfig({ battery_a: 'x', poll_interval: 'abc' }).pollInterval, 30);
  assert.equal(normalizeConfig({ battery_a: 'x', poll_interval: 9999 }).pollInterval, 300);
  assert.equal(normalizeConfig({}).problem, 'address_missing');
  assert.deepEqual(normalizeConfig({ battery_a: 'x', battery_b: 'x:502' }).batteries, []);
});

test('/data read back: checked field by field, no prototype, never in the future', () => {
  const state = readState(
    {
      lastAttemptAt: 9e15,
      slots: {
        '192.168.1.50:502': { serial: '12-34', fallback: 'yes', misses: -1 },
        'bad address': { serial: '1-1' },
        __proto__: { serial: '1-1' },
      },
      info: { 'sn12-34': { model: 'SAX Power Home', versionMaster: 61 }, '../x': {} },
      counters: { 'ext:sax-power:battery:sn12-34:energy_produced': { guard: {} }, x: {} },
    },
    1000,
  );
  assert.equal(state.lastAttemptAt, 1000);
  assert.deepEqual(Object.keys(state.slots), ['192.168.1.50:502']);
  assert.deepEqual(state.slots['192.168.1.50:502'], {
    serial: '12-34',
    fallback: false,
    misses: 0,
  });
  assert.equal(Object.getPrototypeOf(state.slots), null);
  assert.deepEqual(Object.keys(state.info), ['sn12-34']);
  assert.deepEqual(Object.keys(state.counters), ['ext:sax-power:battery:sn12-34:energy_produced']);
  assert.deepEqual(JSON.parse(JSON.stringify(readState('garbage', 5))), {
    lastAttemptAt: 0,
    slots: {},
    info: {},
    counters: {},
  });
});
