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
- **Per-segment color and brightness** for LED strips with the right capability, including batch commands and an interactive segment detection wizard for cut strips
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

---

## Requirements

- Node.js >= 22
- ioBroker js-controller >= 7.1.2
- ioBroker Admin >= 7.8.23
- A Govee account and at least one Govee WiFi device. LAN control needs a light with LAN mode enabled in the Govee Home app — see Govee's [LAN-supported device list](https://app-h5.govee.com/user-manual/wlan-guide).

---

## Getting started

The adapter works LAN-only without any credentials. Adding an API key unlocks scenes, segments, sensors and appliances. Adding your Govee email and password adds real-time status push and full group control. See the [Setup page](https://github.com/krobipd/ioBroker.govee-smart/wiki/Setup) for credential levels, how to get an API key, and network requirements.

---

## Device support

Each device shows its test status under `diag.tier`. The [Devices page](https://github.com/krobipd/ioBroker.govee-smart/wiki/Devices) lists every supported model and what the status means.

---

## Troubleshooting

Common issues (no devices discovered, empty scenes dropdown, segment colors not changing, limited group commands, delayed status updates) are covered on the Wiki [Behavior](https://github.com/krobipd/ioBroker.govee-smart/wiki/Behavior) / [Verhalten](https://github.com/krobipd/ioBroker.govee-smart/wiki/Verhalten) page.

For anything else, press **`diag.export`** on the affected device, copy the JSON from `diag.result`, and open a [GitHub Issue](https://github.com/krobipd/ioBroker.govee-smart/issues).

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

- Security: the Govee Cloud API key can no longer leak into the ioBroker log — it was written in plaintext on the cloud-events connection and is now masked.
- Security: the diagnostics export (the JSON you paste into a GitHub issue) no longer contains device or gateway secrets — a gateway `secretCode` and push topic are now masked, while normal device metadata is kept.
- Security: a spoofed LAN discovery reply can no longer redirect a device's commands to another IP — the device address is now taken from the real network source, not the packet's self-reported address.
- Robustness: the Admin "Test login" button is now rate-limited, so repeated clicks can no longer trigger a burst of Govee logins that could get your account temporarily locked.
- Security: LAN device discovery is hardened against a misbehaving or hostile device on your network — implausibly large device identifiers are ignored and the number of new LAN devices is capped, preventing runaway memory/CPU use.
- Fixed: a device you delete from your Govee account is now removed from the adapter on the next cloud refresh (e.g. after a restart), instead of lingering as a phantom device for up to two weeks.
- New: a "Manually sync devices" button (`info.manual_sync_devices`) — set it to true to sync the device list with your Govee account on demand (pull in new devices, drop deleted ones) without restarting the adapter.
- Fixed: multi-colour DIY scenes activated locally (LAN/ptReal) now build a valid packet — an off-by-one corrupted the terminator on scenes with longer data, so they could silently fail to load.
- Fixed: after you remove a device and add it again, its info states (name, model, …) are recreated correctly instead of leaving "has no existing object" warnings until the next restart.
- Fixed: if a Govee push/cloud-events connection connects but then can't subscribe (a rare server-side hiccup), the adapter no longer reconnects every few seconds — the retry now backs off normally, avoiding a self-inflicted rate-limit.
- Fixed: the admin "Test login" button now waits for the real MQTT connection before reporting — valid Govee account credentials no longer show a false "MQTT not up, restart the adapter" message.
- Fixed: on lamps whose music modes start at zero (e.g. H612F, H61D5, H70B3, H70C5) the first music mode was unreachable and the "off/---" entry was missing — `music_mode` is now a clean index-based dropdown like every other selector. **Breaking on those devices:** the `music_mode` numbers shift by one (an "off" entry is added at 0), so scripts that write a fixed number there may need adjusting.
- Fixed: cloud snapshots whose value is a plain number are no longer dropped from the snapshot dropdown, and an entry with an empty value no longer shows up as a phantom option.
- Fixed: clearing the preset-scene selector no longer fires a spurious empty scene command.
- Fixed: DIY scenes you create in the Govee app now show up in the DIY dropdown after a reload, instead of only on the very first load.
- Fixed: a malformed `segments.command` (e.g. `;` instead of `:`) now logs a clear warning with the expected syntax instead of being silently ignored.
- Fixed: a command to a group with no reachable members (or where every member fails) is no longer falsely reported as successful — it now warns and leaves the state un-acknowledged, like a single device.
- Fixed: changing music sensitivity or auto-color on a LAN-controlled light now warns that the local API can't set them (only the music mode applies), instead of silently doing nothing.
- Fixed: an out-of-range segment range in `segments.command` (e.g. `0-2000000000`) is now clamped to the protocol limit instead of briefly freezing the adapter while it expands the range.
- Fixed: the segment-detection wizard now turns the light back off when it finishes or is aborted if the light was off before — it no longer leaves a light on that you had switched off.
- Fixed: starting the segment-detection wizard twice in quick succession can no longer open two overlapping sessions.
- Fixed: the optional Govee account email field no longer shows a "valid email" error when left empty — LAN-only and API-key-only setups no longer see a false validation error.
- Fixed: per-segment colour and brightness now have a default value instead of reading as null in visualizations before the first change, and the "Segment Count" label is now translated in all admin languages.
- Fixed: cloud device-state refreshes no longer log a "has no existing object" warning for the action-only snapshot dropdown.
- Fixed: device groups no longer expose a meaningless "verified" trust-tier datapoint (the trust tier only applies to real devices, not groups).
- Fixed: several admin translations — the "manual segment list" hint was untranslated in 10 languages, and the wizard "aborted"/"state tree rebuilt" messages were mistranslated in Dutch, Polish, Spanish, Ukrainian and Chinese.
- Fixed: cleaner shutdown/restart — the adapter no longer opens a cloud connection, logs a stray "connection restored", or emits an unhandled error after it has been told to stop.
- Fixed: a malformed rate-limit response from Govee (Retry-After of 0) no longer causes rapid back-to-back cloud retries; the retry now waits at least 5 seconds.
- Fixed: the adapter logs "ready" as soon as the sensor push (cloud-events) channel connects, instead of possibly waiting up to a minute for the safety timer.

### 2.16.2 (2026-06-16) — stable
- On hosts with multiple network interfaces, LAN device discovery now uses the selected interface for outgoing traffic, so it no longer misses devices by scanning on the wrong one.

### 2.16.1 (2026-06-11)

- Running in compact mode no longer intercepts errors from other adapters in the same process — error reporting stays correctly attributed per adapter.
- Cloud commands issued during a long rate-limit window no longer pile up without limit; stale queued calls are dropped with a single warning.
- Device info entries (name, model, IP address) no longer rewrite their timestamps on every refresh — state history stays clean.

### 2.16.0 (2026-06-09)

- Lights and appliances without a local connection can now be controlled through the Cloud and report their correct online status; devices that support local control keep using it first.
- When account verification, the Cloud API key or the Govee password needs your attention, the adapter now flags it once clearly and as an ioBroker notification instead of repeating the same error.
- Added many more supported device models to the catalog, including Curtain Lights v1 and v2, the TV Backlight 3 Pro and the DreamView T1.
- Requires ioBroker js-controller 7.1.2 or newer.

### 2.15.0 (2026-06-07)

- Added optional Sentry error reporting: crashes are sent to the developer so issues get fixed faster. Active only with ioBroker diagnostics enabled; anonymous.

### 2.14.1 (2026-06-05)

- Corrected the ioBroker role of the scene, mode and snapshot selector states (no change to how they work)

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
