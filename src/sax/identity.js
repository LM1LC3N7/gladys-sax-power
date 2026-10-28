// -----------------------------------------------------------------------------
// The identity of a battery (pure). The rule is fixed forever:
// - `sn<hi>-<lo>`: the two words of the serial number of the SunSpec
//   interface (SAX documentation, 40013-40014), as read, in decimal; read in
//   the same session as the values, on every read;
// - `ip<host>-<port>`: for a battery that has NEVER shown a serial number at
//   its address (no SunSpec interface: a firmware older than Master V61 /
//   Gateway V54, or a battery of a group that leaves it to the master), once
//   its unit 64 answered and its SunSpec identity did not, FALLBACK_AFTER
//   reads in a row. Every character but a-z and 0-9 becomes "-".
//
// Once a serial number was read at an address (kept in /data), a read without
// one is unidentified (nothing published), never the address id again; a
// different serial at the same address is another battery (its own device).
// -----------------------------------------------------------------------------

import { FALLBACK_AFTER } from '../constants.js';
import { OUTCOME } from './reader.js';

const SERIAL = /^\d{1,5}-\d{1,5}$/;

export const serialId = (serial) => `sn${serial}`;

export const addressId = (host, port) =>
  `ip${String(host)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${port}`;

/** A slot of /data read back: `{ serial, fallback, misses }`. */
export function validSlot(raw) {
  const slot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    serial: typeof slot.serial === 'string' && SERIAL.test(slot.serial) ? slot.serial : null,
    fallback: slot.fallback === true,
    misses: Number.isInteger(slot.misses) && slot.misses >= 0 ? Math.min(slot.misses, 1000) : 0,
  };
}

/**
 * The identity of a read for the battery at `{ host, port }` and its slot
 * (changed in place): `{ id, note }`. `id` undefined: nothing is published
 * this time. `note`: 'otherSerial' (another serial at the address),
 * 'unreadable' (a serial known, none read now), 'identifying' (no serial
 * yet, the fallback not reached), or undefined.
 */
export function resolveIdentity(slot, { host, port }, result) {
  const serial = result.identity?.serial;
  if (serial) {
    const note = slot.serial && slot.serial !== serial ? 'otherSerial' : undefined;
    slot.serial = serial;
    slot.misses = 0;
    return { id: serialId(serial), note };
  }
  if (slot.serial) {
    return { id: undefined, note: 'unreadable' };
  }
  const identity = result.outcomes?.identity;
  const batteryAnswered = result.outcomes?.battery === OUTCOME.OK;
  if (batteryAnswered && identity !== undefined && identity !== OUTCOME.SKIPPED) {
    slot.misses += 1;
    if (slot.misses >= FALLBACK_AFTER) slot.fallback = true;
  }
  if (slot.fallback) {
    return { id: addressId(host, port), note: undefined };
  }
  return { id: undefined, note: 'identifying' };
}
