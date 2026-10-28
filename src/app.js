// -----------------------------------------------------------------------------
// The integration itself: the SAX batteries of the configuration (battery A,
// the master, and up to two more), each read every 30 s by default over its
// own Modbus TCP connection (src/sax/reader.js), their devices and the test
// button. index.js and src/handlers.js only wire the SDK handlers to it.
//
// READ-ONLY: only read requests (function 3) ever leave (src/sax/registers.js);
// nothing of a battery is ever set (no onSetValue at all). The "pilot mode"
// of sax_battery_ha (charge and discharge limits, power set-point) is not
// ported.
//
// Pace: nothing reads a battery faster than the interval: not the timer, not
// the test button, not Discovery, not a (re)connection to Gladys, not a save
// of an unchanged configuration, not a restart of the container (the instant
// of the last read is kept in /data, written at most once a minute). A new
// address may be read at once. One read per battery at a time, whatever asks
// (a read running is never doubled), one request at a time on it; the
// batteries are read side by side and independently: one that does not
// answer never delays nor pauses the others. A stop cuts every read.
//
// A read belongs to its generation (each start/stop opens a new one): a read
// that ends after a restart or a new configuration publishes nothing and sets
// no status. Identity: every read asks the serial number, and again at the
// start of every new connection of the read (src/sax/reader.js,
// src/sax/identity.js); the values only go to the device of the battery read.
//
// Clocks: `monotonic` paces the reads, so that a wall clock set back never
// stops them. The wall clock only dates what /data keeps for a restart and
// the texts. Each decision reads each clock once. A monotonic instant belongs
// to its process: none is kept in /data.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ATTEMPT_SAVE_EVERY,
  CONFIG_RETRY,
  FRESH_INTERVALS,
  RETRY_MAX,
  RETRY_MIN,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
  TICK,
} from './constants.js';
import { buildDevice, ids, keysOfDevice, readStates } from './devices.js';
import { T } from './i18n.js';
import { tcpConnect } from './modbus/client.js';
import { addressId, resolveIdentity, serialId, validSlot } from './sax/identity.js';
import { BatteryReader, OUTCOME } from './sax/reader.js';
import { createFileStore, readState } from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

const MINUTE = 60_000;

export class SaxApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sax-power' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    connect = tcpConnect,
    createReader,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.createReader =
      createReader ??
      ((battery) =>
        new BatteryReader({ ...battery, connect, timers: this.timers, monotonic: this.monotonic }));
    this.store = store;
    this.loadStore();
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** The batteries of the configuration, with their runtime state (see slotOf). */
    this.slots = [];
    this.saveFailed = false;
    this.publishedDevices = undefined;
    /** The states sent in the last minute: `[{ at, count }]`, monotonic (STATES_PER_MINUTE). */
    this.sent = [];
    this.timer = undefined;
    this.firstRun = Promise.resolve();
    this.lastStatus = undefined;
    this.statusChain = Promise.resolve();
    this.generation = 0;
    this.lifecycle = Promise.resolve();
    /** getConfig() in `connected`: the attempt running, its failures, its timer. */
    this.configAttempt = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
  }

  /**
   * Reads /data. A file that cannot be read is never taken as empty: nothing
   * is written over it (saveState) and no identity is learned until a later
   * start reads it.
   */
  loadStore() {
    const loaded = this.store.load();
    this.storeUnreadable = Boolean(loaded?.unreadable);
    if (this.storeUnreadable) {
      this.logger.warn('SAX: the state file in /data cannot be read: left as it is');
    }
    this.kept = readState(loaded?.data, this.now());
    this.savedAttemptAt = this.kept.lastAttemptAt;
    // After a restart: the first reads wait the interval and the minute the
    // last read may have come after the one written (a monotonic deadline of
    // THIS process; `undefined` is "no wait", never told by its sign).
    const mono = this.monotonic();
    const now = this.now();
    this.restartMono =
      this.kept.lastAttemptAt > 0
        ? mono - Math.max(0, now - this.kept.lastAttemptAt) + ATTEMPT_SAVE_EVERY
        : undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `connected` (the first connection and each reconnection): the
   * configuration asked from Gladys, again and again while it fails (5 s,
   * 15 s, 30 s, then every minute, without end), then a start.
   */
  async connectedVia(getConfig) {
    this.cancelConfigRetry();
    const attempt = ++this.configAttempt;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (attempt !== this.configAttempt) return;
      const wait = CONFIG_RETRY[Math.min(this.configFailures, CONFIG_RETRY.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `SAX: reading the configuration from Gladys failed (${err?.name ?? 'Error'}); again in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configRetry(wait));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (attempt === this.configAttempt) {
          this.connectedVia(getConfig).catch((e) =>
            this.logger.error(`SAX: start failed (${e?.name ?? 'Error'})`),
          );
        }
      }, wait);
      return;
    }
    if (attempt !== this.configAttempt) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  cancelConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** `fresh`: the user saved the form (not a reconnection). */
  start(raw = {}, { fresh = false } = {}) {
    if (fresh) {
      // A save wins over a getConfig() still being retried.
      this.configAttempt += 1;
      this.cancelConfigRetry();
    }
    return this.serialize(() => this.doStart(raw, { fresh }));
  }

  stop() {
    this.configAttempt += 1;
    this.cancelConfigRetry();
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the reads after it are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.firstRun;
    await Promise.all(this.slots.map((s) => s.busy));
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * The runtime state of a battery of the configuration. The battery of the
   * same address and role keeps its pace and its reader (a save of the form
   * reads it no sooner); a new address starts afresh (read at once).
   */
  slotOf(battery, previous) {
    const old = previous.find(
      (s) => s.battery.address === battery.address && s.battery.master === battery.master,
    );
    if (old) {
      old.battery = battery;
      return old;
    }
    return {
      battery,
      reader: this.createReader(battery),
      busy: undefined,
      lastAttemptMono: undefined,
      failures: 0,
      retryAtMono: undefined,
      lastError: undefined,
      values: undefined,
      valuesAt: undefined,
      readAt: undefined,
      id: undefined,
      note: undefined,
      outcomes: undefined,
    };
  }

  async doStart(raw, { fresh = false } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    if (this.storeUnreadable) {
      // Read again: maybe readable now (never taken as empty meanwhile).
      this.loadStore();
    }
    this.config = normalizeConfig(raw);
    const previous = this.slots;
    this.slots = this.config.batteries.map((b) => this.slotOf(b, previous));
    for (const slot of this.slots) {
      if (!previous.includes(slot)) slot.values = undefined;
    }
    await this.saveState();
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again.
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    if (!fresh) {
      // A (re)connection: every value again at the next read (none now).
      this.gladys.forgetPublishedStates?.();
    }
    await this.discover();
    await this.updateStatus({ starting: true });
    // Always armed, whatever the first read gives: never a dead integration.
    this.timer = this.timers.setInterval(() => this.run(generation, () => this.tick()), TICK);
    this.firstRun = this.run(generation, () => this.tick());
  }

  async doStop() {
    this.generation += 1;
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
    // The reads running (if any) are cut: one connection per battery at a time.
    for (const slot of this.slots) slot.reader.abort?.();
    await Promise.all(this.slots.map((s) => s.busy));
    // /data written on a clean stop too.
    await this.saveState();
  }

  /** Run a job of a generation: nothing after a restart. */
  async run(generation, job) {
    if (generation !== this.generation) {
      return undefined;
    }
    try {
      return await job();
    } catch (err) {
      this.logger.error(`SAX: unexpected error (${err?.name ?? 'Error'})`);
      return undefined;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  // --- Identity and devices ---------------------------------------------------------

  /** What /data keeps for the address of `slot` (created on first use). */
  keptSlot(slot) {
    const { address } = slot.battery;
    this.kept.slots[address] ??= validSlot({});
    return this.kept.slots[address];
  }

  /**
   * The platform id of the battery of `slot` for Discovery: the one of the
   * last read, else what /data knows of its address (a serial, or the
   * fallback to the address), else none.
   */
  idOf(slot) {
    if (slot.id) return slot.id;
    const kept = this.kept.slots[slot.battery.address];
    if (kept?.serial) return serialId(kept.serial);
    if (kept?.fallback) return addressId(slot.battery.host, slot.battery.port);
    return undefined;
  }

  /** The created Gladys device of platform id `id`, undefined until the user creates it. */
  createdDevice(id) {
    if (!id) return undefined;
    const external = ids(this.gladys, id).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === external);
  }

  info(slot, id) {
    return {
      id,
      field: slot.battery.field,
      address: slot.battery.address,
      master: slot.battery.master,
      ...this.kept.info[id],
    };
  }

  async discover({ force = false } = {}) {
    const devices = [];
    const seen = new Set();
    for (const slot of this.slots) {
      const id = this.idOf(slot);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      devices.push(
        buildDevice(this.gladys, this.info(slot, id), { created: this.createdDevice(id) }),
      );
    }
    const json = JSON.stringify(devices);
    if (!force && json === this.publishedDevices) {
      return;
    }
    this.publishedDevices = json;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) =>
        this.logger.warn(`Publishing the SAX devices failed (${err?.name ?? 'Error'})`),
      );
  }

  /** The Discover tab: the batteries known, published again; never a request to a battery. */
  async scan() {
    await this.discover({ force: true });
    await this.updateStatus();
  }

  isFresh(slot, mono = this.monotonic()) {
    return (
      slot.values !== undefined &&
      mono - slot.valuesAt <= FRESH_INTERVALS * this.config.pollInterval * 1000
    );
  }

  /** The slot whose last read went to the device `device`. */
  slotOfDevice(device) {
    return this.slots.find((s) => s.id && ids(this.gladys, s.id).device === device?.external_id);
  }

  /** A device just created: the values of the last read now (no new request). */
  async onDeviceCreated(device) {
    const id = this.slots
      .map((s) => this.idOf(s))
      .find((x) => x && ids(this.gladys, x).device === device?.external_id);
    if (!id) return;
    const slot = this.slotOfDevice(device);
    if (slot) await this.publishLast(slot);
  }

  async onDeviceUpdated(device) {
    const slot = this.slotOfDevice(device);
    if (slot) await this.publishLast(slot);
  }

  /** The values of the last read of `slot` (if fresh), never a new request. */
  async publishLast(slot) {
    const generation = this.generation;
    if (!this.isFresh(slot)) return;
    const prepared = this.prepare(slot, slot.values);
    if (prepared && generation === this.generation) {
      await this.send(prepared);
      if (generation === this.generation) await this.updateStatus();
    }
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the state in /data when it changed; false when it could not (or
   * must not: an unreadable file is never written over). The instant of the
   * last read is written at most once a minute.
   */
  async saveState({ force = false } = {}) {
    if (this.storeUnreadable) {
      return false;
    }
    const now = this.now();
    const attempt =
      this.kept.lastAttemptAt !== this.savedAttemptAt &&
      (this.savedAttemptAt === 0 || now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY)
        ? this.kept.lastAttemptAt
        : this.savedAttemptAt;
    const state = {
      lastAttemptAt: attempt,
      slots: this.kept.slots,
      info: this.kept.info,
    };
    const key = JSON.stringify(state);
    if (!force && key === this.savedKey && !this.saveFailed) {
      return true;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
      this.savedAttemptAt = attempt;
      this.saveFailed = false;
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.logger.warn(`Saving the SAX state in /data failed (${err?.code ?? 'error'})`);
      }
      this.saveFailed = true;
      return false;
    }
  }

  // --- Reads -------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollInterval * 1000;
  }

  /** The wait after a failure: never faster than a read, doubled up to 15 min. */
  retryWait(failures) {
    const first = Math.max(RETRY_MIN, this.intervalMs());
    return Math.min(first * 2 ** failures, Math.max(RETRY_MAX, first));
  }

  /**
   * The earliest instant (wall clock) of the next read of `slot`, whatever
   * asks for it, from ONE reading of each clock (`now`, `mono`).
   */
  nextReadAt(slot, { manual = false, now = this.now(), mono = this.monotonic() } = {}) {
    const at = [now];
    if (slot.lastAttemptMono !== undefined) {
      // Never sooner than the interval (the timer looks every 5 s: 30 to 35 s at 30 s).
      at.push(now + slot.lastAttemptMono + this.intervalMs() - mono);
    }
    if (!manual && slot.retryAtMono !== undefined && slot.retryAtMono > mono) {
      at.push(now + slot.retryAtMono - mono);
    }
    if (this.restartMono !== undefined) {
      at.push(now + this.restartMono + this.intervalMs() - mono);
    }
    return Math.max(...at);
  }

  /** The earliest next read of any battery (for the texts). */
  nextAnyReadAt({ manual = false, now = this.now(), mono = this.monotonic() } = {}) {
    if (this.slots.length === 0) return now;
    return Math.min(...this.slots.map((s) => this.nextReadAt(s, { manual, now, mono })));
  }

  /**
   * One look: a read of every battery whose read is due. A read still
   * running is never doubled, whatever its generation. Resolves once the
   * reads started or running are done.
   */
  tick({ manual = false } = {}) {
    if (this.config.problem) return undefined;
    const now = this.now();
    const mono = this.monotonic();
    const jobs = [];
    for (const slot of this.slots) {
      if (slot.busy) {
        jobs.push(slot.busy);
        continue;
      }
      if (this.nextReadAt(slot, { manual, now, mono }) > now) continue;
      const generation = this.generation;
      slot.busy = this.read(slot, generation)
        .catch((err) => this.logger.error(`SAX: unexpected error (${err?.name ?? 'Error'})`))
        .finally(() => {
          slot.busy = undefined;
        });
      jobs.push(slot.busy);
    }
    return jobs.length > 0 ? Promise.all(jobs) : undefined;
  }

  async read(slot, generation) {
    const alive = () => generation === this.generation;
    // Recorded first: neither a reconnection, a save nor a restart reads sooner.
    slot.lastAttemptMono = this.monotonic();
    this.restartMono = undefined;
    this.kept.lastAttemptAt = this.now();
    await this.saveState();
    const kept = this.keptSlot(slot);
    const result = await slot.reader.read({ identityRequired: Boolean(kept.serial) });
    if (!alive()) {
      // Late: an old configuration or a restart. Nothing published, no status.
      return;
    }
    const answered = Object.values(result.outcomes).some((o) => o === OUTCOME.OK);
    if (!answered) {
      await this.failed(slot, result.error ?? (result.reached ? 'silent' : 'unreachable'), alive);
      return;
    }
    slot.failures = 0;
    slot.retryAtMono = undefined;
    slot.lastError = undefined;
    slot.outcomes = result.outcomes;
    let identity;
    if (this.storeUnreadable) {
      // /data unreadable is not empty: only a serial read now names the battery.
      const serial = result.identity?.serial;
      identity = {
        id: serial ? serialId(serial) : undefined,
        note: serial ? undefined : 'identifying',
      };
    } else {
      identity = resolveIdentity(kept, slot.battery, result);
    }
    if (identity.note === 'otherSerial') {
      this.logger.warn(
        `SAX: another battery answers at ${slot.battery.address}: its own device is in Discovery`,
      );
    }
    slot.id = identity.id;
    slot.note = identity.note;
    if (identity.id && result.identity) {
      this.kept.info[identity.id] = {
        model: result.identity.model,
        versionMaster: result.identity.master,
        versionGateway: result.identity.gateway,
      };
    }
    slot.values = identity.id ? { ...result.values } : undefined;
    slot.valuesAt = this.monotonic();
    slot.readAt = this.now();
    const prepared = identity.id ? this.prepare(slot, slot.values) : undefined;
    // The identity learned is in /data before Gladys gets the values.
    await this.saveState();
    if (!alive()) return;
    if (prepared) await this.send(prepared);
    if (!alive()) return;
    await this.discover();
    if (!alive()) return;
    await this.updateStatus();
  }

  async failed(slot, kind, alive) {
    if (kind === 'aborted') return;
    // Our own words only: never a byte of the battery.
    this.logger.warn(`SAX read of ${slot.battery.address} failed: ${kind}`);
    slot.retryAtMono = this.monotonic() + this.retryWait(slot.failures);
    slot.failures += 1;
    slot.lastError = kind;
    slot.values = undefined;
    await this.saveState();
    if (alive()) await this.updateStatus();
  }

  /** The states of a read of `slot` for its created device (undefined without one). */
  prepare(slot, values) {
    const created = this.createdDevice(slot.id);
    if (!created) return undefined;
    const external = ids(this.gladys, slot.id);
    const features = keysOfDevice(created);
    const states = readStates(external, values).filter((s) =>
      features.has(s.device_feature_external_id.split(':').at(-1)),
    );
    return states.length > 0 ? states : undefined;
  }

  /**
   * The states, within STATES_PER_MINUTE over any 60 s: a batch that would go
   * beyond is not sent this time. The room is taken BEFORE the publication
   * (two publications at once never both pass).
   */
  async send(states) {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    const used = this.sent.reduce((sum, s) => sum + s.count, 0);
    if (used + states.length > STATES_PER_MINUTE) {
      this.logger.debug('SAX: values kept for the next read (states per minute)');
      return;
    }
    const entry = { at: mono, count: states.length };
    this.sent.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT });
      if (Number.isInteger(result?.count) && result.count >= 0 && result.count <= states.length) {
        entry.count = result.count;
      }
    } catch (err) {
      this.logger.warn(`Publishing the SAX values failed (${err?.name ?? 'Error'})`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  /** What the texts say of a battery. */
  viewOf(slot, { now, mono }) {
    const missing = Object.entries(slot.outcomes ?? {})
      .filter(([, o]) => o !== OUTCOME.OK)
      .map(([key, o]) => ({ key, outcome: o }));
    return {
      field: slot.battery.field,
      address: slot.battery.address,
      master: slot.battery.master,
      id: slot.id,
      model: slot.id ? this.kept.info[slot.id]?.model : undefined,
      note: slot.note,
      error: slot.lastError,
      wait: slot.retryAtMono === undefined ? 0 : Math.max(0, slot.retryAtMono - mono),
      read: slot.values !== undefined,
      outcomes: slot.outcomes,
      missing,
      noDevice: Boolean(slot.id) && !this.createdDevice(slot.id),
      next: this.nextReadAt(slot, { now, mono }),
    };
  }

  /**
   * The status, one computation at a time: the batteries are read side by
   * side, and a status computed earlier never lands after a newer one.
   */
  updateStatus(options) {
    const run = this.statusChain.then(() => this.computeStatus(options));
    this.statusChain = run.catch(() => {});
    return run;
  }

  async computeStatus({ starting = false } = {}) {
    const { problem, problemField } = this.config;
    if (problem) {
      await this.setStatus(false, T.problem(problem, problemField));
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    const views = this.slots.map((s) => this.viewOf(s, { now, mono }));
    const notes = [];
    if (this.storeUnreadable) notes.push(T.notes.storeUnreadable);
    else if (this.saveFailed) notes.push(T.notes.storeFailed);
    if (views.every((v) => v.error)) {
      await this.setStatus(false, T.failing(views, notes));
      return;
    }
    if (views.every((v) => !v.outcomes && !v.error)) {
      const at = this.nextAnyReadAt({ now, mono });
      if (starting && at <= now) await this.setStatus(false, T.connecting);
      else {
        const known = this.slots.some((s) => this.idOf(s));
        await this.setStatus(known, T.waiting(at, notes));
      }
      return;
    }
    await this.setStatus(true, T.ok(views, notes));
  }

  // --- Configuration screen button ------------------------------------------------

  /**
   * The test button: a read of every battery whose read is due (the
   * interval passed), else what is known and when the next read can be.
   * Never a read the pace forbids.
   */
  async testConnection() {
    const { problem, problemField } = this.config;
    if (problem) {
      return T.problem(problem, problemField);
    }
    const generation = this.generation;
    const job = this.tick({ manual: true });
    if (job) {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve('late'), TEST_ANSWER_WITHIN);
      });
      try {
        if ((await Promise.race([job.then(() => 'done'), late])) === 'late') {
          return T.test.slow;
        }
      } finally {
        this.timers.clearTimeout(timer);
      }
    }
    if (generation !== this.generation) {
      return T.test.slow;
    }
    const now = this.now();
    const mono = this.monotonic();
    const lines = this.slots.map((slot) => {
      const view = this.viewOf(slot, { now, mono });
      const fresh = this.isFresh(slot, mono);
      return T.test.battery(view, fresh ? slot.values : undefined, fresh ? slot.readAt : undefined);
    });
    return T.test.lines(lines);
  }
}
