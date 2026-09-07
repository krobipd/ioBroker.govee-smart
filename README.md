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

The per-device diagnostics report (Expert tab → Diagnostics) is meant to be attached to a public GitHub issue. It contains the device's model, its Govee device id, its LAN address, the name you gave it in the Govee Home app, recent adapter log lines and the last API responses for that device. Credentials, tokens and gateway secrets are masked before the report is written, and addresses, mail addresses and device names are replaced by stable markers.

---

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

### 2.32.1 (2026-09-07)

- Fixed: Your devices and their recorded history no longer disappear from the object tree when the Govee cloud cannot be reached at startup

### 2.32.0 (2026-09-07)

- Fixed: In an account without a single light, every device stopped being switchable after a restart — appliances, plugs and sensors had no state and no reachability until you pressed sync devices
- Fixed: A device could stay green for up to 30 minutes after Govee had reported it offline; an arriving reading no longer overrides an explicit offline report
- Fixed: With only an API key configured, devices fell offline 30 minutes after the start although they were still controllable — the proof now renews itself without account credentials
- Fixed: Scene and snapshot commands that fell back to the cloud and failed there were still confirmed as carried out; a command that did not arrive now stays unconfirmed
- Fixed: A manually chosen segment list could only ever lengthen the learned strip and never shorten it again — the wizard's own measurement was overwritten by it
- Fixed: Under load the adapter stopped counting appliance commands against their daily limit, so a heater or humidifier could burn through its Govee quota and stop responding
- Fixed: On a device model the adapter does not know yet, the tier datapoint told the user to press a button that 2.31.0 had already removed from the admin page
- Fixed: Without account credentials, a group from the Govee app grew an empty entry in the object tree on every restart; it now appears only once its members are actually known
- New: Datapoints carry an explanation in all 11 languages wherever the name alone does not say enough — 99 of them instead of 26
- Changed: The adapter can no longer be installed directly from GitHub — install it from the ioBroker repository or from npm, as with every other adapter

### 2.31.1 (2026-09-04)

- Fixed: When the adapter met a device model it does not know yet, its log asked the user to press a button that 2.31.0 had removed — it now points at the Expert tab, where the report is actually made

### 2.31.0 (2026-09-03)

- Fixed: On instances upgraded from 2.27.0 or newer, every admin card was dead — diagnostics, segment wizard and connection test alike; affected installations repair themselves on the next start
- Fixed: A card that could not reach the adapter reported "no devices yet" instead of the real error
- Changed: Segment detection and diagnostics now share one **Expert** tab with a button each
- Changed: The per-device `diag.export` button is gone; the Expert tab builds the report and hands you the file in one press
- Changed: `diag.lastExport` now records WHEN the last report was taken, instead of naming the file
- Improved: Both cards say "Loading devices …" while they search, and explain the wait if it takes long
- Fixed: The diagnostics report still described the reachability rule as it was before 2.30.0

### 2.30.0 (2026-09-03)

- Fixed: Devices without a local API were shown as unreachable although they switched and reported normally; they now show as reachable for as long as they are
- Fixed: Sensors and buttons behind a Govee gateway were shown as unreachable although their readings kept arriving; their gateway now decides whether they are reachable
- Fixed: Appliances stayed marked as reachable for up to two minutes after they had actually gone offline
- Improved: A device that is unplugged and put away is reported as unreachable within half an hour, instead of staying green until the adapter is restarted
- New: 37 additional device models are recognised, including smart plugs, a button remote, an air quality monitor and an aroma diffuser
- New: Battery buttons and remotes are supported as their own device kind, with battery level and reachability

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
