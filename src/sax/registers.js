// -----------------------------------------------------------------------------
// The registers of a SAX Power Home / Home Plus (pure): the blocks read, their
// requests, and what their answers hold. Read-only: only function 3 (read
// holding registers) is ever built here.
//
// Two sources, kept apart:
// - the SunSpec interface (unit id 100), from the SAX documentation
//   "SAX Power Home/Home Plus Modbus-TCP Dokumentation (SUNSPEC-Mode)"
//   (firmware Master V61 / Gateway V54 and later, June 2026, in the
//   repository of sax_battery_ha: docs/SAX_Modbus_SunSpec_Dokumentation.pdf).
//   Its table numbers the registers 40000-40114; on the wire they are 0-114
//   (sax_battery_ha, checked there live register by register). The fixed
//   "well-known" words are checked on every read (the "SunS" marker, the
//   common model 1 of length 15 by "SAXPOWER", the model ids 103, 203 and
//   802): a block whose marker is not there holds
//   no value. The SAX documentation advises reading only the master of a
//   group (it holds the values of the whole system): the system blocks are
//   read on battery A only;
// - the per-battery registers of sax_battery_ha (hub.py, `_get_register_map`,
//   v0.2.4.1), from an older SAX Modbus manual its code quotes (not
//   published): unit 64 (status, state of charge, power, with the offset of
//   16384) and unit 40 (energies, capacity, cycles, temperature). Same
//   addresses, unit ids, scales and offsets as the reference; read on every
//   battery. Their meaning beyond the reference is not documented by SAX
//   (TODO.md).
//
// A decoder returns only the values it can read: an answer of another size, a
// marker missing, a SunSpec "not implemented" word (0x8000 signed, 0xFFFF
// unsigned) or scale factor, or a value out of its range is unknown, never 0.
// -----------------------------------------------------------------------------

import {
  BATTERY_POWER_MAX,
  FC,
  MAX_READ,
  POWER_MAX,
  SF_MAX,
  SF_MIN,
  TEMP_MAX,
  TEMP_MIN,
} from '../constants.js';

const SUNSPEC = 100;
/** The "SunS" marker (SAX documentation, 40000-40001) and the model id of "Common". */
export const SUNS = [21365, 28243];
/** "SAXPOWER" (SAX documentation, 40004-40007, well-known). */
export const SAXPOWER = [21313, 22608, 20311, 17746];

/**
 * The blocks, in the order of a read: the identity first (every value of a
 * read goes to the battery it names), then the values of the battery, the
 * system blocks (master only), the energies.
 * - `unit`, `address`, `count`: the request;
 * - `checks`: well-known words that must be there (address -> value);
 * - `points`: the registers used (the single reads of a block whose whole
 *   read is refused ask exactly these, as sax_battery_ha does);
 * - `master`: read on battery A only.
 */
export const BLOCKS = [
  {
    key: 'identity',
    unit: SUNSPEC,
    address: 0,
    count: 15,
    checks: {
      0: SUNS[0],
      1: SUNS[1],
      2: 1,
      3: 15,
      4: SAXPOWER[0],
      5: SAXPOWER[1],
      6: SAXPOWER[2],
      7: SAXPOWER[3],
    },
    points: [8, 9, 10, 11, 12, 13, 14],
  },
  {
    key: 'battery',
    unit: 64,
    address: 45,
    count: 4,
    points: [45, 46, 47],
  },
  {
    key: 'inverter',
    unit: SUNSPEC,
    address: 15,
    count: 32,
    checks: { 15: 103 },
    points: [29, 30, 41, 42, 43, 44, 45, 46],
    master: true,
  },
  {
    key: 'meter',
    unit: SUNSPEC,
    address: 54,
    count: 41,
    checks: { 54: 203 },
    points: [61, 69, 72, 76],
    master: true,
  },
  {
    key: 'storage',
    unit: SUNSPEC,
    address: 95,
    count: 20,
    checks: { 95: 802 },
    points: [97, 98, 99, 102, 108, 110, 111, 112],
    master: true,
  },
  {
    key: 'details',
    unit: 40,
    address: 40115,
    count: 3,
    points: [40115, 40116, 40117],
  },
  {
    key: 'energy',
    unit: 40,
    address: 40096,
    count: 2,
    points: [40096, 40097],
  },
];

export const BLOCK = Object.fromEntries(BLOCKS.map((b) => [b.key, b]));

/** The registers a single read of `block` asks, one by one: its checks, then its points. */
export const singleRegisters = (block) => [
  ...Object.keys(block.checks ?? {}).map(Number),
  ...block.points,
];

/** The read request of `count` registers from `address` (function 3). */
export function readRequest(address, count) {
  if (
    !Number.isInteger(address) ||
    address < 0 ||
    address > 0xffff ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_READ ||
    address + count > 0x10000
  ) {
    throw new RangeError(`read of ${count} registers at ${address}`);
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.READ_HOLDING;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead(count, pdu) {
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== FC.READ_HOLDING) return undefined;
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(pdu.readUInt16BE(2 + i * 2));
  return words;
}

/** The words of a whole block answer as a map address -> word. */
export function wordsOf(block, words) {
  const map = new Map();
  if (!Array.isArray(words) || words.length !== block.count) return map;
  words.forEach((w, i) => map.set(block.address + i, w));
  return map;
}

const isWord = (w) => Number.isInteger(w) && w >= 0 && w <= 0xffff;
const u16 = (map, a) => {
  const w = map.get(a);
  return isWord(w) && w !== 0xffff ? w : undefined;
};
const i16 = (map, a) => {
  const w = map.get(a);
  if (!isWord(w) || w === 0x8000) return undefined;
  return w >= 0x8000 ? w - 0x10000 : w;
};
/** A SunSpec scale factor (int16 power of ten), within -10..10. */
const sf = (map, a) => {
  const v = i16(map, a);
  return v !== undefined && v >= SF_MIN && v <= SF_MAX ? v : undefined;
};
const scaled = (raw, factor) => {
  if (raw === undefined || factor === undefined) return undefined;
  // Exact for negative powers: 1234 * 10^-2 = 12.34, never 12.340000000000002.
  const v = factor >= 0 ? raw * 10 ** factor : raw / 10 ** -factor;
  return Number.isFinite(v) ? v : undefined;
};
const within = (v, min, max) => (v !== undefined && v >= min && v <= max ? v : undefined);

/** Whether every well-known word of `block` is there. */
export function checksPass(block, map) {
  return Object.entries(block.checks ?? {}).every(([a, v]) => map.get(Number(a)) === v);
}

/** Two registers of a SunSpec string (high byte first) as ASCII letters, or ''. */
function letters(map, addresses) {
  let text = '';
  for (const a of addresses) {
    const w = map.get(a);
    if (!isWord(w)) return '';
    for (const b of [(w >> 8) & 0xff, w & 0xff]) {
      if (b === 0) continue;
      if (b < 0x20 || b > 0x7e) return '';
      text += String.fromCharCode(b);
    }
  }
  return text.trim();
}

/**
 * The identity of a SunSpec answer: `{ serial, model, master, gateway }`, or
 * undefined when the markers are not there. `serial` is undefined when both
 * words are 0 or 0xFFFF (none programmed): no identity then.
 */
export function decodeIdentity(map) {
  if (!checksPass(BLOCK.identity, map)) return undefined;
  const hi = map.get(13);
  const lo = map.get(14);
  const serial =
    isWord(hi) && isWord(lo) && !(hi === 0 && lo === 0) && !(hi === 0xffff && lo === 0xffff)
      ? `${hi}-${lo}`
      : undefined;
  const family = letters(map, [8, 9]);
  const variant = letters(map, [10]);
  const model =
    family === 'HOME' ? (variant === 'PL' ? 'SAX Power Home Plus' : 'SAX Power Home') : undefined;
  return { serial, model, master: u16(map, 11), gateway: u16(map, 12) };
}

/**
 * The values of a block (by name), from its words (address -> word): only
 * those that read and are in range. A block whose markers are missing gives
 * nothing.
 */
export function decodeBlock(block, map) {
  const out = {};
  const set = (name, value) => {
    if (value !== undefined && Number.isFinite(value)) out[name] = value;
  };
  if (!checksPass(block, map)) return out;
  switch (block.key) {
    case 'battery': {
      // Unit 64 (sax_battery_ha): 45 status, 46 state of charge (%),
      // 47 power (W): raw - 16384, then read as a signed 16-bit word.
      const status = u16(map, 45);
      set('status', within(status, 0, 255));
      set('soc', within(u16(map, 46), 0, 100));
      const raw = map.get(47);
      if (isWord(raw)) {
        let power = raw - 16384;
        if (power >= 0x8000) power -= 0x10000;
        set('power', within(power, -BATTERY_POWER_MAX, BATTERY_POWER_MAX));
      }
      break;
    }
    case 'inverter': {
      set('acPower', within(scaled(i16(map, 29), sf(map, 30)), -POWER_MAX, POWER_MAX));
      set('cellTemp', within(scaled(i16(map, 41), sf(map, 42)), TEMP_MIN, TEMP_MAX));
      set('state', within(u16(map, 43), 0, 255));
      set('event', within(u16(map, 44), 0, 255));
      set('pvPower', within(scaled(u16(map, 45), sf(map, 46)), 0, POWER_MAX * 5));
      break;
    }
    case 'meter': {
      set('gridVoltage', within(scaled(u16(map, 61), sf(map, 69)), 0, 1000));
      set('gridPower', within(scaled(i16(map, 72), sf(map, 76)), -POWER_MAX * 5, POWER_MAX * 5));
      break;
    }
    case 'storage': {
      const capacity = scaled(u16(map, 97), sf(map, 110));
      set('systemCapacity', capacity > 0 ? within(capacity / 1000, 0, 1000) : undefined);
      const cd = sf(map, 111);
      set('chargeAvailable', within(scaled(u16(map, 98), cd), 0, POWER_MAX * 5));
      set('dischargeAvailable', within(scaled(u16(map, 99), cd), 0, POWER_MAX * 5));
      set('systemSoc', within(scaled(u16(map, 102), sf(map, 112)), 0, 100));
      set('storageEvent', within(u16(map, 108), 0, 255));
      break;
    }
    case 'details': {
      // Unit 40 (sax_battery_ha): 40115 capacity (x 10 Wh), 40116 cycles, 40117 temperature (°C).
      const capacity = u16(map, 40115);
      set('capacity', capacity > 0 ? within((capacity * 10) / 1000, 0, 1000) : undefined);
      set('cycles', within(u16(map, 40116), 1, 100_000));
      set('temperature', within(i16(map, 40117), TEMP_MIN, TEMP_MAX));
      break;
    }
    case 'energy': {
      // Unit 40 (sax_battery_ha): 40096 "energy produced", 40097 "energy
      // consumed", Wh (its scale 0.001 to kWh). Raw words: 0 is never a value
      // (src/guard.js refuses it), 0xFFFF is a word like any other here.
      const word = (a) => (isWord(map.get(a)) ? map.get(a) : undefined);
      const produced = word(40096);
      const consumed = word(40097);
      if (produced !== undefined) set('energyProduced', produced / 1000);
      if (consumed !== undefined) set('energyConsumed', consumed / 1000);
      break;
    }
    default:
      break;
  }
  return out;
}
