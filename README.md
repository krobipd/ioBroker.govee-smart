# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.govee-smart@main/admin/govee-smart.svg" width="48" align="top" /> ioBroker.govee-smart

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.govee-smart)](https://www.npmjs.com/package/iobroker.govee-smart) ![stable](https://iobroker.live/badges/govee-smart-stable.svg) ![Installations](https://iobroker.live/badges/govee-smart-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.govee-smart)](https://www.npmjs.com/package/iobroker.govee-smart)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.govee-smart/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.govee-smart/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Control all [Govee](https://www.govee.com/) WiFi products from ioBroker — lights, sensors and appliances. Bluetooth-only devices are not supported.

The adapter uses every available Govee channel (LAN, Cloud REST, AWS IoT MQTT, OpenAPI MQTT, App API) and picks whichever delivers the fastest answer for each device. Details in the **[Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki)**.

---

## Documentation

Full user documentation lives in the **[Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki)**.

A short guide ships with the adapter: [English](docs/en/README.md) · [Deutsch](docs/de/README.md).

| Topic                                                                       | English                                                                                               | Deutsch                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Landing page                                                                | [Home](https://github.com/krobipd/ioBroker.govee-smart/wiki/Home)                                     | [Startseite](https://github.com/krobipd/ioBroker.govee-smart/wiki/Startseite)                           |
| Channels, credentials, API key, experimental devices                        | [Setup](https://github.com/krobipd/ioBroker.govee-smart/wiki/Setup)                                   | [Einrichtung](https://github.com/krobipd/ioBroker.govee-smart/wiki/Einrichtung)                         |
| Supported models, status meanings, contributing yours                       | [Devices](https://github.com/krobipd/ioBroker.govee-smart/wiki/Devices)                               | [Geräte](https://github.com/krobipd/ioBroker.govee-smart/wiki/Geraete)                                  |
| Every datapoint, where it lands, what it does                               | [State tree](https://github.com/krobipd/ioBroker.govee-smart/wiki/State-Tree)                         | [Datenpunkte](https://github.com/krobipd/ioBroker.govee-smart/wiki/Datenpunkte)                         |
| Thermometers, heaters, kettles, etc. — state tree, updates, troubleshooting | [Sensors and Appliances](https://github.com/krobipd/ioBroker.govee-smart/wiki/Sensors-and-Appliances) | [Sensoren und Appliances](https://github.com/krobipd/ioBroker.govee-smart/wiki/Sensoren-und-Appliances) |
| Lights — segment count, wizard, cut strips, batch commands                  | [Segments](https://github.com/krobipd/ioBroker.govee-smart/wiki/Segments)                             | [Segmente](https://github.com/krobipd/ioBroker.govee-smart/wiki/Segmente)                               |
| Lights — scene library, speed slider, Cloud vs local snapshots              | [Scenes and Snapshots](https://github.com/krobipd/ioBroker.govee-smart/wiki/Scenes-and-Snapshots)     | [Szenen und Snapshots](https://github.com/krobipd/ioBroker.govee-smart/wiki/Szenen-und-Snapshots)       |
| Lights — group fan-out, capability intersection                             | [Groups](https://github.com/krobipd/ioBroker.govee-smart/wiki/Groups)                                 | [Gruppen](https://github.com/krobipd/ioBroker.govee-smart/wiki/Gruppen)                                 |
| Folder naming, startup, diagnostics, troubleshooting                        | [Behavior](https://github.com/krobipd/ioBroker.govee-smart/wiki/Behavior)                             | [Verhalten](https://github.com/krobipd/ioBroker.govee-smart/wiki/Verhalten)                             |

---

## Features

- **Capability-driven** — states are generated from what the Govee API reports for each device, so a model nobody has listed yet still gets its datapoints. Per-model code exists only where a model needs it: a catalog correction where Govee's own data is wrong, a decoder for a device's status frames once they are measured.
- **LAN-first for lights** — UDP multicast discovery, sub-50 ms commands, status updates via AWS IoT MQTT
- **Cloud + MQTT push for sensors and appliances** — readings via the App API, events via the OpenAPI MQTT broker
- **Per-segment color and brightness** for LED strips with the right capability, including batch commands and a visual segment-detection wizard (with a live, correctable strip map) for cut strips
- **Scenes, DIY scenes, music mode, gradient toggle** — activated locally via BLE-over-LAN where possible, Cloud fallback otherwise
- **Cloud and local snapshots** — Govee-app snapshots and ioBroker-side snapshots side by side
- **Groups** — bridge Govee groups into ioBroker with capability intersection across members
- **Diagnostics report per device** — tab Expert → Diagnostics: an anonymised JSON report to attach to a bug report
- **Works without credentials** — LAN-only out of the box, each credential tier unlocks more
- **Rate-limited Cloud usage** — daily and per-minute budgets aligned to Govee's quota

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting is active by default. It stays off when the ioBroker diagnostics setting is `none` (`diag` in the system configuration), when data reporting is disabled for this instance or its host (`disableDataReporting`), and on CI systems. A report contains the error with its stack trace and technical context such as versions and platform, plus an anonymous installation ID.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- ioBroker Admin >= 8.0.14
- A Govee account and at least one Govee WiFi device. LAN control needs a light with LAN mode enabled in the Govee Home app — see Govee's [LAN-supported device list](https://app-h5.govee.com/user-manual/wlan-guide).

---

## Getting started

The adapter works LAN-only without any credentials. Adding an API key unlocks scenes, segments and appliance control. Adding your Govee email and password adds sensor readings (temperature/humidity via the App API), real-time status push and full group control. See the [Setup page](https://github.com/krobipd/ioBroker.govee-smart/wiki/Setup) for credential levels, how to get an API key, and network requirements.

---

## Device support

Each device shows its test status under `diag.tier`. The [Devices page](https://github.com/krobipd/ioBroker.govee-smart/wiki/Devices) lists every supported model and what the status means.

---

## Troubleshooting

Common issues (no devices discovered, empty scenes dropdown, segment colors not changing, limited group commands, delayed status updates) are covered on the Wiki [Behavior](https://github.com/krobipd/ioBroker.govee-smart/wiki/Behavior) / [Verhalten](https://github.com/krobipd/ioBroker.govee-smart/wiki/Verhalten) page.

For anything else, open the adapter's **Expert** tab, press **Diagnostics**, pick the affected device and press the button — your browser saves the report as a file. Attach that file to a [GitHub Issue](https://github.com/krobipd/ioBroker.govee-smart/issues/new/choose); it is far too long to paste into one.

---

## Acknowledgments

This adapter's MQTT authentication and BLE-over-LAN (ptReal) protocol implementation was informed by research from [govee2mqtt](https://github.com/wez/govee2mqtt) by Wez Furlong. Their reverse-engineering of the Govee AWS IoT MQTT protocol and undocumented API endpoints was invaluable.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 3.1.1 (2026-10-01)

- Fixed: a cloud command that fails because the Govee server name cannot be resolved is sent again within 10 seconds instead of being lost after one try
- Fixed: after a failed command the light's real state is read back right away, so its datapoint no longer stays on the wrong value — also without a Govee account
- Fixed: calls that never reached Govee (DNS or connection errors) no longer use up the daily budget, so an appliance is not blocked for the rest of the day
- Fixed: a group command that only some of its lights took now names the lights that did not switch and why, so a dark light no longer goes unnoticed
- Improved: connection errors in the log are written in plain words, e.g. that the Govee server name could not be resolved and the DNS is the likely cause

### 3.1.0 (2026-10-01)

- Fixed: a rejected background token refresh of the Govee account now counts toward the login protection and asks to check email/password instead of retrying silently
- Fixed: "Test login" in the connection card counts toward the account's login limit (3 per hour) and says when the next test is possible
- Fixed: segment colours and brightness are confirmed only after the command went out — a refused Cloud command no longer leaves them acked
- Fixed: stopping the adapter while it is still starting really stops it — it no longer goes on to search the network or log in to your Govee account afterwards
- Fixed: a light found on the network before the saved data loads keeps its scene speed and remembered libraries after a restart
- Fixed: a group offers only the colour temperatures every member supports, so no member is sent a value outside its range
- Fixed: when Govee no longer accepts the account session, scene, music and DIY libraries, snapshots and groups ask for a fresh login instead of reading as empty
- Fixed: a Cloud rate limit or rejected API key is reported once, with the real waiting time — no longer three times or with a wrong retry hint
- Fixed: moving a 2.x device tree to its new id no longer loses recordings or room assignments when the move fails or is interrupted
- Fixed: a light whose scene library has not loaded yet keeps its `scenes.scene_speed` datapoint, value and recording — a start without saved data deleted and re-created it
- Improved: a restart leaves the object tree untouched when nothing changed, so scripts and history that watch object changes no longer see needless updates
- Fixed: a mode or level dropdown only takes a value the device declares — a fan speed no longer shows `50`, an air purifier's level no longer `0` in Auto mode
- Fixed: the manual device sync after a failed start shows the Cloud connected and stops the pending retry; a device it adds gets its first values without a log warning
- Fixed: a Govee e-mail or password of spaces only counts as not entered — at start, in the sensor hint and in the connection card's test
- Fixed: the refresh button of a light keeps its scene list across restarts and corrects a wrong segment count; devices that are not lights no longer use up Cloud calls
- Fixed: a temperature reading carries °C whichever way it arrives — a model that declares Fahrenheit no longer flips the unit to °F (the value is always °C)
- Fixed: a segment colour above 255 is sent as 255 — it wrapped to 0 before; a segment brightness is rounded like the light's brightness
- Improved: a lamp that is unplugged or unreachable on your network leaves one warning in the log instead of a new warning for every command you send to it
- Fixed: a group that is switched off or set to a colour clears its scene and music dropdowns the same way a single light already does
- Fixed: a heater that declares no temperature unit shows none instead of an invented °F; a command delivered after the device came back shows the value that was sent
- Fixed: an untested model without catalog corrections no longer warns to turn on the experimental switch — it works as it is; the log only asks for a diagnostics report
- Fixed: the settings describe the experimental switch for what it does — it turns on the catalog corrections of untested models; every device appears without it
- Improved: after you press the device sync or the refresh button, the log tells you what it found, for example which new devices were added to the object tree
- Fixed: the connection card words every answer in the admin's language — a full login window shows the time on your own clock, and a repeated login test no longer claims a code was just requested
- Fixed: the music mode read from Govee's state answer showed the mode at that position instead of the reported one; a mode the device never declared is no longer written
- Fixed: the segment detection wizard no longer counts a dark segment at the end when the measurement runs all the way to the longest strip Govee supports
- Improved: appliance modes and levels and the device type show readable names in your ioBroker language; scripts may still write the names Govee uses, such as Auto

### 3.0.1 (2026-09-27)

- Improved: the note the Admin shows before an update to 3.x is short now: the warning, one example old → new and a link to the details

### 3.0.0 (2026-09-26)

- Changed: every device gets a new object ID once — model and last four characters with a hyphen, e.g. `devices.h61be-525f`; scripts and visualizations need the new IDs
- Changed: the move carries values, recording settings, rooms, functions and aliases along, and recorded history continues in its old series
- Fixed: two devices of one model whose IDs end alike now get a tree each and each receives its own commands — until now they shared one
- New: the H1741 battery table lamp reports its charge level in `sensor.battery`; Govee reports a fully charged battery as about 80 percent
- Fixed: fans and heaters with a numeric level (H7102, H7130) store it as a number, and the H7121 no longer puts a warning in the log at every refresh

### 2.41.0 (2026-09-26)

- Changed: Discovery follows the selected network interface only — the additional scan addresses setting is gone, and the broadcast goes to the network of the chosen card
- Fixed: `info.cloudConnected` turns false while the Govee Cloud stays unreachable and true again with its next answer — until now only a rejected API key cleared it

[Older changelogs can be found there](CHANGELOG_OLD.md)

## Support

- [Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki) — user documentation (EN / DE)
- [GitHub Issues](https://github.com/krobipd/ioBroker.govee-smart/issues) — bug reports, feature requests
- [ioBroker Forum](https://forum.iobroker.net/) — general questions

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

_Developed with assistance from Claude.ai_
