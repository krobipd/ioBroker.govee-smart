# ioBroker.govee-smart

[![npm version](https://img.shields.io/npm/v/iobroker.govee-smart)](https://www.npmjs.com/package/iobroker.govee-smart)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.govee-smart)](https://www.npmjs.com/package/iobroker.govee-smart)
![Installations](https://iobroker.live/badges/govee-smart-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.govee-smart/main/admin/govee-smart.svg" width="100" />

Control [Govee](https://www.govee.com/) smart lights via three seamless channels: **LAN** (fastest, primary), **AWS IoT MQTT** (real-time status push), and **Cloud API v2** (scenes, segments, capabilities).

> **Lights only!** This adapter handles Govee LED strips, bulbs, and light panels. Heaters, humidifiers, fans, air purifiers, sensors, and other non-light devices are not supported — use [ioBroker.govee-appliances](https://github.com/krobipd/ioBroker.govee-appliances) for those.

---

## Documentation

Full user documentation lives in the **[Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki)**.

| Topic | English | Deutsch |
|---|---|---|
| Landing page | [Home](https://github.com/krobipd/ioBroker.govee-smart/wiki/Home) | [Startseite](https://github.com/krobipd/ioBroker.govee-smart/wiki/Startseite) |
| Credentials, API key, coexistence | [Setup](https://github.com/krobipd/ioBroker.govee-smart/wiki/Setup) | [Einrichtung](https://github.com/krobipd/ioBroker.govee-smart/wiki/Einrichtung) |
| Segment count, wizard, cut strips, batch commands | [Segments](https://github.com/krobipd/ioBroker.govee-smart/wiki/Segments) | [Segmente](https://github.com/krobipd/ioBroker.govee-smart/wiki/Segmente) |
| Scene library, speed slider, Cloud vs local snapshots | [Scenes and Snapshots](https://github.com/krobipd/ioBroker.govee-smart/wiki/Scenes-and-Snapshots) | [Szenen und Snapshots](https://github.com/krobipd/ioBroker.govee-smart/wiki/Szenen-und-Snapshots) |
| Group fan-out, capability intersection | [Groups](https://github.com/krobipd/ioBroker.govee-smart/wiki/Groups) | [Gruppen](https://github.com/krobipd/ioBroker.govee-smart/wiki/Gruppen) |
| Folder naming, startup, diagnostics, troubleshooting | [Behavior](https://github.com/krobipd/ioBroker.govee-smart/wiki/Behavior) | [Verhalten](https://github.com/krobipd/ioBroker.govee-smart/wiki/Verhalten) |
| Built-in corrections, community-quirks.json, reporting | [Device Quirks](https://github.com/krobipd/ioBroker.govee-smart/wiki/Device-Quirks) | [Geräte-Korrekturen](https://github.com/krobipd/ioBroker.govee-smart/wiki/Geraete-Korrekturen) |

---

## Features

- LAN-first control (UDP multicast discovery, sub-50 ms commands)
- Real-time status push via AWS IoT MQTT
- Scenes, DIY scenes, music mode, gradient toggle — activated locally via BLE-over-LAN
- Cloud and local snapshots
- Per-segment color and brightness for LED strips, including batch commands
- Interactive Segment Detection Wizard for cut strips
- Diagnostics export button per device — one-click JSON dump for bug reports
- Groups with LAN fan-out
- Graceful degradation — works LAN-only, each credential tier unlocks more
- Rate-limited Cloud usage, coexists with ioBroker.govee-appliances

---

## Requirements

- Node.js >= 20
- ioBroker js-controller >= 7.0.0
- ioBroker Admin >= 7.6.20
- Govee lights with LAN API support — [supported device list](https://app-h5.govee.com/user-manual/wlan-guide)

---

## Credential levels

| Level | Credentials | Features |
|-------|-------------|----------|
| **LAN only** | None | Power, brightness, color, color temperature, local snapshots |
| **+ Cloud API** | API Key | + Device names, scenes, segments, Cloud snapshots, basic groups |
| **+ Govee account** | Email + password | + Real-time status push, full group control |

See the [Setup page](https://github.com/krobipd/ioBroker.govee-smart/wiki/Setup) for how to get an API key and how to configure the network interface.

---

## Ports

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 4001 | UDP | Outbound (multicast 239.255.255.250) | LAN device discovery |
| 4002 | UDP | Inbound | LAN device responses |
| 4003 | UDP | Outbound | LAN device commands |

All ports are fixed by the Govee LAN protocol and cannot be changed.

---

## Troubleshooting

Common issues (no devices discovered, empty scenes dropdown, segment colors not changing, limited group commands, delayed status updates) are covered on the Wiki [Behavior](https://github.com/krobipd/ioBroker.govee-smart/wiki/Behavior) / [Verhalten](https://github.com/krobipd/ioBroker.govee-smart/wiki/Verhalten) page.

For anything else, press **`info.diagnostics_export`** on the affected device, copy the JSON from `info.diagnostics_result`, and open a [GitHub Issue](https://github.com/krobipd/ioBroker.govee-smart/issues).

---

## Acknowledgments

This adapter's MQTT authentication and BLE-over-LAN (ptReal) protocol implementation was informed by research from [govee2mqtt](https://github.com/wez/govee2mqtt) by Wez Furlong. Their reverse-engineering of the Govee AWS IoT MQTT protocol and undocumented API endpoints was invaluable.

---

## Changelog

### 1.7.7 (2026-04-19)
- Fix wizard result and MQTT-learned segment count lost on every restart — cache load didn't merge the segment fields into LAN-discovered devices
- Cache write now fsyncs so a SIGKILL during adapter stop can't silently drop the save

### 1.7.6 (2026-04-19)
- Fix manual_mode rollback on invalid manual_list no longer bounces the rejected value back into the state
- Complete wizard translations in 9 admin languages (previously raw keys), worst machine-translation glitches hand-corrected
- info channel keeps its "Device Information" display name
- Drop "~100 ms" latency claim from LAN section, reworded in all 11 languages
- Internal: applyManualSegments helper, targeted state refresh on snapshot ops, dynamic_scene mapping cleanup, prefix-map cleanup on device removal, loadDeviceScenes dead-logic removed, MQTT/Cloud routing docstrings corrected

### 1.7.5 (2026-04-19)
- Fix Wiki link in adapter settings — Markdown in staticText wasn't rendered, replaced with two staticLink buttons (DE + EN)

### 1.7.4 (2026-04-19)
- Add language-aware Wiki link at the top of the main configuration tab

### 1.7.3 (2026-04-19)
- `common.messagebox=true` for onMessage wizard (latest-repo review compliance)
- Color-mode preamble delays routed through adapter timer wrapper (onUnload-safe)

### 1.7.2 (2026-04-19)
- Test infrastructure aligned with ioBroker standard — plain-JS package.js + integration.js

### 1.7.1 (2026-04-19)
- Segment commands force color mode before sending — previously silently ignored in Scene/Gradient/Music mode
- Side effect: automatic segment-count learning once you touch any segment control

Older entries have been moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

---

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

*Developed with assistance from Claude.ai*
