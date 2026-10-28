# gladys-sax-power

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**SAX Power Home** and **Home Plus** home batteries, read locally over
**Modbus TCP** (port 502): one battery, or a group of up to three (the master
and the others). Read-only. Not affiliated with SAX Power.

**Never tested with a real device.** Feedback welcome.

- Each battery: state of charge, power (signed), status, temperature, cycles,
  capacity, and two energy counters shown as plain sensors, each guarded: never
  0, never a drop nor an implausible jump without a two-click acceptance (one
  case aside, a system clock hours ahead across a restart: see the user guide).
- The master: the values of the whole system from the SunSpec interface SAX
  documents (state of charge, storage power, state, events, cell temperature,
  available powers, capacity; solar and grid power with the ADW200 meter).
- No cloud, one connection and one request at a time per battery, 500 ms
  between requests, never faster than the interval (except right after a new
  address is saved). No steering (no "pilot mode").

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules,
[TODO.md](TODO.md) for the decisions and what is left to check on a real
battery.

## License

Apache-2.0 (see `LICENSE`). Register map ported from
[sax_battery_ha](https://github.com/matfroh/sax_battery_ha) (Apache-2.0); see
`THIRD_PARTY_NOTICES.md`.
