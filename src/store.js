// -----------------------------------------------------------------------------
// What must survive a restart of the container (a small JSON file under
// /data, the only writable place): the instant of the last read (written at
// most once a minute), the identity of each address (serial number read
// there, or the fallback to the address), what the Discovery list shows
// (model and versions: nothing secret), and the guards of the energy
// counters. (The store of gladys-openems; there is no secret here at all.)
//
// A file that exists but cannot be read (rights, a disk error, broken JSON)
// is NOT an empty file: `load()` says `unreadable`, and the app then never
// writes over it, never takes a new identity, nor publishes a counter /data
// cannot keep, until a start reads it again. Written through a temporary file
// and a rename, one write at a time; a failure is never fatal.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { validSlot } from './sax/identity.js';

export const DEFAULT_STATE_FILE = '/data/sax-power-state.json';
const MAX_FILE = 64 * 1024;

/**
 * A JSON file: `load()` (sync: `{ data }`, `{ data: {} }` when absent,
 * `{ unreadable: true }` otherwise) and `save(data)` (atomic).
 */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: {} } : { unreadable: true };
      }
      try {
        if (text.length > MAX_FILE) return { unreadable: true };
        const data = JSON.parse(text);
        return data && typeof data === 'object' && !Array.isArray(data)
          ? { data }
          : { unreadable: true };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). `unreadable`: load() says so. */
export function createMemoryStore(
  initial = {},
  { unreadable = false, failSave = false, slow = false } = {},
) {
  let data = structuredClone(initial);
  let saves = 0;
  const store = {
    unreadable,
    failSave,
    slow,
    load: () => (store.unreadable ? { unreadable: true } : { data: structuredClone(data) }),
    async save(next) {
      // `slow`: a few turns of the event loop, so that unserialized jobs would interleave.
      if (store.slow) for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      if (store.failSave) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
    get saves() {
      return saves;
    },
  };
  return store;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A configured address as src/config.js writes it (`host:port`, IPv6 in brackets). */
const ADDRESS = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\]):\d{1,5}$/;
/** A platform id (src/sax/identity.js). */
const PLATFORM_ID = /^(?:sn\d{1,5}-\d{1,5}|ip[a-z0-9-]{1,250}-\d{1,5})$/;
/** The external id of a counter feature: `ext:<selector>:battery:<id>:<key>`. */
const COUNTER_ID = /^ext:[A-Za-z0-9_.-]{1,64}:battery:[a-z0-9-]{3,260}:[a-z0-9_]{1,40}$/;
const VERSION = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xfffe ? v : undefined);
const MODEL = new Set(['SAX Power Home', 'SAX Power Home Plus']);

/** The facts of a battery for Discovery, read back. */
export function validInfo(info) {
  if (!isObject(info)) return undefined;
  return {
    model: MODEL.has(info.model) ? info.model : undefined,
    versionMaster: VERSION(info.versionMaster),
    versionGateway: VERSION(info.versionGateway),
  };
}

/**
 * The persisted state, sanitized: the instant of the last read never "in the
 * future", every field checked, so a clock that jumped or a hand-edited file
 * never stops the reads for longer.
 */
export function readState(raw, now) {
  const data = isObject(raw) ? raw : {};
  // No prototype, and only the expected keys.
  const slots = Object.create(null);
  if (isObject(data.slots)) {
    for (const [address, slot] of Object.entries(data.slots).slice(0, 20)) {
      if (ADDRESS.test(address)) slots[address] = validSlot(slot);
    }
  }
  const info = Object.create(null);
  if (isObject(data.info)) {
    for (const [id, value] of Object.entries(data.info).slice(0, 40)) {
      const valid = PLATFORM_ID.test(id) ? validInfo(value) : undefined;
      if (valid) info[id] = valid;
    }
  }
  const counters = Object.create(null);
  if (isObject(data.counters)) {
    for (const [id, state] of Object.entries(data.counters).slice(0, 80)) {
      if (COUNTER_ID.test(id) && isObject(state)) counters[id] = state;
    }
  }
  return {
    lastAttemptAt: Math.min(finite(data.lastAttemptAt) ?? 0, now),
    slots,
    info,
    counters,
  };
}
