// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, fake battery readers (the reader
// itself is tested against a fake SAX battery on 127.0.0.1 in
// test/reader.test.js) and the test clock of the kit: every read of the clock
// moves it (1 µs), timers fire on `clock.advance(ms)`. `wall.jump` moves the
// wall clock alone (NTP), never the monotonic one.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SaxApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { OUTCOME } from '../../src/sax/reader.js';
import { createMemoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';

export const SELECTOR = 'sax-power';
export const ADDRESS_A = '192.168.1.50:502';
export const ADDRESS_B = '192.168.1.51:502';
export const SERIAL_A = '1234-56';
export const SERIAL_B = '1234-57';
export const ID_A = `sn${SERIAL_A}`;
export const ID_B = `sn${SERIAL_B}`;
export const DEVICE_A = `ext:${SELECTOR}:battery:${ID_A}`;
export const DEVICE_B = `ext:${SELECTOR}:battery:${ID_B}`;
export const FA = (key) => `${DEVICE_A}:${key}`;
export const FB = (key) => `${DEVICE_B}:${key}`;
export const CONFIG = { battery_a: '192.168.1.50' };
export const CONFIG_AB = { battery_a: '192.168.1.50', battery_b: '192.168.1.51' };
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const POLL = 30 * SECOND;
/** 2026-10-28 10:00 UTC. */
export const START = Date.UTC(2026, 9, 28, 10, 0);

export function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** The values of a read (src/sax/registers.js names), kWh for the energies. */
export const VALUES = {
  status: 3,
  soc: 76,
  power: -1500,
  capacity: 5.76,
  cycles: 210,
  temperature: 27,
  energyProduced: 12.345,
  energyConsumed: 13.456,
};

export const SYSTEM = {
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
};

const ALL_OK = {
  identity: OUTCOME.OK,
  battery: OUTCOME.OK,
  details: OUTCOME.OK,
  energy: OUTCOME.OK,
};

/** A read result as src/sax/reader.js gives it. */
export function result({ serial = SERIAL_A, values = {}, master = true, outcomes = {} } = {}) {
  return {
    reached: true,
    identity:
      serial === null ? undefined : { serial, model: 'SAX Power Home', master: 61, gateway: 54 },
    outcomes: {
      ...ALL_OK,
      ...(master ? { inverter: OUTCOME.OK, meter: OUTCOME.OK, storage: OUTCOME.OK } : {}),
      ...(serial === null ? { identity: OUTCOME.ABSENT } : {}),
      ...outcomes,
    },
    values: { ...VALUES, ...(master ? SYSTEM : {}), ...values },
    error: undefined,
  };
}

export const unreachable = () => ({
  reached: false,
  identity: undefined,
  outcomes: Object.fromEntries(
    ['identity', 'battery', 'inverter', 'meter', 'storage', 'details', 'energy'].map((k) => [
      k,
      OUTCOME.SKIPPED,
    ]),
  ),
  values: {},
  error: 'unreachable',
});

/**
 * Fake readers: `script(battery, n, call)` gives each read result (or a
 * promise of it); `calls` records `{ address, identityRequired }`.
 */
export function createReaders(script) {
  const calls = [];
  const readers = new Map();
  const createReader = (battery) => {
    let n = 0;
    const reader = {
      battery,
      aborts: 0,
      pending: undefined,
      async read(options = {}) {
        n += 1;
        calls.push({ address: battery.address, ...options });
        const answer = script(battery, n, options);
        if (answer && typeof answer.then === 'function') {
          // A read that waits (a slow battery): ended by abort().
          return Promise.race([
            answer,
            new Promise((resolve) => {
              reader.pending = () => resolve({ ...unreachable(), error: 'aborted' });
            }),
          ]);
        }
        return answer;
      },
      abort() {
        reader.aborts += 1;
        reader.pending?.();
      },
    };
    readers.set(battery.address, reader);
    return reader;
  };
  return { calls, readers, createReader };
}

/** The device as the user created it from the discovered one. */
export function created({ id = ID_A, master = true, last = {}, field = 'battery_a' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, { id, address: 'x', master, field });
  const prefix = `ext:${SELECTOR}:battery:${id}`;
  for (const [key, { value, at }] of Object.entries(last)) {
    const feature = device.features.find((f) => f.external_id === `${prefix}:${key}`);
    feature.last_value = value;
    feature.last_value_changed = new Date(at).toISOString();
  }
  return device;
}

export async function setup({
  config = CONFIG,
  script = () => result(),
  devices = [],
  store = createMemoryStore(),
  clock = testClock({ start: START }),
  wire = true,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const logger = createLogger();
  const readers = createReaders((battery, n, options) => script(battery, n, options, clock));
  const wall = { jump: 0 };
  const app = new SaxApp({
    gladys,
    logger,
    now: () => clock.now() + wall.jump,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    createReader: readers.createReader,
  });
  if (wire) registerHandlers(gladys, app, logger);
  /** `ms` later (timers fired on the way), every read done. */
  const advance = async (ms = POLL) => {
    await clock.advance(ms);
    await app.idle();
  };
  return { app, gladys, clock, logger, readers, advance, store, wall };
}

export const status = (gladys) => gladys.fake.connectionStatus;
export const last = (gladys, id) => gladys.fake.lastState(id);
export const text = (message) => `${message?.en} ${message?.fr}`;
/** The states published for one feature, in order. */
export const statesOf = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
