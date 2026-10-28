# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real SAX Power Home (ideally a group of
      two, master and one more, firmware Master V61 / Gateway V54 or later, with
      and without an ADW200 meter): device creation, the values, the test
      button, the status while the display refreshes.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store fields left out on purpose (rules of the project): `keywords`
      (e.g. SAX, battery, Modbus, SunSpec) and `countries` (DE, AT, CH).

## To confirm on a real battery (built without one)

- [ ] The two energy registers of unit 40 (40096 "energy produced", 40097
      "energy consumed", as sax_battery_ha names them): their unit (Wh is
      assumed, the reference divides by 1000), their direction (charged or
      discharged: the reference's own comments disagree with its names), and
      whether they are lifetime counters. One 16-bit register each: in Wh they
      would start over at 65.535 kWh. The reference itself adds their value every hour into its
      "cumulative" sensors, which suggests they may not be lifetime counters.
      Until then: plain sensors, never in the energy monitoring.
- [ ] The sign of the power of unit 64 (register 47, raw - 16384) and of the
      SunSpec powers 40029 (storage) and 40072 (grid): a forum post says
      negative is charging, unconfirmed. Plain signed sensors until then; once
      confirmed, they could also be published as charge / discharge and
      `grid-sensor` on new feature keys.
- [ ] That a group's other batteries answer the SunSpec identity at all (the
      SAX documentation advises reading the master only). If they never do,
      they are named after their address (3 reads), which needs a fixed address.
- [ ] That the SunSpec blocks may be read whole (15, 32, 41 and 20 registers):
      the reference reads one register at a time. A whole read refused with
      exception 1 or 2 switches the block to single reads for the life of the
      process (tested on the fake), but another refusal (a timeout, exception 4) would not.
- [ ] The meaning of the status code of unit 64 (register 45: 1 off, 3 on in
      a forum post) and whether the "Extended mode" (units 40 and 64) needs the
      SAX customer service to enable it.
- [ ] The serial number words (40013-40014; the documentation calls the second
      one "Low Byte"): the id keeps both words as read, in decimal.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-sax-power:0.1.0`); the
  first patch release gives 0.1.1. SDK 0.16.0 (latest published, 2026-10-28).
- **Reference**: sax_battery_ha 0.2.4.1 (matfroh, Apache-2.0, LICENSE read: no
  name), `main` at 943281f, cloned read-only in `~/code/ref/lot18/sax_battery_ha`;
  its `docs/SAX_Modbus_SunSpec_Dokumentation.pdf` (SAX, June 2026, firmware
  Master V61 / Gateway V54) is the manufacturer's documentation of the SunSpec
  interface. The registers of units 64 and 40 come from the reference only
  (an older SAX manual its code quotes, not published): same addresses, unit
  ids, scales and offset; nothing guessed beyond them. Notices in
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE`. The template's
  demo files were removed.
- **Read-only**: only function 3 is ever built (`src/sax/registers.js`); no
  `onSetValue`. The "pilot mode" (limits 43/44, set-point 41/42, on/off 45) is
  not ported in v1: if it comes, disabled by default behind an option, never a
  `switch`, bounded, success only on a read back.
- **Several batteries**: up to three addresses (A is the master); each its own
  reader, connection and pace; read side by side, a hanging battery never
  delays the others (tested). The system blocks (SunSpec models 103, 203, 802)
  are read on A only, as SAX advises.
- **One request at a time per battery**, 500 ms at least between two (SAX:
  "at most every 500 ms"), each answer 4 s at most (the display refresh takes
  1 to 3 s), a whole read 45 s at most; a timeout ends the session (a late
  answer is never taken), the next block goes on a new connection opened after
  the old one closed, 3 connections per read at most.
- **SunSpec checked**: the "SunS" marker, model 1, and the model ids 103, 203,
  802 at their documented addresses on every read; a block without its marker
  holds no value. "Not implemented" words (0x8000, 0xFFFF) and scale factors
  out of -10..10 are unknown, never 0. The model lengths of the SAX table do
  not add up to its addresses: the fixed addresses of the table are used, the
  lengths are not walked.
- **External id**: `battery:sn<hi>-<lo>` (SunSpec serial, both words); for a
  battery that never showed one, `battery:ip<host>-<port>` after three reads
  where unit 64 answered and the identity did not. A serial known at an
  address is required on every later read (never back to the address id). /data
  unreadable: no address id is taken.
- **Energy** (review r1, I1): no index of the energy monitoring, nothing in
  `energy-sensor`, `grid-sensor` nor `battery-storage` charge / discharge index
  (see "To confirm"). The two counters are plain sensors published as read, 0
  being unknown (never published), WITHOUT the guard of release 0: on sensors
  nothing counts, a guard only froze them and asked two clicks at every wrap or
  reset. No "Accept the held counter" action, nothing of them in /data.
- **Failures** (review r1, I2): an answer of another size is a protocol failure,
  a read over its 45 s budget a timeout; only a stop is "aborted". A read where
  no block answered is a failure: status, spaced retries, log line.
- **Identity per connection** (review r1, m1, m2): a new connection of a read
  reads the SunSpec identity first; another serial (or none) there ends the
  read, its values are not taken. The identity checks "SunS", model 1, length
  15 and "SAXPOWER" (well-known words of the SAX table).
- **One battery's power** (unit 64) bounded to ±10 kW (4.6 kW per battery):
  the raw words 0 and 0xFFFF are never published.
- **Solar and grid power** only when the ADW200 meter reads (mean grid voltage
  of model 203 at 100 V at least): without it the registers would read 0, never
  a measure.
- **Units**: only those of `DEVICE_FEATURE_UNITS_BY_CATEGORY`: % for
  battery-storage, °C for temperature-sensor, W for energy-production-sensor,
  none for unknown (the unit in the name).

## Next patch

- r2 minor: leftover mentions of the removed guard: `src/sax/registers.js:296` (cites `src/guard.js`), the
  header of `test/app.test.js:4-5` and the test title at line 79, `CLAUDE.md:40` ("counters, buttons").
