# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads **SAX Power Home / Home Plus** batteries over **Modbus TCP** (port
502): the SunSpec interface documented by SAX (unit 100) and the per-battery
registers of [sax_battery_ha](https://github.com/matfroh/sax_battery_ha)
(units 64 and 40, Apache-2.0, see `THIRD_PARTY_NOTICES.md`). Unofficial.
**Read-only**: never `onSetValue`, never a request but function 3. Siblings:
`gladys-openems` (app, store), `gladys-solakon` (the
Modbus client).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/reader.test.js           # one file (a fake SAX battery on 127.0.0.1)
node --test --test-name-pattern "counter" # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # the store cover (800×534)
```

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every handler, registered before connect()
src/app.js                        SaxApp: batteries, pace, reads, identity, counters, buttons
src/sax/reader.js                 one read of one battery: blocks, gap, sessions, skips
src/sax/registers.js              the blocks, requests and decoders (pure, strict)
src/sax/identity.js               the id rule: serial, else the address after 3 reads
src/modbus/client.js              the only network access: one Modbus TCP session, one request
src/store.js                      what /data keeps across restarts (unreadable ≠ empty)
src/devices.js                    the devices, feature keys, catalog, states (pure)
src/config.js                     the form, normalized
src/constants.js                  timings, bounds, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
test/kit/                         copied from ~/code/ref/gladys-testkit (clock, TCP fake)
test/helpers/fakeSax.js           a fake SAX battery on a real TCP server
```

## Rules

- **Read-only.** No `onSetValue`; only read requests (function 3). A command,
  if one is ever added (the "pilot mode"), is disabled by default behind an
  option, never a `switch`, bounded, confirmed only by a read back.
- **One request at a time per battery**, 500 ms between two, one connection
  per battery at a time; batteries are independent (one hanging never delays
  another). Every wait is bounded; a late answer is never taken.
- **Pace**: never a read faster than the interval, whatever asks. A read of an
  old generation publishes nothing and sets no status. Each decision reads each
  clock once. A monotonic instant belongs to its process: what crosses a
  restart is a wall date in /data.
- **Registers**: only those of the SAX SunSpec documentation (markers checked
  on every read) and those of sax_battery_ha; never one guessed.
- **Energy counters**: plain sensors published as read (`positive`: 0 is
  unknown), never an index of the energy monitoring: SAX does not document
  them (16-bit, may start over or be periodic). No guard, no accept action.
- **External ids are forever**: `battery:sn<hi>-<lo>` / `battery:ip<host>-<port>`,
  the `FEATURE` keys, the manifest keys. A device published again never loses a
  feature.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY` in the core.
- **The container rootfs is read-only.** Write only `/data/sax-power-state.json`.
- **Versions belong to the Release workflow.** Never edit `version` by hand.
- **Changelog** under `## [Unreleased]`; **manifest** texts `{ en, fr }`;
  UTF-8 without BOM nor control byte.
- **Tests never leave the machine** (127.0.0.1 only); `mkdtemp` folders are
  removed in `t.after`.
