// -----------------------------------------------------------------------------
// The Gladys device of each SAX battery and its states. Pure.
//
// External id (forever): battery:<id> (src/sax/identity.js). Feature keys
// (forever): see FEATURE below.
//
// Every battery shows its own values (unit ids 64 and 40 of sax_battery_ha);
// battery A, the master of the group, also shows the values of the whole
// system from the documented SunSpec interface.
//
// Energy rules of the Gladys core and of this project:
// - NO index of the energy monitoring (no `energy-sensor`, no
//   `battery-storage` charge / discharge index, no `grid-sensor`), never
//   publishEnergyConsumption: the meaning, unit and direction of the two
//   energy registers are not documented by SAX (TODO.md); they are plain
//   sensors, kWh in the name, never counted, published as read (they may
//   start over or be periodic: to confirm on a real battery); 0 is unknown,
//   never published;
// - every power whose sign SAX does not document is ONE signed plain sensor,
//   never split, never `grid-sensor`; the solar power (ADW200 meter) is a
//   power of `energy-production-sensor`, never an index;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): % for battery-storage, °C for
//   temperature-sensor, W for energy-production-sensor, none for unknown (the
//   unit is in the name).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  ENERGY_MAX,
  EXTERNAL_ID_TYPE,
  METER_VOLTAGE_MIN,
  POWER_MAX,
  TEMP_MAX,
  TEMP_MIN,
} from './constants.js';

/** Feature keys (forever). */
export const FEATURE = {
  SOC: 'soc',
  POWER: 'power',
  STATUS: 'status',
  TEMPERATURE: 'temperature',
  CYCLES: 'cycles',
  CAPACITY: 'capacity',
  ENERGY_PRODUCED: 'energy_produced',
  ENERGY_CONSUMED: 'energy_consumed',
  SYSTEM_SOC: 'system_soc',
  SYSTEM_POWER: 'system_power',
  CELL_TEMPERATURE: 'cell_temperature',
  STATE: 'state',
  EVENT: 'event',
  STORAGE_EVENT: 'storage_event',
  CHARGE_AVAILABLE: 'charge_available',
  DISCHARGE_AVAILABLE: 'discharge_available',
  SYSTEM_CAPACITY: 'system_capacity',
  PV_POWER: 'pv_power',
  GRID_POWER: 'grid_power',
};

/** The external ids of the battery of platform id `id`. */
export const ids = (gladys, id) => gladys.externalIds(EXTERNAL_ID_TYPE, id);

// --- The catalog ------------------------------------------------------------------
//
// Each entry: the feature key, the value of src/sax/registers.js it shows,
// its rounding, how it is declared, `positive` (0 is unknown), `master` for the values of the whole system (battery A only), and
// `meter` for the values of the ADW200 meter (published only when it reads).

const def = (key, value, digits, spec, extra = {}) => ({ key, value, digits, spec, ...extra });

const measure = (name, category, type, extra = {}) => ({ name, category, type, ...extra });
/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (name, extra = {}) => measure(name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);
const code = (name, max) => measure(name, C.UNKNOWN, T.SENSOR.INTEGER, { max });
const signedWatts = (name) => plain(name, { min: -POWER_MAX * 5, max: POWER_MAX * 5 });
const watts = (name) => plain(`${name} (W)`, { max: POWER_MAX * 5 });
const counter = (name) =>
  plain(`${name} (kWh, as the battery counts it, not counted)`, { max: ENERGY_MAX });
/** A counter as read: never 0 (an unset register), never summed. */
const asRead = { positive: true };
const level = (name) => ({
  ...measure(name, C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_LEVEL),
  unit: U.PERCENT,
  max: 100,
});
const celsius = (name) => ({
  ...measure(name, C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL),
  unit: U.CELSIUS,
  min: TEMP_MIN,
  max: TEMP_MAX,
});

export const CATALOG = [
  def(FEATURE.SOC, 'soc', 0, level('State of charge')),
  def(FEATURE.POWER, 'power', 0, signedWatts('Battery power (W, sign as the battery gives it)')),
  def(FEATURE.STATUS, 'status', 0, code('Status code (unit 64, register 45)', 255)),
  def(FEATURE.TEMPERATURE, 'temperature', 1, celsius('Battery temperature')),
  def(FEATURE.CYCLES, 'cycles', 0, code('Charge cycles', 100_000)),
  def(FEATURE.CAPACITY, 'capacity', 2, plain('Capacity (kWh)', { max: 1000 })),
  def(FEATURE.ENERGY_PRODUCED, 'energyProduced', 3, counter('Energy produced'), asRead),
  def(FEATURE.ENERGY_CONSUMED, 'energyConsumed', 3, counter('Energy consumed'), asRead),
  def(FEATURE.SYSTEM_SOC, 'systemSoc', 0, level('State of charge (whole system)'), {
    master: true,
  }),
  def(
    FEATURE.SYSTEM_POWER,
    'acPower',
    0,
    signedWatts('Storage power, whole system (W, sign as the system gives it)'),
    { master: true },
  ),
  def(FEATURE.CELL_TEMPERATURE, 'cellTemp', 1, celsius('Highest cell temperature'), {
    master: true,
  }),
  def(
    FEATURE.STATE,
    'state',
    0,
    code('State (1 off, 2 standby, 3 waiting, 4 on, 7 meter fault)', 255),
    { master: true },
  ),
  def(
    FEATURE.EVENT,
    'event',
    0,
    code('Event (0 normal, 4 island fault, 8 to 11 grid limits, 15 hardware fault)', 255),
    { master: true },
  ),
  def(
    FEATURE.STORAGE_EVENT,
    'storageEvent',
    0,
    code('Battery event (0 normal, 3 over-temperature, 4 under-temperature)', 255),
    { master: true },
  ),
  def(FEATURE.CHARGE_AVAILABLE, 'chargeAvailable', 0, watts('Charge power available'), {
    master: true,
  }),
  def(FEATURE.DISCHARGE_AVAILABLE, 'dischargeAvailable', 0, watts('Discharge power available'), {
    master: true,
  }),
  def(
    FEATURE.SYSTEM_CAPACITY,
    'systemCapacity',
    2,
    plain('Capacity, whole system (kWh)', { max: 1000 }),
    {
      master: true,
    },
  ),
  def(
    FEATURE.PV_POWER,
    'pvPower',
    0,
    {
      ...measure(
        'Solar power (ADW200 meter)',
        C.ENERGY_PRODUCTION_SENSOR,
        T.ENERGY_PRODUCTION_SENSOR.POWER,
      ),
      unit: U.WATT,
      max: POWER_MAX * 5,
    },
    { master: true, meter: true },
  ),
  def(
    FEATURE.GRID_POWER,
    'gridPower',
    0,
    signedWatts('Grid power (W, sign as the ADW200 meter gives it)'),
    { master: true, meter: true },
  ),
];

/** The feature keys of a created device (its features are fixed at its creation). */
export function keysOfDevice(device) {
  return new Set(
    (device?.features ?? []).map((f) =>
      String(f.external_id ?? '')
        .split(':')
        .at(-1),
    ),
  );
}

/**
 * The catalog entries of a battery: the system values for the master, plus
 * every one the created device already has (published again, a device never
 * loses a feature: "Update" in Discovery would drop its history).
 */
export function entriesFor(master, createdKeys = new Set()) {
  return CATALOG.filter((e) => !e.master || master || createdKeys.has(e.key));
}

/**
 * The device of a battery. `info`: `{ id, address, master, model, versionMaster,
 * versionGateway, field }`; `created`: the device the user created, if any.
 */
export function buildDevice(gladys, info, { created } = {}) {
  const external = ids(gladys, info.id);
  const features = entriesFor(info.master, keysOfDevice(created)).map(({ key, spec }) => ({
    min: 0,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    ...spec,
    external_id: external.feature(key),
  }));
  const letter = String(info.field ?? '')
    .slice(-1)
    .toUpperCase();
  const label = info.master ? `${letter || 'A'}, master` : letter || '?';
  return {
    name: `${info.model ?? 'SAX Power Home'} (${label})`,
    external_id: external.device,
    features,
    params: [
      { name: 'SAX_ADDRESS', value: info.address ?? '' },
      { name: 'SAX_ID', value: info.id },
      { name: 'SAX_VERSION_MASTER', value: info.versionMaster ?? '' },
      { name: 'SAX_VERSION_GATEWAY', value: info.versionGateway ?? '' },
    ],
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Whether the ADW200 meter reads: the mean grid voltage of the SunSpec meter model. */
export const meterPresent = (values) =>
  isNumber(values?.gridVoltage) && values.gridVoltage >= METER_VOLTAGE_MIN;

/** The states of a read. `values`: src/sax/registers.js. */
export function readStates(external, values) {
  const states = [];
  const meter = meterPresent(values);
  for (const { key, value, digits, spec, meter: needsMeter, positive } of CATALOG) {
    const v = !needsMeter || meter ? values[value] : undefined;
    if (!isNumber(v) || (positive && v <= 0)) {
      continue;
    }
    const r = round(v, digits);
    const min = spec.min ?? 0;
    if (r < min || (spec.max !== undefined && r > spec.max)) {
      continue;
    }
    states.push({ device_feature_external_id: external.feature(key), state: r });
  }
  return states;
}
