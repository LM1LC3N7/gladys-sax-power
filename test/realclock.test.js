// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), the
// real reader and two fake SAX batteries on 127.0.0.1 (real Modbus TCP
// sockets): the reads really start at the interval, measured on the method
// that decides, one connection per battery at a time, 500 ms between two
// requests to a battery. The time is sped up 20 times (30 s of the interval
// are 1.5 s), but it is the real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SaxApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import {
  recordingConnect,
  startFakeSax,
  sunspecRegisters,
  unit40Registers,
  unit64Registers,
} from './helpers/fakeSax.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SPEED = 20;

test('real clock x20: each battery read at 0, the interval, twice the interval; one connection each', async (t) => {
  const a = await startFakeSax({ latencyMs: 2 });
  const b = await startFakeSax({
    latencyMs: 2,
    units: {
      100: sunspecRegisters({ serial: [1234, 57] }),
      64: unit64Registers({ soc: 50 }),
      40: unit40Registers(),
    },
  });
  t.after(() => a.close());
  t.after(() => b.close());
  const clock = realClock({ speed: SPEED });
  t.after(() => clock.close());
  // The decision time of each request (simulated ms), stamped as its bytes leave.
  let app;
  const recording = recordingConnect(
    (port) => app.slots.find((s) => s.battery.port === port).reader.lastRequestMono,
  );
  const gladys = createFakeGladys({ selector: 'sax-power', config: {} });
  await gladys.connect();
  app = new SaxApp({
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    connect: recording.connect,
  });
  // `read` dates a read once it is decided (its requests follow).
  const spy = spyOn(app, 'read', clock);
  let gaps;
  try {
    await app.start({ battery_a: `127.0.0.1:${a.port}`, battery_b: `127.0.0.1:${b.port}` });
    const perBattery = (address) => ({
      clock,
      get calls() {
        return spy.calls.filter((c) => c.args[0].battery.address === address);
      },
    });
    const [ga, gb] = await Promise.all([
      measurePeriod(perBattery(`127.0.0.1:${a.port}`), {
        count: 3,
        period: 30_000,
        timeoutMs: 15_000,
      }),
      measurePeriod(perBattery(`127.0.0.1:${b.port}`), {
        count: 3,
        period: 30_000,
        timeoutMs: 15_000,
      }),
    ]);
    gaps = [...ga, ...gb];
  } finally {
    await app.stop();
    await app.idle();
  }
  assert.equal(gaps.length, 4);
  assert.ok(clock.timersSet < 400, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  for (const sax of [a, b]) {
    assert.equal(sax.device.peak, 1, 'one connection at a time');
    // 500 ms (simulated) at least between two requests to the same battery,
    // measured where they leave the client.
    const sent = recording.writes.get(sax.port);
    assert.ok(sent.length >= 7);
    for (let i = 1; i < sent.length; i += 1) {
      const gap = sent[i] - sent[i - 1];
      assert.ok(gap >= TIMINGS.requestGap, `gap ${gap} ms`);
    }
    assert.ok(
      sax.requests.every((q) => q.fc === 3),
      'read requests only',
    );
  }
  // Battery A is the master: its system blocks; B only its own.
  assert.ok(a.requests.some((q) => q.unit === 100 && q.address === 95));
  assert.ok(!b.requests.some((q) => q.unit === 100 && q.address === 95));
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    ['ext:sax-power:battery:sn1234-56', 'ext:sax-power:battery:sn1234-57'],
  );
});
