// -----------------------------------------------------------------------------
// A fake SAX Power Home on 127.0.0.1 (the TCP server of the kit), speaking
// Modbus TCP as the SAX documentation and sax_battery_ha describe it: the
// SunSpec interface on unit id 100 (wire addresses 0-114), the per-battery
// registers on unit ids 64 (45-48) and 40 (40096-40097, 40115-40117).
// Function 3 only; any other function gets exception 1, a register it does
// not hold exception 2. Records every request (unit, address, count, time,
// connection). Never leaves the loopback.
// -----------------------------------------------------------------------------

import { tcpConnect } from '../../src/modbus/client.js';
import { tcpServer } from '../kit/tcp.mjs';

const s16 = (v) => (v < 0 ? v + 0x10000 : v);

/** The SunSpec registers of a master with an ADW200 meter (wire address -> word). */
export function sunspecRegisters({ serial = [1234, 56], plus = false, overrides = {} } = {}) {
  const r = new Map();
  const put = (a, v) => r.set(a, s16(v));
  [21365, 28243, 1, 15, 21313, 22608, 20311, 17746, 18511, 19781].forEach((v, i) => put(i, v));
  put(10, plus ? 20556 : 0);
  put(11, 61);
  put(12, 54);
  put(13, serial[0]);
  put(14, serial[1]);
  // Model 103 (15-46).
  for (let a = 15; a <= 46; a += 1) put(a, 0);
  put(15, 103);
  put(16, 32);
  put(21, -2);
  put(28, -1);
  put(29, -1500);
  put(30, 0);
  put(31, 5000);
  put(32, -2);
  put(38, -3);
  put(41, 28);
  put(42, 0);
  put(43, 4);
  put(44, 0);
  put(45, 320);
  put(46, 1);
  // Model 123 (47-53).
  [123, 7, 0, 300, 0, -2, 4600].forEach((v, i) => put(47 + i, v));
  // Model 203 (54-94).
  for (let a = 54; a <= 94; a += 1) put(a, 0);
  put(54, 203);
  put(55, 41);
  put(60, -1);
  put(61, 2301);
  put(62, 2301);
  put(63, 2299);
  put(64, 2305);
  put(69, -1);
  put(70, 5000);
  put(71, -2);
  put(72, -45);
  put(76, 1);
  put(81, 1);
  put(86, 1);
  put(91, -3);
  put(94, 3);
  // Model 802 (95-114).
  for (let a = 95; a <= 114; a += 1) put(a, 0);
  put(95, 802);
  put(96, 20);
  put(97, 5760);
  put(98, 4600);
  put(99, 4600);
  put(100, 100);
  put(101, 10);
  put(102, 77);
  put(103, 90);
  put(106, 1);
  put(109, 3300);
  for (const [a, v] of Object.entries(overrides)) put(Number(a), v);
  return r;
}

/** Unit 64 (sax_battery_ha): status 3, 76 %, -1500 W (raw + 16384). */
export function unit64Registers({ status = 3, soc = 76, power = -1500 } = {}) {
  return new Map([
    [45, status],
    [46, soc],
    [47, power + 16384],
    [48, 16384 + 300],
  ]);
}

/** Unit 40 (sax_battery_ha): energies in Wh, capacity x 10 Wh, cycles, °C. */
export function unit40Registers({
  produced = 12_345,
  consumed = 13_456,
  capacity = 576,
  cycles = 210,
  temperature = 27,
} = {}) {
  return new Map([
    [40096, produced],
    [40097, consumed],
    [40115, capacity],
    [40116, cycles],
    [40117, temperature],
  ]);
}

/**
 * `options`: `units` (unit id -> Map of registers; a unit left out answers
 * exception 2 to everything), `silentUnits` (never answered), `wholeRefused`
 * (a read of more than one register gets exception 2, as a unit that only
 * takes single reads), `latencyMs`, `singleClient`.
 */
export async function startFakeSax({
  units = { 100: sunspecRegisters(), 64: unit64Registers(), 40: unit40Registers() },
  silentUnits = [],
  wholeRefused = false,
  latencyMs = 0,
  singleClient = false,
} = {}) {
  const requests = [];
  const state = { units, silentUnits: new Set(silentUnits), wholeRefused };
  const onData = (chunk, conn) => {
    const out = [];
    let at = 0;
    while (at + 8 <= chunk.length) {
      const length = chunk.readUInt16BE(at + 4);
      const frame = chunk.subarray(at, at + 6 + length);
      at += 6 + length;
      const transaction = frame.readUInt16BE(0);
      const unit = frame[6];
      const fc = frame[7];
      const address = frame.length >= 12 ? frame.readUInt16BE(8) : -1;
      const count = frame.length >= 12 ? frame.readUInt16BE(10) : -1;
      requests.push({ at: performance.now(), conn: conn.id, unit, fc, address, count });
      if (state.silentUnits.has(unit)) continue;
      const answer = (pdu) => {
        const head = Buffer.alloc(7);
        head.writeUInt16BE(transaction, 0);
        head.writeUInt16BE(0, 2);
        head.writeUInt16BE(pdu.length + 1, 4);
        head[6] = unit;
        out.push(Buffer.concat([head, pdu]));
      };
      const exception = (code) => answer(Buffer.from([fc | 0x80, code]));
      if (fc !== 3) {
        exception(1);
        continue;
      }
      const regs = state.units[unit];
      if (!regs || count < 1 || count > 125 || (state.wholeRefused && count > 1)) {
        exception(2);
        continue;
      }
      const words = [];
      for (let a = address; a < address + count; a += 1) words.push(regs.get(a));
      if (words.some((w) => w === undefined)) {
        exception(2);
        continue;
      }
      const pdu = Buffer.alloc(2 + count * 2);
      pdu[0] = 3;
      pdu[1] = count * 2;
      words.forEach((w, i) => pdu.writeUInt16BE(w, 2 + i * 2));
      answer(pdu);
    }
    return out.length > 0 ? Buffer.concat(out) : undefined;
  };
  const device = await tcpServer({ onData, latencyMs, singleClient });
  return {
    port: device.port,
    device,
    requests,
    state,
    set(unit, address, value) {
      state.units[unit].set(address, s16(value));
    },
    close: () => device.close(),
  };
}

/**
 * A connector that records, for each request leaving the client, `stamp()`
 * (by port): pass the reader's own decision time (`lastRequestMono`, set
 * right before the request) to measure the gap the client decided, never
 * blurred by delivery or a pause of the process under load.
 */
export function recordingConnect(stamp = () => performance.now()) {
  const writes = new Map();
  const connect = (host, port) => {
    const socket = tcpConnect(host, port);
    const write = socket.write.bind(socket);
    socket.write = (data, ...rest) => {
      if (!writes.has(port)) writes.set(port, []);
      writes.get(port).push(stamp(port));
      return write(data, ...rest);
    };
    return socket;
  };
  return { connect, writes };
}
