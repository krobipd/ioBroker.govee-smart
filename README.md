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

### 2.35.0 (2026-09-11)

- New: An air purifier's mode, level and filter life follow the device's own status report — a change made in the Govee app shows in ioBroker within a second, no cloud call (H7127, #47)
- Fixed: Filter life, air quality, mode and level of an appliance are read from Govee's device-state query at start — the adapter read that answer from the wrong field since its first version (#47)
- Fixed: A light without a local connection gets its power, brightness and colour from the same query at start; Govee's empty answers no longer turn into false or blank values
- Fixed: A light without a local connection on an installation with only an API key stays reachable — the 20-minute check meant to renew it never received an answer before
- Fixed: An installation using only an API key lost its appliance commands by mid-morning — a reachability poll that never got an answer used up the device's daily budget
- Changed: An appliance's reachability is no longer polled every 20 minutes; its own status push, a command and the start-up query count instead — polling would cost 72 of its 90 daily calls
- Fixed: The diagnostics report now records mode, level, temperature and music commands with their outcome — it only listed power, brightness and colour before
- Fixed: A datapoint Govee newly reports for a device is there from the first start on — it used to disappear again and only show up after the next restart
- Fixed: The filter life of an air purifier now carries its unit (%) — Govee declares none, and the datapoint had no unit since its first version
- Changed: The DreamView switch, the music auto-colour switch and the DIY-scene selector now carry an explanation in the object tree

### 2.34.0 (2026-09-10)

- Fixed: Air purifiers, heaters, humidifiers and fans — choosing a mode or a speed now reaches the device, where the adapter used to send a value Govee rejected as "Invalid parameter type" (#47)
- Fixed: The speed selector of an air purifier now offers the levels the device actually has, instead of the single unusable entry it showed before (#47)
- Fixed: On an appliance updating from an older version the level datapoint accepts values again — it kept the selection list of the previous version and refused every write against it
- Changed: On appliances whose modes share the same level numbers — kettles, some fans and humidifiers — the level is a plain number now; a selection list could only ever show one mode's levels
- Fixed: An installation with no light at all now reads its device states at start — filter life, air quality and every other reported value stayed empty forever (#47)
- Fixed: A heater's target temperature is sent in the shape the Govee API asks for, and the datapoint is labelled in the unit the heater itself reports — a 5–30 °C heater used to read °F
- Fixed: The current speed level now arrives from the cloud together with the mode — until now only the mode updated while the level datapoint kept showing its default
- Fixed: A command the Govee cloud rejects no longer counts as successful, so the datapoint stops showing a change the device never made, and the reason is named
- New: A device's night-light scene is selectable — the adapter received the scene list and the current scene from Govee and threw both away without creating a datapoint
- Fixed: The scene dropdown's "---" entry now carries the same value the adapter writes when it resets the dropdown, so the entry stopped being rewritten on every start
- New: The H7127 air purifier is confirmed by a user report — it is no longer listed as untested and no longer asks for the experimental switch at start
- Changed: The diagnostics report no longer repeats the privacy note the export button already shows, and says instead what only the file itself can say

### 2.33.0 (2026-09-08)

- Fixed: A light without a local API stays reachable while it reports its own state — Govee's device list lagged behind the bulb and overrode it every two minutes (reported for the H600D)
- Fixed: A status message the Govee cloud replays after a reconnect no longer counts as a fresh sign of life for the next half hour
- New: The H600D GU10 smart bulb is recognised from a user report
- New: 486 more Govee models start as experimental — every model the homebridge-govee project lists as of September 2026, from bulbs and strips to fans, heaters and ice makers
- New: An experimental model is tried by enabling "experimental device support"; a diagnostics report from the Expert tab confirms it for everyone
- Changed: The wiki's device list folds each device type into one block with its counts, so 602 entries stay readable

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
