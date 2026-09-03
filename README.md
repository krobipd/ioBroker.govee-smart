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
- **Diagnostics export button per device** — one-click JSON dump for bug reports
- **Works without credentials** — LAN-only out of the box, each credential tier unlocks more
- **Rate-limited Cloud usage** — daily and per-minute budgets aligned to Govee's quota

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting only happens if you have enabled error reporting in the ioBroker diagnostics (**System settings → Diagnostics and error reporting**). Only an anonymous installation ID is transmitted — no name, e-mail address or IP address.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

## Network connections

Besides your devices on the LAN and the Govee servers (`openapi.api.govee.com`, `app2.govee.com`, `mqtt.openapi.govee.com` and Govee's AWS IoT endpoint), the adapter makes one more outbound call: once a day it looks up the current version of the Govee Home app in Apple's App Store directory (`itunes.apple.com`). Govee's undocumented endpoints reject requests that announce a stale app version, so the adapter keeps that version current on its own. The lookup carries no account data, no device data and no identifier of your installation.

The per-device diagnostics export (`diag.export` → `diag.result`) is meant to be attached to a public GitHub issue. It contains the device's model, its Govee device id, its LAN address, the name you gave it in the Govee Home app, recent adapter log lines and the last API responses for that device. Credentials, tokens and gateway secrets are masked before the export is written.

---

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.2.2
- ioBroker Admin >= 8.0.11
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

For anything else, set **`diag.export`** to `true` on the affected device, save the JSON from `diag.result` as a file and attach it to a [GitHub Issue](https://github.com/krobipd/ioBroker.govee-smart/issues/new/choose) — the export is too long to paste into an issue.

---

## Acknowledgments

This adapter's MQTT authentication and BLE-over-LAN (ptReal) protocol implementation was informed by research from [govee2mqtt](https://github.com/wez/govee2mqtt) by Wez Furlong. Their reverse-engineering of the Govee AWS IoT MQTT protocol and undocumented API endpoints was invaluable.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

- Fixed: Devices without the local API enabled were shown as not reachable after the first adapter restart although they still controlled fine — reachability is now one rule for every device kind, and the adapter no longer contradicts itself between `info.connection` and a device's own marker
- Fixed: An appliance could use up the whole account's daily Cloud budget. Govee allows an appliance 100 calls a day, and appliance control has no local path — each one now has its own allowance and says so in the log once when it is spent
- Fixed: A changed datapoint name or description only ever reached NEW installations; existing trees kept the old text. Every datapoint of the adapter's own `info`, `devices`, `groups` and file folders is refreshed on start
- Fixed: The segment channels were named in English regardless of the configured language — they are translated now
- Changed: BREAKING — the diagnostics report is a FILE. `<device>.diag.result` is gone; it held the whole report as text (around 68,000 characters), which no longer fits into a GitHub issue. Press `diag.export` and download the file in the adapter's new **Diagnostics** tab, then attach it. `<device>.diag.lastExport` names the most recent file
- Improved: The report is pseudonymised — addresses, mail addresses and device names are replaced by stable markers and device ids shortened, so it can be attached to a public issue. It also carries the ioBroker environment, the device's real datapoints, what the last commands did and where the segment count came from, which used to be follow-up questions on every report
- Improved: User documentation now ships with the adapter, so the ioBroker doc portal shows it instead of the developer README

### 2.28.0 (2026-09-02)

- Fixed: The "Sync devices manually" button in the object tree works again — it had no effect since 2.17.0. It is now `info.manualSyncDevices`; the old `info.manual_sync_devices` is removed on start
- Fixed: A Govee maintenance page could permanently stop the Cloud reconnect with a misleading "check your API key" hint — only real authentication failures stop the retry now
- Fixed: Sensor and event datapoints from the Govee app, such as temperature or battery, are no longer deleted and re-created on every Cloud refresh, so their history stays continuous
- Fixed: Group commands now reach Cloud-only members even while their Cloud online marker briefly flickers — only LAN lights that are really unreachable are skipped
- Fixed: An account e-mail with a trailing space no longer fails the account login at start-up, matching the behaviour of the login test in the settings
- Fixed: An implausible segment count from the cache, the Cloud or the app can no longer create thousands of segment channels — the count is capped at the protocol limit of 56
- Fixed: With several instances running in compact mode, the experimental-models switch of one instance no longer applies to all of them
- Changed: BREAKING — sensor and event datapoints have one name: `sensor.temperature` instead of `sensor.sensor_temperature`, `events.lack_water` instead of `events.lackWater`. Adjust your scripts
- Improved: Stopping the adapter no longer scans the whole object tree — the offline markers are written from memory, so shutdown stays well inside the host's time limit even with many devices
- Improved: Diagnostics buffers are now bounded by size, so a chatty device can no longer let the adapter's memory grow without limit
- Improved: The device cache is written without blocking the adapter — large installations no longer stall for a moment on every cache update

### 2.27.1 (2026-09-01)

- Improved: Noticeably lower background database load — the periodic reachability check now works far more efficiently, especially on systems with many devices and states

### 2.27.0 (2026-08-27) — stable

- Fixed: Switching the instance off now shows every device as offline in the object tree, instead of leaving them green for as long as the adapter is not running
- Fixed: After a crash the devices no longer keep claiming to be reachable until the next status round has caught up
- New: Three new datapoints under info — how many devices there are, how many are reachable right now, and whether that is all of them

### 2.26.0 (2026-08-22)

- Fixed: Stopping or restarting the instance now really ends the cloud connection; the adapter no longer keeps updating datapoints for a moment after it has shut down.

### 2.25.0 (2026-08-12)

- Redesigned connection setup: one card for the Cloud API key, account login and 2FA, with live connection status and a guided verification-code step.
- Fixed light strips that showed too many segments with impossible brightness values (e.g. Govee H6076 showed 15 instead of 7); they now use the strip's real segment count.

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
