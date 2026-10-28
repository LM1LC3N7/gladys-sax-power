// -----------------------------------------------------------------------------
// One read of a battery against the fake SAX battery on 127.0.0.1 (real
// sockets, real timers): the blocks, the gap between requests, one request at
// a time, one connection at a time, the single reads of a refused block, a
// silent unit that never holds the others, the skip after failures, the abort.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatteryReader, OUTCOME } from '../src/sax/reader.js';
import { TIMINGS } from '../src/constants.js';
import { tcpServer } from './kit/tcp.mjs';
import {
  recordingConnect,
  startFakeSax,
  sunspecRegisters,
  unit40Registers,
  unit64Registers,
} from './helpers/fakeSax.js';

const reader = (sax, extra = {}) =>
  new BatteryReader({ host: '127.0.0.1', port: sax.port, master: true, gap: 20, ...extra });

test('a master: every block in one connection, 500 ms apart, one request at a time', async (t) => {
  const sax = await startFakeSax();
  t.after(() => sax.close());
  // The decision time of each request, stamped as its bytes leave.
  let r;
  const recording = recordingConnect(() => r.lastRequestMono);
  r = reader(sax, { gap: TIMINGS.requestGap, connect: recording.connect });
  const result = await r.read();
  assert.equal(result.reached, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.identity, {
    serial: '1234-56',
    model: 'SAX Power Home',
    master: 61,
    gateway: 54,
  });
  for (const key of ['identity', 'battery', 'inverter', 'meter', 'storage', 'details', 'energy']) {
    assert.equal(result.outcomes[key], OUTCOME.OK, key);
  }
  assert.deepEqual(result.values, {
    status: 3,
    soc: 76,
    power: -1500,
    acPower: -1500,
    cellTemp: 28,
    state: 4,
    event: 0,
    pvPower: 3200,
    gridVoltage: 230.1,
    gridPower: -450,
    systemCapacity: 5.76,
    chargeAvailable: 4600,
    dischargeAvailable: 4600,
    systemSoc: 77,
    storageEvent: 0,
    capacity: 5.76,
    cycles: 210,
    temperature: 27,
    energyProduced: 12.345,
    energyConsumed: 13.456,
  });
  assert.equal(sax.device.connections, 1);
  assert.equal(sax.device.peak, 1);
  assert.deepEqual(
    sax.requests.map((q) => [q.unit, q.address, q.count]),
    [
      [100, 0, 15],
      [64, 45, 4],
      [100, 15, 32],
      [100, 54, 41],
      [100, 95, 20],
      [40, 40115, 3],
      [40, 40096, 2],
    ],
  );
  assert.ok(
    sax.requests.every((q) => q.fc === 3),
    'read requests only',
  );
  // Measured where the request leaves (the client decides the gap).
  const sent = recording.writes.get(sax.port);
  assert.equal(sent.length, 7);
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i] - sent[i - 1];
    assert.ok(gap >= TIMINGS.requestGap, `gap ${gap} ms`);
  }
});

test('a timer that fires early never shortens the gap: measured again after each wait', async (t) => {
  const sax = await startFakeSax();
  t.after(() => sax.close());
  const early = {
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms - 150)),
    clearTimeout: (h) => clearTimeout(h),
  };
  let r;
  const recording = recordingConnect(() => r.lastRequestMono);
  r = reader(sax, { master: false, gap: 300, timers: early, connect: recording.connect });
  await r.read();
  const sent = recording.writes.get(sax.port);
  assert.equal(sent.length, 4);
  for (let i = 1; i < sent.length; i += 1) {
    assert.ok(sent[i] - sent[i - 1] >= 300, `gap ${sent[i] - sent[i - 1]} ms`);
  }
});

test('a battery of the group (not the master): no system block', async (t) => {
  const sax = await startFakeSax();
  t.after(() => sax.close());
  const result = await reader(sax, { master: false }).read();
  assert.deepEqual(Object.keys(result.outcomes), ['identity', 'battery', 'details', 'energy']);
  assert.equal(result.values.systemSoc, undefined);
  assert.equal(result.values.soc, 76);
});

test('a block refused as a whole is read register by register, as the reference reads', async (t) => {
  const sax = await startFakeSax({ wholeRefused: true });
  t.after(() => sax.close());
  const r = reader(sax, { master: false });
  const result = await r.read();
  assert.equal(result.identity.serial, '1234-56');
  assert.equal(result.values.soc, 76);
  assert.equal(result.values.energyProduced, 12.345);
  assert.ok(sax.requests.filter((q) => q.count === 1).length >= 10);
  // Once refused, the next read asks register by register at once.
  sax.requests.length = 0;
  await r.read();
  assert.ok(sax.requests.every((q) => q.count === 1));
});

test('a silent unit ends its session only: the next blocks go on a new connection', async (t) => {
  const sax = await startFakeSax({ silentUnits: [40] });
  t.after(() => sax.close());
  const old = TIMINGS.requestTimeout;
  TIMINGS.requestTimeout = 300;
  t.after(() => {
    TIMINGS.requestTimeout = old;
  });
  const r = reader(sax, { master: false });
  const result = await r.read();
  assert.equal(result.outcomes.identity, OUTCOME.OK);
  assert.equal(result.outcomes.battery, OUTCOME.OK);
  assert.equal(result.outcomes.details, OUTCOME.FAILED);
  assert.equal(result.outcomes.energy, OUTCOME.FAILED);
  assert.equal(result.error, 'timeout');
  assert.equal(result.values.soc, 76);
  assert.equal(sax.device.peak, 1, 'one connection at a time');
  assert.equal(sax.device.connections, 2);
  // Three reads in a row: skipped for the next reads.
  await r.read();
  await r.read();
  sax.requests.length = 0;
  const skipped = await r.read();
  assert.equal(skipped.outcomes.details, OUTCOME.SKIPPED);
  assert.equal(skipped.outcomes.energy, OUTCOME.SKIPPED);
  assert.ok(sax.requests.every((q) => q.unit !== 40));
});

test('the identity is never skipped when the caller needs it', async (t) => {
  const sax = await startFakeSax({ units: { 64: unit64Registers(), 40: unit40Registers() } });
  t.after(() => sax.close());
  const r = reader(sax, { master: false });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await r.read()).outcomes.identity, OUTCOME.ABSENT);
  }
  assert.equal((await r.read()).outcomes.identity, OUTCOME.SKIPPED);
  assert.equal((await r.read({ identityRequired: true })).outcomes.identity, OUTCOME.ABSENT);
});

test('a SunSpec block without its marker holds no value', async (t) => {
  const sax = await startFakeSax({
    units: {
      100: sunspecRegisters({ overrides: { 95: 801 } }),
      64: unit64Registers(),
      40: unit40Registers(),
    },
  });
  t.after(() => sax.close());
  const result = await reader(sax).read();
  assert.equal(result.outcomes.storage, OUTCOME.INVALID);
  assert.equal(result.values.systemSoc, undefined);
  assert.equal(result.values.acPower, -1500);
});

test('unreachable: nothing asked, the error said', async () => {
  const r = new BatteryReader({ host: '127.0.0.1', port: 1, master: true });
  const result = await r.read();
  assert.equal(result.reached, false);
  assert.equal(result.error, 'unreachable');
  assert.ok(Object.values(result.outcomes).every((o) => o === OUTCOME.SKIPPED));
});

test('a whole read is bounded: a slow battery is cut at the budget', async (t) => {
  const sax = await startFakeSax({ latencyMs: 150 });
  t.after(() => sax.close());
  const old = TIMINGS.readBudget;
  TIMINGS.readBudget = 400;
  t.after(() => {
    TIMINGS.readBudget = old;
  });
  const started = performance.now();
  const result = await reader(sax).read();
  assert.ok(performance.now() - started < 900, 'cut at the budget');
  // Over budget is a failure of the battery, never a stop.
  assert.equal(result.error, 'timeout');
  assert.ok(sax.requests.length < 7);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sax.device.open, 0);
});

test('abort ends a read at once and closes its connection', async (t) => {
  const sax = await startFakeSax({ latencyMs: 2000 });
  t.after(() => sax.close());
  const r = reader(sax);
  const started = performance.now();
  const job = r.read();
  await new Promise((resolve) => setTimeout(resolve, 100));
  r.abort();
  const result = await job;
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.error, 'aborted');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sax.device.open, 0);
});

test('an answer of another size is a protocol failure (never "aborted")', async (t) => {
  // A device that answers every read with one word more than asked.
  const device = await tcpServer({
    onData: (c) => {
      const count = c.readUInt16BE(10) + 1;
      const pdu = Buffer.alloc(2 + count * 2);
      pdu[0] = 3;
      pdu[1] = count * 2;
      const head = Buffer.alloc(7);
      head.writeUInt16BE(c.readUInt16BE(0), 0);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = c[6];
      return Buffer.concat([head, pdu]);
    },
  });
  t.after(() => device.close());
  const r = new BatteryReader({ host: '127.0.0.1', port: device.port, master: false, gap: 20 });
  const result = await r.read();
  assert.equal(result.error, 'protocol');
  assert.equal(result.outcomes.identity, OUTCOME.FAILED);
  assert.ok(!Object.values(result.outcomes).includes(OUTCOME.OK));
  assert.equal(device.connections, 3, 'each odd answer ends its connection');
});

test('the connections of a read are bounded: three at most, the rest skipped', async (t) => {
  const sax = await startFakeSax({ silentUnits: [100, 64, 40] });
  t.after(() => sax.close());
  const old = TIMINGS.requestTimeout;
  TIMINGS.requestTimeout = 100;
  t.after(() => {
    TIMINGS.requestTimeout = old;
  });
  const result = await reader(sax).read();
  assert.equal(sax.device.connections, 3);
  assert.equal(sax.requests.length, 3);
  assert.deepEqual(Object.values(result.outcomes).filter((o) => o === OUTCOME.SKIPPED).length, 4);
  assert.equal(result.error, 'timeout');
});

test('only exceptions 1 and 2 turn a block to single reads; exception 4 fails it, same connection', async (t) => {
  const sax = await startFakeSax({ wholeException: 4 });
  t.after(() => sax.close());
  const r = reader(sax, { master: false });
  const result = await r.read();
  assert.ok(Object.values(result.outcomes).every((o) => o === OUTCOME.FAILED));
  assert.ok(
    sax.requests.every((q) => q.count > 1),
    'never register by register',
  );
  assert.equal(sax.device.connections, 1);
  await r.read();
  assert.ok(sax.requests.every((q) => q.count > 1));
});

test('a register silent in single reads ends the block and its connection', async (t) => {
  const sax = await startFakeSax({ wholeRefused: true, silentAddresses: ['64:46'] });
  t.after(() => sax.close());
  const old = TIMINGS.requestTimeout;
  TIMINGS.requestTimeout = 150;
  t.after(() => {
    TIMINGS.requestTimeout = old;
  });
  const result = await reader(sax, { master: false }).read();
  assert.equal(result.outcomes.battery, OUTCOME.FAILED);
  assert.equal(result.values.soc, undefined);
  assert.equal(result.values.status, undefined, 'nothing of the block kept');
  assert.equal(result.outcomes.details, OUTCOME.OK);
  assert.equal(sax.device.connections, 2);
});

test('a new connection of a read starts with the serial: another battery there gives nothing', async (t) => {
  const other = {
    100: sunspecRegisters({ serial: [9999, 1] }),
    64: unit64Registers({ soc: 11 }),
    40: unit40Registers({ cycles: 999 }),
  };
  const sax = await startFakeSax({
    silentAddresses: ['64:45'],
    unitsFor: (conn) => (conn.id === 1 ? undefined : other),
  });
  t.after(() => sax.close());
  const old = TIMINGS.requestTimeout;
  TIMINGS.requestTimeout = 150;
  t.after(() => {
    TIMINGS.requestTimeout = old;
  });
  const result = await reader(sax, { master: false }).read();
  assert.equal(result.identity.serial, '1234-56');
  assert.equal(result.outcomes.battery, OUTCOME.FAILED);
  assert.equal(result.identityLost, true);
  assert.equal(result.values.cycles, undefined, 'nothing of the other battery');
  assert.equal(result.error, 'timeout');
  // The same battery on the new connection: the read goes on.
  const same = await startFakeSax({ silentAddresses: ['64:45'] });
  t.after(() => same.close());
  const ok = await reader(same, { master: false }).read();
  assert.equal(ok.identityLost, undefined);
  assert.equal(ok.values.cycles, 210);
});
