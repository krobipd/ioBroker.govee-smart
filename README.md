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

Full user documentation lives in the **[Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki)** — available in [English](https://github.com/krobipd/ioBroker.govee-smart/wiki/Home) and [Deutsch](https://github.com/krobipd/ioBroker.govee-smart/wiki/Startseite):

- **[Setup](https://github.com/krobipd/ioBroker.govee-smart/wiki/Setup)** / **[Einrichtung](https://github.com/krobipd/ioBroker.govee-smart/wiki/Einrichtung)** — credentials, API key, coexistence with govee-appliances
- **[Segments](https://github.com/krobipd/ioBroker.govee-smart/wiki/Segments)** / **[Segmente](https://github.com/krobipd/ioBroker.govee-smart/wiki/Segmente)** — segment count handling, the wizard, cut strips, batch commands
- **[Scenes and Snapshots](https://github.com/krobipd/ioBroker.govee-smart/wiki/Scenes-and-Snapshots)** / **[Szenen und Snapshots](https://github.com/krobipd/ioBroker.govee-smart/wiki/Szenen-und-Snapshots)** — scene library, speed slider, Cloud vs local snapshots
- **[Groups](https://github.com/krobipd/ioBroker.govee-smart/wiki/Groups)** / **[Gruppen](https://github.com/krobipd/ioBroker.govee-smart/wiki/Gruppen)** — group fan-out, capability intersection
- **[Behavior](https://github.com/krobipd/ioBroker.govee-smart/wiki/Behavior)** / **[Verhalten](https://github.com/krobipd/ioBroker.govee-smart/wiki/Verhalten)** — folder naming, startup, diagnostics, troubleshooting

---

## Features

- LAN-first control (UDP multicast discovery, sub-50 ms commands)
- Real-time status push via AWS IoT MQTT
- Scenes, DIY scenes, music mode, gradient toggle — activated locally via BLE-over-LAN
- Cloud and local snapshots
- Per-segment color and brightness for LED strips, including batch commands
- Interactive Segment Detection Wizard for cut strips
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

## Acknowledgments

This adapter's MQTT authentication and BLE-over-LAN (ptReal) protocol implementation was informed by research from [govee2mqtt](https://github.com/wez/govee2mqtt) by Wez Furlong. Their reverse-engineering of the Govee AWS IoT MQTT protocol and undocumented API endpoints was invaluable.

---

## Changelog

### 1.7.3 (2026-04-19)
- **Latest-repo review compliance.** `common.messagebox=true` added to `io-package.json` because the Segment Wizard uses `onMessage`. The two 150 ms delays used for Govee's colour-mode preamble (in the LAN client and the CommandRouter) are now routed through the adapter timer wrapper, so pending delays get cancelled on `onUnload` instead of firing into a torn-down adapter. No runtime-visible change.

### 1.7.2 (2026-04-19)
- **Test infrastructure aligned with the ioBroker standard.** `test/package.js` and `test/integration.js` are now plain JS calling `tests.packageFiles` / `tests.integration` directly, matching the template every other adapter in this workspace uses. Previously only a TypeScript-based package-files test existed, and the `test:integration` script silently re-ran the unit tests instead of spinning up a real js-controller. No runtime change — this only affects CI and the Latest-repo review.

### 1.7.1 (2026-04-19)
- **Segment commands now force color mode before sending.** Previously, setting `segments.5.color` (or any segment-level state) while the strip was running a Scene, Gradient, or Music mode had no visible effect — the device silently ignored the ptReal packet. The CommandRouter now emits a `colorwc` pre-amble using the device's last-known colorRgb (so the strip doesn't visibly flicker if it was already in color mode) and waits 150 ms before sending the segment packet.
- **Side effect: automatic segment-count learning.** Because the color-mode switch also makes the device push MQTT AA A5 packets, the adapter now learns the real segment count the first time you touch any segment control — no manual Wizard run needed for strips that under-report via Cloud.

### 1.7.0 (2026-04-19)
- **Reliable segment count.** The adapter now uses a single source of truth for how many segments your strip has: cache → MQTT-learned → minimum of Cloud-advertised. Once the real length is discovered it's persisted and survives restarts. No more "Cloud said 15, strip really has 20" headaches
- **Segment Wizard redesign — one clear flow.** Three buttons: **✓ Ja sichtbar / ✗ Nein dunkel / ■ Fertig – Strip zu Ende**. The wizard measures the REAL length regardless of what Cloud reports (runs up to the Govee protocol limit of 55), detects gaps automatically (cut strips), and applies the result atomically — segmentCount, manualMode, manualList get set together, state tree gets rebuilt, everything persists
- **Wizard now forces color mode before each flash.** Previously the flash packets were silently ignored when the strip happened to be in Scene/Gradient/Music mode. The wizard now sends a `colorwc` pre-amble that moves the device into static-color mode, so the segment-level white flash is always visible
- **Manual-mode survives restarts.** Cut-strip settings (`manual_mode` + `manual_list`) are now part of the SKU cache — previously they could be lost on the first rebuild after startup
- Cloud-internal contradictions (e.g. H70D1 Icicle reporting `segmentedBrightness=10` and `segmentedColorRgb=15` in the same response) are resolved conservatively: take the smaller value and let MQTT correct upwards if the real device proves bigger

### 1.6.7 (2026-04-19)
- Fix race when MQTT reveals more segments than Cloud — the discovery push skips the segment-state sync so the new datapoints get created first (no more "State has no existing object" warnings). The next AA A5 push seconds later populates the fully-built tree.

### 1.6.6 (2026-04-19)
- Fix under-reporting of segment count — when Govee Cloud advertises fewer segments than the strip physically has, MQTT `AA A5` packets reveal the real count, and the adapter now bumps `segmentCount` and rebuilds the state tree so datapoints appear for ALL segments (fixes 20 m strips where Cloud says 15 but physical is 20)
- `parseMqttSegmentData` no longer caps output at Cloud's segmentCount; trailing all-zero padding slots are stripped so packet-padding is not mistaken for real segments
- Wizard's flash dims segments 0-55 (Govee bitmask maximum) rather than only up to Cloud segmentCount, so under-reported strips cannot leave any residual lit segments during the wizard
- `manual_list` validation accepts indices up to 55 instead of the Cloud-reported count, so users can declare more physical segments than the Cloud knows about

### 1.6.5 (2026-04-19)
- Fix wizard flash — all three BLE packets (others-dim + target-color + target-brightness) are now bundled into one `ptReal` UDP datagram. Previously separate datagrams were dropped by the device under back-pressure, leading to "only some segments went dark" symptoms
- Wizard now switches the strip ON and sets global brightness to 100 before the first flash, so the selected segment is visible regardless of the previous dim state (baseline is still captured and restored on abort/finish)
- Live status box — new `info.wizardStatus` state, written on every wizard step; admin panel uses `type: "state"` to show the current segment, the total and the next action live (Admin 7.1+)

### 1.6.4 (2026-04-18)
- Wizard UX rewrite — dropdown now shows only online devices, a persistent status box indicates which segment is currently being checked, and each button click triggers a multi-line info toast with clear Yes/No guidance
- Status box uses `textSendTo` (refreshes when the device is re-selected); button responses use the `message` field so admin shows info toasts correctly (previously silent because of wrong field name)

### 1.6.3 (2026-04-18)
- Fix Segment Detection Wizard crash on Start — `parseSegmentBatch` now guards against non-string values; `flashSegment` routing accepts parsed objects directly (the `cmd.split is not a function` crash that produced the v1.6.2 restart loop)
- Harden all async event handlers against unhandled rejections — `ready`/`stateChange`/`onMessage` now route errors via `.catch`; prevents SIGKILL-code-6 restart loops
- Harden Cloud/API/MQTT/LAN boundary types — `Array.isArray` + `typeof` guards added across every external-data iteration, `rgbToHex` NaN/clamp, `hexToRgb` non-string safe, snapshot file path safe against non-string deviceId
- Refactor segment-wizard and cloud-retry-loop into dedicated testable modules
- 511 tests (was 427)

### 1.6.2 (2026-04-18)
- Fix jsonConfig schema warnings for Segment Detection Wizard — removed unsupported `button` property, aligned variant/color to admin schema (`primary`/`secondary`, `contained`/`outlined`), set `xs=12` for mobile layout

### 1.6.1 (2026-04-18)
- Fix Segment Detection Wizard in admin UI — jsonConfig button type was `sendto` (lowercase) instead of `sendTo` causing validation errors
- Fix LED strip dropdown showed as free-text input because `selectSendTo` response was wrapped in `{list: [...]}` instead of bare array

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
