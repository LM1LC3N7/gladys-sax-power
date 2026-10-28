# SAX Power Home for Gladys

**Unofficial** connector, not affiliated with SAX Power. It reads your **SAX
Power Home** or **Home Plus** batteries on your local network through their
**Modbus TCP** interface (port 502): a single battery, or a group of up to
three (the master A and the others). **Read-only**: it never changes a setting
and never steers the battery. No cloud.

**Never tested with a real device.** Feedback welcome.

## What you get

For **each battery** (the registers sax_battery_ha reads, Modbus units 64 and
40):

- state of charge (%), battery power (W, signed as the battery gives it: SAX
  does not document which sign is charging), status code;
- temperature, number of cycles, capacity (kWh);
- two energy counters, "energy produced" and "energy consumed" (kWh),
  **shown only**: they do not go to the Gladys energy monitoring (SAX does not
  document their meaning nor their unit).

For **battery A (the master)**, also the values of the **whole system** from
the SunSpec interface SAX documents (firmware Master V61 / Gateway V54 or
later):

- state of charge of the system, storage power (W, signed), highest cell
  temperature, state (1 off, 2 standby, 3 waiting, 4 on, 7 meter fault),
  events;
- charge and discharge power available, capacity of the system;
- with the **ADW200** meter only: solar power and grid power (W, signed as the
  meter gives it). Without an ADW200 (grid voltage read under 100 V), these two
  are not published.

SAX advises reading only the master of a group: it already gives the values
of the system. Add B and C only to see each battery's own values.

## Setup

1. Have the Modbus TCP interface of your batteries enabled if it is not (the
   SAX Power customer service does it; a firmware update may be needed for the
   SunSpec interface).
2. Give each battery a **fixed address** in your router (it takes its address
   by DHCP; the address is shown on its display).
3. In Gladys, install the integration, enter the address of battery A, then
   those of B and C if any, and save.
4. "Discover" tab: create the device of each battery. Its values come with the
   next read.

## Reading

- Each battery is read every 30 s by default (15 to 300 s), over its own
  connection, one request at a time and at least 500 ms between two requests,
  as SAX asks. The batteries are read side by side: one that does not answer
  never delays the others.
- Never faster than the interval: not the test button, not Discovery, not a
  reconnection to Gladys, not a restart of the container (the first read then
  waits the interval and one minute after the last read). Only a **new address** saved is read at
  once.
- While its display refreshes, the battery does not answer for 1 to 3 s: the
  part not read is missing this time, the status says so ("not read this
  time"), the rest is published. A part that fails three reads in a row is
  skipped for ten reads (never the serial number of a battery already
  known by its serial number).
- A battery unreachable: tried again after 1 min at least, then a delay
  doubled up to 15 min.

## Identity of each battery

- Every read reads the **serial number** of the SunSpec interface in the same
  connection as the values; the values only go to the device of that number.
- A battery without the SunSpec interface (an older firmware, or a battery of a
  group that leaves it to the master) is named after its address
  (`ip192-168-1-51-502`) after three reads where its unit 64 answered and its
  serial number did not. If a serial number shows up later, it wins: a new
  device appears in Discovery, the old one keeps its history.
- A battery whose serial number is known and does not give it this time:
  nothing is published for it (never to the device of its address).
- Another serial number at the same address: another battery, its own device
  appears in Discovery; the old one gets no value any more.

## Energy counters held back

The two energy counters of each battery go through a guard:

- 0 is never published;
- a **drop** (a reset, a battery replaced, or a 16-bit counter starting over)
  or an implausible **jump** (more than 20 kW on average since the last value,
  with 0.5 kWh of margin) is **held back**: the last accepted value is sent
  again, the status of the integration shows it; neither time nor repetition
  lets it go (a value back to normal ends the hold);
- if it is right, click "Accept the held counter" **twice** in the
  configuration: the first click lists what is held, the second (3 s to 5 min
  later) accepts exactly that; saving the configuration accepts nothing.

The guard counts on the session clock (the time at the start plus the time
elapsed measured by the system), not on the wall clock: a time set by NTP
while it runs does not widen its margin. What it keeps in /data survives a
restart, as wall dates: one case aside, a system clock hours ahead when the
container starts again widens the margin of the first values by those hours.

## What is not done

- No steering: no charge or discharge limit, no power set-point (the "pilot
  mode" of sax_battery_ha is not ported).
- No index for the Gladys energy monitoring.

## Troubleshooting

- "unreachable": check the address and the port (502), and that the battery is
  on the same network.
- "connected, but no register answered": the Modbus interface is probably not
  enabled; ask the SAX Power customer service.
- "serial number (SunSpec)" never read on the master: the firmware is probably
  older than Master V61 / Gateway V54; the system values are then missing.
- /data unreadable: the file is left as it is, no battery is named after its
  address and the counters are not sent; restart the integration.
