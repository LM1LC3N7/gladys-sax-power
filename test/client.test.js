// -----------------------------------------------------------------------------
// The Modbus TCP client on real sockets (the TCP server of the kit on
// 127.0.0.1): only the answer to its own request (transaction, protocol, unit
// id, function), a frame bounded before it is complete, in any cut of
// segments, a late answer never taken for the next request, every wait bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, openSession } from '../src/modbus/client.js';
import { readRequest } from '../src/sax/registers.js';
import { blackhole } from './kit/net.mjs';
import { tcpServer } from './kit/tcp.mjs';

const frame = (transaction, unit, pdu, { protocol = 0, length } = {}) => {
  const head = Buffer.alloc(7);
  head.writeUInt16BE(transaction, 0);
  head.writeUInt16BE(protocol, 2);
  head.writeUInt16BE(length ?? pdu.length + 1, 4);
  head[6] = unit;
  return Buffer.concat([head, Buffer.from(pdu)]);
};
const tx = (chunk) => chunk.readUInt16BE(0);
const unitOf = (chunk) => chunk[6];
const words = (...w) => {
  const b = Buffer.alloc(2 + w.length * 2);
  b[0] = 3;
  b[1] = w.length * 2;
  w.forEach((v, i) => b.writeUInt16BE(v, 2 + i * 2));
  return b;
};

async function session(device) {
  const opened = openSession({ host: '127.0.0.1', port: device.port });
  return opened.promise;
}

test('a good answer, even cut in single bytes', async (t) => {
  const device = await tcpServer({
    onData: (chunk, conn) => {
      const answer = frame(tx(chunk), unitOf(chunk), words(7, 8));
      (async () => {
        for (const byte of answer) {
          conn.write(Buffer.from([byte]));
          await new Promise((r) => setTimeout(r, 1));
        }
      })();
      return undefined;
    },
  });
  t.after(() => device.close());
  const s = await session(device);
  const pdu = await s.request(readRequest(45, 2), { unitId: 64 });
  assert.deepEqual([...pdu], [3, 4, 0, 7, 0, 8]);
  await s.close();
});

test('an exception is a refusal; the session goes on', async (t) => {
  let n = 0;
  const device = await tcpServer({
    onData: (chunk) => {
      n += 1;
      return n === 1
        ? frame(tx(chunk), unitOf(chunk), [0x83, 2])
        : frame(tx(chunk), unitOf(chunk), words(1));
    },
  });
  t.after(() => device.close());
  const s = await session(device);
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 100 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.REFUSED);
    assert.equal(err.code, 2);
    return true;
  });
  const pdu = await s.request(readRequest(0, 1), { unitId: 100 });
  assert.equal(pdu[0], 3);
  await s.close();
});

for (const [name, make] of [
  ['another transaction', (c) => frame(tx(c) + 1, unitOf(c), words(1))],
  ['another unit id', (c) => frame(tx(c), 41, words(1))],
  ['another protocol', (c) => frame(tx(c), unitOf(c), words(1), { protocol: 1 })],
  ['another function', (c) => frame(tx(c), unitOf(c), [4, 2, 0, 1])],
  [
    'a frame announced longer than Modbus allows',
    (c) => frame(tx(c), unitOf(c), [3, 2], { length: 400 }),
  ],
  [
    'bytes beyond the frame',
    (c) => Buffer.concat([frame(tx(c), unitOf(c), words(1)), Buffer.from([0])]),
  ],
  ['a bad exception answer', (c) => frame(tx(c), unitOf(c), [0x83, 2, 9])],
]) {
  test(`${name}: the session ends, nothing taken`, async (t) => {
    const device = await tcpServer({ onData: make });
    t.after(() => device.close());
    const s = await session(device);
    await assert.rejects(s.request(readRequest(0, 1), { unitId: 64 }), (err) => {
      assert.equal(err.kind, ERROR_KINDS.PROTOCOL);
      return true;
    });
    await assert.rejects(s.request(readRequest(0, 1), { unitId: 64 }));
  });
}

test('an answer longer than a frame is cut before it is complete', async (t) => {
  // The header announces a frame of the largest size, then more bytes come at once.
  const device = await tcpServer({
    onData: (c) =>
      Buffer.concat([frame(tx(c), unitOf(c), [3, 250], { length: 254 }), Buffer.alloc(300)]),
  });
  t.after(() => device.close());
  const s = await session(device);
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 64 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.PROTOCOL);
    assert.equal(err.message, 'answer longer than a frame');
    return true;
  });
});

test('no answer: a timeout ends the session; the late answer is never taken', async (t) => {
  const device = await tcpServer({
    latencyMs: 200,
    onData: (c) => frame(tx(c), unitOf(c), words(1)),
  });
  t.after(() => device.close());
  const s = await session(device);
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 64, timeoutMs: 50 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    return true;
  });
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 64 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    return true;
  });
});

test('bytes with no request waiting end the session', async (t) => {
  const device = await tcpServer({ onConnect: () => Buffer.from([1, 2, 3]) });
  t.after(() => device.close());
  const s = await session(device);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.dead?.kind, ERROR_KINDS.PROTOCOL);
});

test('one request at a time; a bad unit id never leaves', async (t) => {
  const device = await tcpServer({
    latencyMs: 50,
    onData: (c) => frame(tx(c), unitOf(c), words(1)),
  });
  t.after(() => device.close());
  const s = await session(device);
  const first = s.request(readRequest(0, 1), { unitId: 64 });
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 64 }), /already waiting/);
  await first;
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 256 }), /bad unit id/);
  assert.equal(device.received.length, 1);
  await s.close();
});

test('a connection that never opens or a device that never answers: bounded', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const opened = openSession({ host: '127.0.0.1', port: hole.port });
  const s = await opened.promise;
  const started = performance.now();
  await assert.rejects(s.request(readRequest(0, 1), { unitId: 1, timeoutMs: 100 }));
  assert.ok(performance.now() - started < 1000);
  const refused = openSession({ host: '127.0.0.1', port: 1 });
  await assert.rejects(refused.promise, (err) => err.kind === ERROR_KINDS.UNREACHABLE);
  const aborted = openSession({ host: '10.255.255.1', port: 502, timeoutMs: 5000 });
  aborted.abort();
  await assert.rejects(aborted.promise, (err) => err.kind === ERROR_KINDS.ABORTED);
});
