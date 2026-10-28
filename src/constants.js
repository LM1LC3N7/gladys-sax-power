// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js, the external id rule) is
// forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };

/**
 * The external id of a battery: `battery:<id>` (src/sax/identity.js), `<id>`
 * from the serial number of the SunSpec interface (`sn<word 13>-<word 14>`),
 * or, for a battery that has never shown one, from its address
 * (`ip<host>-<port>`).
 */
export const EXTERNAL_ID_TYPE = 'battery';

/** The configuration fields of the batteries: the master first (A), then up to two more. */
export const BATTERY_FIELDS = ['battery_a', 'battery_b', 'battery_c'];

// --- Modbus TCP -----------------------------------------------------------------------
/** The Modbus TCP port of a SAX Power Home (SAX SunSpec documentation). */
export const DEFAULT_PORT = 502;
/** Bytes of the MBAP header (transaction, protocol, length, unit id). */
export const MBAP_SIZE = 7;
/** The longest Modbus TCP frame (MBAP + 253 bytes of PDU). */
export const MAX_FRAME = 260;
/** At most this many registers in one read (Modbus: 125). */
export const MAX_READ = 125;
export const FC = { READ_HOLDING: 3 };
/** Modbus exceptions "illegal function" / "illegal data address": the block is not there. */
export const ABSENT_CODES = [1, 2];

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const TIMINGS = {
  /** Opening the connection. */
  connectTimeout: 5 * SECOND,
  /**
   * Each answer. The SAX documentation: while the e-paper display refreshes,
   * the interface does not answer for 1 to 3 s.
   */
  requestTimeout: 4 * SECOND,
  /** A graceful close waits this long for the battery's side, then destroys the socket. */
  closeWait: 500,
  /** The SAX documentation: at most one access every 500 ms. */
  requestGap: 500,
  /** One battery read, whatever happens (a stuck battery never holds the others' next read). */
  readBudget: 45 * SECOND,
};

/** A read opens at most this many connections to a battery (a timeout ends one). */
export const SESSIONS_PER_READ = 3;
/** A block that fails this many reads in a row is skipped for SKIP_READS reads. */
export const BLOCK_FAILURES = 3;
export const SKIP_READS = 10;
/**
 * A battery without a serial number (no SunSpec interface: an older firmware,
 * or a battery of a group that leaves it to the master) gets an id from its
 * address only after this many reads in a row where its unit 64 answered and
 * its SunSpec identity did not (refused, unmarked or silent alike; a read
 * where the identity was skipped counts nothing).
 */
export const FALLBACK_AFTER = 3;

// --- Schedule ------------------------------------------------------------------------
/** The reading interval of the form (s): 30 s by default, 15 to 300. */
export const POLL_DEFAULT = 30;
export const POLL_MIN = 15;
export const POLL_MAX = 300;
/** How often the integration looks whether a read is due (never a read by itself). */
export const TICK = 5 * SECOND;
/**
 * The instant of the last read is written to /data at most once a minute:
 * after a restart, the first read waits this long on top of the interval, so
 * that a container restarting in a loop never reads faster than the interval.
 */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** The states sent in any 60 s, at most (the core refuses a whole batch beyond 300). */
export const STATES_PER_MINUTE = 270;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** All batteries unreachable: tried again after 1 min (never faster than a read), doubled up to 15 min. */
export const RETRY_MIN = MINUTE;
export const RETRY_MAX = 15 * MINUTE;
/** getConfig() failed: asked again after 5 s, 15 s, 30 s, then every minute, without end. */
export const CONFIG_RETRY = [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE];
/** The test button answers within this delay. */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** Values older than this many intervals are no longer published as current. */
export const FRESH_INTERVALS = 2;

// --- Values ---------------------------------------------------------------------------
/** A power beyond this (W, either sign) is not a measure. */
export const POWER_MAX = 20_000;
/**
 * The power of ONE battery (unit 64) beyond this (W, either sign) is not a
 * measure: a SAX Power Home gives 4.6 kW at most (SunSpec 40053); the raw
 * words 0 and 0xFFFF (-16 384 and -16 385 W after the offset) are refused.
 */
export const BATTERY_POWER_MAX = 10_000;
/** An energy counter above this (kWh) is not a measure. */
export const ENERGY_MAX = 1_000_000;
/** Temperatures outside this range (°C) are not measures. */
export const TEMP_MIN = -40;
export const TEMP_MAX = 100;
/** A SunSpec scale factor outside this range is not one (sax_battery_ha: -10..10). */
export const SF_MIN = -10;
export const SF_MAX = 10;
/** The grid meter (ADW200) is there when the mean grid voltage reads at least this (V). */
export const METER_VOLTAGE_MIN = 100;
