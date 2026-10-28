// -----------------------------------------------------------------------------
// One read of one battery: its blocks (src/sax/registers.js), one Modbus TCP
// connection at a time, one request at a time on it, 500 ms at least between
// two requests (SAX documentation), every wait bounded, the whole read too.
//
// - A block refused as a whole (Modbus exception "illegal function" or
//   "illegal data address") is asked again register by register, as
//   sax_battery_ha reads (once refused, for the life of the process); a
//   register refused alone is unknown, the others are kept.
// - A block without answer (the display refreshing, a unit id not installed)
//   ends the session: the next block goes on a new connection, opened once the
//   old one is closed (SESSIONS_PER_READ at most per read); a late answer is
//   never taken for another request.
// - A block that fails BLOCK_FAILURES reads in a row is skipped for SKIP_READS
//   reads (an optional block never costs every read its timeout), except the
//   identity when the caller needs it (`identityRequired`).
// - Nothing received is ever logged.
// -----------------------------------------------------------------------------

import {
  ABSENT_CODES,
  BLOCK_FAILURES,
  SESSIONS_PER_READ,
  SKIP_READS,
  TIMINGS,
} from '../constants.js';
import { ERROR_KINDS, ModbusError, openSession, tcpConnect } from '../modbus/client.js';
import {
  BLOCKS,
  checksPass,
  decodeBlock,
  decodeIdentity,
  parseRead,
  readRequest,
  singleRegisters,
  wordsOf,
} from './registers.js';

/** What a block gave in a read. */
export const OUTCOME = {
  OK: 'ok',
  /** Refused by the battery (the unit id or the registers are not there). */
  ABSENT: 'absent',
  /** Answered, but its well-known words are not the documented ones. */
  INVALID: 'invalid',
  /** No answer, connection closed, or an odd answer. */
  FAILED: 'failed',
  /** Not asked this time (skipped after failures, or no connection left). */
  SKIPPED: 'skipped',
};

export class BatteryReader {
  constructor({
    host,
    port,
    master,
    connect = tcpConnect,
    timers = globalThis,
    monotonic = () => performance.now(),
    gap = TIMINGS.requestGap,
  }) {
    this.gap = gap;
    this.host = host;
    this.port = port;
    this.master = master;
    this.connect = connect;
    this.timers = timers;
    this.monotonic = monotonic;
    /** By block key: `{ failures, skipUntil, single }`. */
    this.blocks = new Map(BLOCKS.map((b) => [b.key, { failures: 0, skipUntil: 0, single: false }]));
    this.reads = 0;
    this.lastRequestMono = undefined;
    /** The read running: `{ aborted, session, opening, wake }`. */
    this.current = undefined;
  }

  /** Stops the read running (if any): its connection is cut, it ends at once. */
  abort() {
    const run = this.current;
    if (!run || run.aborted) return;
    run.aborted = true;
    run.opening?.abort();
    run.session?.abort();
    run.wake?.();
  }

  /** Waits `ms` (cut short by an abort). */
  sleep(run, ms) {
    if (ms <= 0 || run.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        run.wake = undefined;
        resolve();
      }, ms);
      run.wake = () => {
        this.timers.clearTimeout(timer);
        run.wake = undefined;
        resolve();
      };
    });
  }

  /** One request, never sooner than the gap after the previous one to this battery. */
  async request(run, session, address, count, unitId) {
    if (this.lastRequestMono !== undefined) {
      // A timer may fire a little early: never sooner than the gap, measured again.
      for (
        let wait = this.lastRequestMono + this.gap - this.monotonic();
        wait > 0 && !run.aborted;
      ) {
        await this.sleep(run, Math.max(1, wait));
        wait = this.lastRequestMono + this.gap - this.monotonic();
      }
    }
    if (run.aborted) throw new ModbusError(ERROR_KINDS.ABORTED, 'aborted');
    this.lastRequestMono = this.monotonic();
    const pdu = await session.request(readRequest(address, count), { unitId });
    const words = parseRead(count, pdu);
    if (!words) {
      // Of the right function and transaction, but not the size asked: odd, the session ends.
      session.abort('odd answer');
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of another size');
    }
    return words;
  }

  /**
   * One block on `session`: `{ outcome, map }`. A failure that ends the
   * session (no answer, closed, odd answer) gives FAILED.
   */
  async readBlock(run, session, block, state) {
    if (!state.single) {
      try {
        const words = await this.request(run, session, block.address, block.count, block.unit);
        const map = wordsOf(block, words);
        return { outcome: checksPass(block, map) ? OUTCOME.OK : OUTCOME.INVALID, map };
      } catch (err) {
        if (err?.kind !== ERROR_KINDS.REFUSED) return { outcome: OUTCOME.FAILED };
        if (!ABSENT_CODES.includes(err.code)) return { outcome: OUTCOME.FAILED, alive: true };
        // Refused as a whole: register by register from now on.
        state.single = true;
      }
    }
    const map = new Map();
    let refused = 0;
    for (const address of singleRegisters(block)) {
      try {
        const [word] = await this.request(run, session, address, 1, block.unit);
        map.set(address, word);
      } catch (err) {
        if (err?.kind !== ERROR_KINDS.REFUSED) return { outcome: OUTCOME.FAILED };
        refused += 1;
      }
    }
    if (map.size === 0 && refused > 0) return { outcome: OUTCOME.ABSENT, map };
    return { outcome: checksPass(block, map) ? OUTCOME.OK : OUTCOME.INVALID, map };
  }

  /**
   * Reads the battery once. Resolves (never rejects) with
   * `{ reached, identity, outcomes, values, error }`: `reached` when a
   * connection opened; `identity` from the SunSpec interface (or undefined);
   * `outcomes` by block key; `values` merged from the blocks read; `error`,
   * the kind of the first failure (for the status).
   */
  async read({ identityRequired = false } = {}) {
    const run = { aborted: false, session: undefined, opening: undefined, wake: undefined };
    this.current = run;
    this.reads += 1;
    const budget = this.timers.setTimeout(() => {
      if (this.current === run) this.abort();
    }, TIMINGS.readBudget);
    const result = {
      reached: false,
      identity: undefined,
      outcomes: {},
      values: {},
      error: undefined,
    };
    let sessions = 0;
    try {
      for (const block of BLOCKS) {
        if (block.master && !this.master) continue;
        const state = this.blocks.get(block.key);
        const mustRead = block.key === 'identity' && identityRequired;
        if (!mustRead && state.skipUntil > this.reads) {
          result.outcomes[block.key] = OUTCOME.SKIPPED;
          continue;
        }
        if (run.aborted) {
          result.outcomes[block.key] = OUTCOME.SKIPPED;
          continue;
        }
        if (!run.session) {
          if (sessions >= SESSIONS_PER_READ) {
            result.outcomes[block.key] = OUTCOME.SKIPPED;
            continue;
          }
          sessions += 1;
          run.opening = openSession({
            host: this.host,
            port: this.port,
            connect: this.connect,
            timers: this.timers,
          });
          try {
            run.session = await run.opening.promise;
          } catch (err) {
            result.error ??= err?.kind ?? 'error';
            // Unreachable: the other blocks are not asked this time (none counts as failed).
            for (const b of BLOCKS) result.outcomes[b.key] ??= OUTCOME.SKIPPED;
            break;
          } finally {
            run.opening = undefined;
          }
          if (run.aborted) {
            run.session.abort();
            result.outcomes[block.key] = OUTCOME.SKIPPED;
            continue;
          }
          result.reached = true;
        }
        const session = run.session;
        const { outcome, map, alive } = await this.readBlock(run, session, block, state);
        if (run.aborted) {
          result.outcomes[block.key] = OUTCOME.SKIPPED;
          continue;
        }
        result.outcomes[block.key] = outcome;
        if (outcome === OUTCOME.FAILED && !alive) {
          result.error ??= session.dead?.kind ?? ERROR_KINDS.CLOSED;
          // The next block on a new connection, once this one is closed.
          await session.close();
          run.session = undefined;
        }
        if (outcome === OUTCOME.OK) {
          state.failures = 0;
          if (block.key === 'identity') result.identity = decodeIdentity(map);
          else Object.assign(result.values, decodeBlock(block, map));
        } else {
          state.failures += 1;
          if (state.failures >= BLOCK_FAILURES) {
            state.failures = 0;
            state.skipUntil = this.reads + SKIP_READS + 1;
          }
        }
      }
    } finally {
      this.timers.clearTimeout(budget);
      if (run.session) await run.session.close();
      if (this.current === run) this.current = undefined;
    }
    if (run.aborted) result.error = ERROR_KINDS.ABORTED;
    return result;
  }
}
