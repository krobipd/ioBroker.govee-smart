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

### 1.10.0 (2026-04-20)
- Scenes with a `scenceParam` (the multi-packet A3 BLE payload that drives per-segment animation) are now skipped on devices without segments and activated via the Govee Cloud instead. Curtain Lights (H70B3) and bulbs silently drop those A3 packets, which left complex scenes unplayed; the simple presets without `scenceParam` kept working. With this fix every scene reaches the device, at the cost of one Cloud call per scene change on non-segmented hardware.
- Powering a device off now resets every mode dropdown (scene, DIY scene, Cloud/local snapshot, music) to "---", whether the off was triggered from ioBroker or from the Govee Home app. A device that is off cannot be "playing Aurora-A" — the UI now reflects that.

### 1.9.1 (2026-04-20)
- Hotfix — Govee's `/device/scenes` endpoint occasionally returns e.g. 149 scenes + 0 snapshots on the same device where a snapshot clearly exists. The old combined guard (`if any of the three lists is non-empty, overwrite all three`) wiped the snapshot list in that case, and the cloud-snapshot dropdown then errored out with `invalid snapshot index 1` on click. Each of scenes, DIY scenes and snapshots is now guarded independently — a lucky list no longer clobbers an unlucky one. Applies to every device with cloud-side snapshots, not just the device where it first surfaced.

### 1.9.0 (2026-04-20)
- **BREAKING** — the cloud-snapshot dropdown has been renamed from `snapshots.snapshot` to `snapshots.snapshot_cloud`. The new id is unambiguous next to `snapshots.snapshot_local`, `snapshots.snapshot_save` and `snapshots.snapshot_delete`. If your scripts or VIS widgets reference the old id, update them to the new one. The old state is simply removed on first start — nothing is migrated because the value (a dropdown index) is set again on the next selection anyway.
- Fix — scenes and snapshots are now re-fetched from the Govee Cloud on every adapter start. Previously, once `scenesChecked` was set on the cache, the adapter skipped the Cloud round-trip even when you had created a new snapshot in the Govee Home app, so new snapshots only appeared after wiping the cache. This was a genuine bug. Scene data is essentially static, but snapshots are user content — refreshing is cheap (one call per light device per startup) and much less surprising.
- New — `info.refresh_cloud_data` button at adapter level. Write `true` to trigger the same fresh fetch without restarting the adapter. Useful when you just created a snapshot in the Govee Home app and want to pick it in ioBroker right now.
- All four snapshot states (`snapshot_cloud`, `snapshot_local`, `snapshot_save`, `snapshot_delete`) now carry a `common.desc` text that makes it clear in the object browser which is the Govee-app kind and which is the ioBroker kind.

### 1.8.0 (2026-04-20)
- Performance — `updateDeviceState` now fires every status write in parallel and drops the per-write object-existence probe; MQTT status pushes cost a fraction of what they used to on large device lists
- Performance — `cleanupAllChannelStates` replaces its four per-device view queries with one broader view; device-list refresh scales with device count instead of 4 × device count
- Performance — `handleSnapshotSave` reads device + per-segment state in parallel; saving a snapshot on a 20-segment strip no longer blocks on 40 sequential reads
- Rate-limiter daily reset aligned to UTC midnight so the adapter's budget flips at the same instant Govee does — no more wasted quota when the adapter was started after midnight
- Local snapshots now write with `fsync`, matching the SKU cache — SIGKILL during adapter stop no longer silently drops a just-saved snapshot
- Library fetches (scene / music / DIY / SKU features) now go through the rate-limiter so a fresh install with many devices doesn't burst-call the undocumented `app2.govee.com` endpoints
- Wizard text fully localised (EN / DE) and resolved against the Admin UI language from `system.config`; English is the fallback for other admin languages
- govee-appliances coexistence covers every instance (`.0`, `.1`, …) not just `.0` — the shared-budget halving trips for any active sibling
- MQTT client keeps a stable per-process session UUID across reconnects; AWS IoT can now take over cleanly from a lingering socket instead of refusing a new connection
- Memory leak prevention — every adapter-level map (diagnostics throttle, state-channel map, device map) is now reaped when a device is removed so long-lived instances stay bounded
- Internal — shared `govee-constants.ts` for Govee app-impersonation headers, `stateToCommand` collapsed to a lookup table, `crypto.randomUUID` replaces the legacy Math.random UUID, unused `total` parameter dropped from `flashSingleSegment`

### 1.7.8 (2026-04-19)
- Fix MQTT bearer-token went stale after reconnect — api-client is now refreshed on every fresh login
- LAN devStatus poll skipped when MQTT is connected (MQTT push is authoritative)
- Added process-level unhandledRejection / uncaughtException handlers as a last line of defence
- Minor hygiene — seenDeviceIps evicts old IPs on device IP change, stateCreationQueue bounded to startup, info.mqttConnected / info.cloudConnected reset on unload, diagnostics export throttled per device (2 s)

### 1.7.7 (2026-04-19)
- Fix wizard result and MQTT-learned segment count lost on every restart — cache load didn't merge the segment fields into LAN-discovered devices
- Cache write now fsyncs so a SIGKILL during adapter stop can't silently drop the save

### 1.7.6 (2026-04-19)
- Fix manual_mode rollback on invalid manual_list no longer bounces the rejected value back into the state
- Complete wizard translations in 9 admin languages (previously raw keys), worst machine-translation glitches hand-corrected
- info channel keeps its "Device Information" display name
- Drop "~100 ms" latency claim from LAN section, reworded in all 11 languages
- Internal: applyManualSegments helper, targeted state refresh on snapshot ops, dynamic_scene mapping cleanup, prefix-map cleanup on device removal, loadDeviceScenes dead-logic removed, MQTT/Cloud routing docstrings corrected

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
