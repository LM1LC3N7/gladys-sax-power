# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- SAX Power Home / Home Plus batteries read locally over Modbus TCP, read-only:
  one battery or a group of up to three (master A, B, C), each its own device.
- Each battery: state of charge, power (signed as given), status code,
  temperature, cycles, capacity, and the two energy counters of sax_battery_ha
  as plain sensors (never counted by the energy monitoring).
- The master: the values of the whole system from the documented SunSpec
  interface (unit 100), checked against its well-known markers; solar and grid
  power only when the ADW200 meter reads.
- One connection and one request at a time per battery, 500 ms between two
  requests, every wait bounded; a block refused as a whole is read register by
  register; a block failing three reads in a row is skipped for ten.
- Identity: the SunSpec serial number read with the values; a battery without
  SunSpec is named after its address after three reads.
- The two energy counters published as read (0 never published, never in the
  energy monitoring); they may start over from zero or be periodic.
- Identity read again at the start of every new connection of a read; the
  well-known words "SunS", 15 and "SAXPOWER" checked.
- After a restart of the container, the first read waits the interval and one
  minute after the last read.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sax-power/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-sax-power/releases/tag/v0.1.1
