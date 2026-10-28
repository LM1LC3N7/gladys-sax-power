// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// No secret: the SAX Modbus interface has no password.
// -----------------------------------------------------------------------------

import { BATTERY_FIELDS, DEFAULT_PORT, POLL_DEFAULT, POLL_MAX, POLL_MIN } from './constants.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port (502 when absent). A pasted URL is reduced to its host and
 * port. (The parser of gladys-openems.)
 * @returns {{ address: string, host: string, port: number } | { error: 'invalid' } | { empty: true }}
 *   `address` is always `host:port` (the host of an IPv6 address in brackets).
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { empty: true };
  }
  if (text.length > 300) {
    return { error: 'invalid' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(bracketed[1].toLowerCase(), bracketed[2], true);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return withPort(text.toLowerCase(), undefined, true);
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  if (
    host === '0.0.0.0' ||
    host === '255.255.255.255' ||
    /^(22[4-9]|23\d|24\d|25[0-5])\./.test(host)
  ) {
    // Neither "any address" nor a multicast or broadcast range: never a device.
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2], false);
}

function withPort(host, port, ipv6) {
  const number = port === undefined ? DEFAULT_PORT : Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  if (ipv6 && (host === '::' || /^ff/i.test(host))) {
    return { error: 'invalid' };
  }
  return { address: `${ipv6 ? `[${host}]` : host}:${number}`, host, port: number };
}

/** A text of the form: a string, else ''. */
const textOf = (raw) => (typeof raw === 'string' ? raw : '');

/** The reading interval (s): a number from 15 to 300, else 30. */
function pollOf(raw) {
  const value = typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return POLL_DEFAULT;
  }
  return Math.min(POLL_MAX, Math.max(POLL_MIN, Math.round(value)));
}

/**
 * `{ batteries: [{ field, address, host, port, master }], pollInterval, problem, problemField }`.
 * The master (battery A) is first; empty B / C fields are left out.
 * `problem`: 'address_missing' (no battery A), 'address_invalid',
 * 'address_duplicate' (the same address twice) or undefined; with a problem
 * no battery is read.
 */
export function normalizeConfig(raw = {}) {
  const batteries = [];
  let problem;
  let problemField;
  const seen = new Set();
  for (const field of BATTERY_FIELDS) {
    const parsed = parseAddress(textOf(raw?.[field]));
    if (parsed.empty) {
      if (field === BATTERY_FIELDS[0] && !problem) {
        problem = 'address_missing';
        problemField = field;
      }
      continue;
    }
    if (parsed.error) {
      if (!problem) {
        problem = 'address_invalid';
        problemField = field;
      }
      continue;
    }
    if (seen.has(parsed.address)) {
      if (!problem) {
        problem = 'address_duplicate';
        problemField = field;
      }
      continue;
    }
    seen.add(parsed.address);
    batteries.push({
      field,
      address: parsed.address,
      host: parsed.host,
      port: parsed.port,
      master: field === BATTERY_FIELDS[0],
    });
  }
  return {
    batteries: problem ? [] : batteries,
    pollInterval: pollOf(raw?.poll_interval),
    problem,
    problemField,
  };
}
