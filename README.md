# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.govee-smart@main/admin/govee-smart.svg" width="48" align="top" /> ioBroker.govee-smart

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.govee-smart)](https://www.npmjs.com/package/iobroker.govee-smart) ![stable](https://iobroker.live/badges/govee-smart-stable.svg) ![Installations](https://iobroker.live/badges/govee-smart-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.govee-smart)](https://www.npmjs.com/package/iobroker.govee-smart)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.govee-smart/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.govee-smart/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Control all [Govee](https://www.govee.com/) WiFi products from ioBroker — lights, sensors and appliances. Bluetooth-only devices are not supported.

The adapter uses every available Govee channel (LAN, Cloud REST, AWS IoT MQTT, OpenAPI MQTT, App API) and picks whichever delivers the fastest answer for each device. Details in the **[Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki)**.

---

## Documentation

Full user documentation lives in the **[Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki)**.

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

- **Capability-driven** — states are generated from what the Govee API reports for each device. No SKU hardcoding, no hand-maintained device list to fall behind.
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

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting only happens if you have enabled error reporting in the ioBroker diagnostics (**System settings → Diagnostics and error reporting**). Only an anonymous installation ID is transmitted — no name, e-mail address or IP address.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- ioBroker Admin >= 8.0.11
- A Govee account and at least one Govee WiFi device. LAN control needs a light with LAN mode enabled in the Govee Home app — see Govee's [LAN-supported device list](https://app-h5.govee.com/user-manual/wlan-guide).

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

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

### 2.40.0 (2026-09-25)

- New: Optional additional scan addresses — lights in another subnet or behind a router that blocks multicast are found by asking them directly
- New: Heaters with an auto-stop setting get `control.auto_stop` — stop heating at the target temperature or keep it
- New: Models that report the cloud temperature in °F are converted to °C — the H5179 by default, 14 further models with the experimental switch
- Fixed: Cloud events such as lack of water, presence or a full ice bucket now reach their datapoints — until now none did
- Fixed: The segment count of strips that report in groups of three is measured correctly — H61A8 and H7020 no longer grow phantom or lose real segments
- Fixed: A strip nothing had measured yet accepts segment commands, uses its scenes over LAN and works in the wizard and in snapshots
- Fixed: A device the account still lists is no longer deleted when the cached device list misses it
- Fixed: A fresh account login is kept for the next reconnect, and successful logins are capped per hour — repeated logins can make Govee lock the account for 24 hours
- Fixed: After an account change the saved login of the previous account is no longer reused
- Fixed: Dropdowns send the value Govee declared, and a LAN light's colour-temperature range follows what the device reports
- Fixed: Group music plays the same mode on every member, and a member without music or without the scene no longer counts as reached
- Fixed: A Govee snapshot is activated by its name — reordering snapshots in the app no longer triggers the wrong one
- Fixed: A command that could not be sent is no longer confirmed, and a day whose cloud budget is spent refuses commands instead of queueing them until midnight
- Fixed: With the account connected, lights are still asked for their status once a minute and after every LAN command, so a lost command is corrected
- Fixed: Port 4002 taken by another program is now reported instead of silently losing the lights' replies, and `info.connection` turns false when the last device goes quiet
- Improved: Leftovers of very old versions, including emptied login fields, no longer linger in the instance settings — expect one extra restart right after the update
- Fixed: Stopping the adapter during its start no longer leaves parts of it running, and a message sent during the start is answered
- Fixed: The segment wizard is cancelled when you leave the card, and the connection card shows Govee's reason instead of a raw text key
- Fixed: The diagnostics report hides Govee account topics and the device's LAN address in number form, and a device name only replaces whole words
- Improved: Temperature, humidity, battery, air quality and filter life carry translated names — the cloud path wrote Govee's English wording in every language
- Improved: Bluetooth-only models are no longer listed as supported, and the Wi-Fi meat thermometer H5610 was added

### 2.39.2 (2026-09-22)

- Fixed: App groups are no longer asked for a device state at every start — Govee answered each call with an error that only filled the diagnostics report
- Fixed: A scene request Govee refuses is no longer taken as "no scenes" — the cached scenes and snapshots stay, and the report names the reason once

### 2.39.1 (2026-09-22)

- Fixed: The diagnostics report no longer contains your Wi-Fi network name, the Govee app's device number or a group's id — they appeared in clear in every exported file
- Improved: The diagnostics report keeps Govee's complete account-list entry and shows commands waiting for an offline device and when the adapter started

### 2.39.0 (2026-09-22)

- New: A device that has gone quiet is asked for its status over the Govee account connection — a bulb or purifier that works but showed as unreachable now stays reachable
- Improved: The cloud budget follows Govee's per-device limits — a command for one light no longer waits for another light's calls or for library downloads
- New: A command Govee refused because the device was offline is delivered once the device reports back (within five minutes), instead of being lost
- Fixed: Scenes and libraries that arrived after a busy start now reach the scene dropdown and the cache — they used to stay at `---` and were fetched again on every start
- Fixed: A scene list that shrank no longer leaves withdrawn scenes in the dropdown
- Fixed: The diagnostics report no longer lists a reachability refresh for appliances, which never get one
- New: 28 more Govee models are recognised — meat thermometers, motion and pressure sensors, heaters, kettles, a composter and the gateways that carry battery sensors
- New: H1771 Table Lamp reported working by a user

### 2.38.3 (2026-09-17) — stable

- Changed: Internal cleanup. No user-facing changes.

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
