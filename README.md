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

---

## Features

- **LAN First** — UDP multicast discovery and control for lowest latency
- **Real-Time Status** — AWS IoT MQTT push updates (no polling)
- **BLE-over-LAN Scenes** — 78-237 scenes per device activated locally via ptReal protocol (no Cloud needed)
- **Music Mode** — Local BLE-over-LAN music reactive effects with sensitivity and auto-color control
- **DIY Scenes** — User-created scenes activated locally via ptReal
- **Local Snapshots** — Save and restore device state via LAN (independent of Govee Cloud)
- **Scene Control** — Dropdown with all available scenes from Cloud API + local scene library
- **Segment Control** — Per-segment color and brightness for LED strips
- **SKU Cache** — Device data persisted locally, zero Cloud calls after first start
- **Device Quirks** — Automatic correction of wrong API data for specific SKUs
- **Seamless Channel Routing** — Automatically uses the fastest available channel (LAN > MQTT > Cloud)
- **Graceful Degradation** — Works LAN-only without any credentials; each credential level unlocks more features
- **Rate Limited** — Respects Govee API limits (10/min, 10,000/day) with priority queue

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 7.0.0**
- **ioBroker Admin >= 7.6.20**
- **Govee lights with LAN API support** — [Supported devices list](https://app-h5.govee.com/user-manual/wlan-guide)

---

## Ports

| Port | Protocol | Direction | Purpose | Configurable |
|------|----------|-----------|---------|--------------|
| 4001 | UDP | Outbound (multicast 239.255.255.250) | LAN device discovery | No — fixed by Govee LAN protocol |
| 4002 | UDP | Inbound | LAN device responses | No — fixed by Govee LAN protocol |
| 4003 | UDP | Outbound | LAN device commands | No — fixed by Govee LAN protocol |

---

## Configuration

### Credential Levels

The adapter works with different levels of configuration. Each level unlocks additional features:

| Level | Credentials | Features |
|-------|-------------|----------|
| **LAN Only** | None | Power, brightness, color, color temperature via LAN |
| **+ Cloud API** | API Key | Device names, capabilities, scenes, segments, cloud fallback |
| **+ MQTT** | Email + Password | Real-time status push, MQTT control fallback |

### Getting a Govee API Key

1. Open the Govee Home app
2. Go to **Profile** > **Settings** > **About Us** > **Apply for API Key**
3. Enter your reason and submit — the key arrives via email

### Settings

| Option | Description | Default |
|--------|-------------|---------|
| **Network Interface** | IP address of the network interface for LAN discovery (leave empty for all interfaces) | All |
| **API Key** | Govee Cloud API key (optional) | — |
| **Email** | Govee account email (optional) | — |
| **Password** | Govee account password (optional) | — |

---

## State Tree

Device folders use a stable `sku_shortId` naming (e.g., `h61be_1d6f`). The human-readable Cloud device name is stored in `common.name` and `info.name`. Groups (BaseGroup) are separated into a `groups/` folder.

```
govee-smart.0.
├── info/
│   ├── connection              — Overall connection status (boolean)
│   ├── mqttConnected           — MQTT connection status (boolean)
│   └── cloudConnected          — Cloud API connection status (boolean)
├── devices/
│   └── h61be_1d6f/             — Stable SKU + short device ID
│       ├── info/
│       │   ├── name            — Cloud device name (string)
│       │   ├── model           — Product SKU (string)
│       │   ├── serial          — Device ID (string)
│       │   ├── online          — Device reachable (boolean)
│       │   └── ip              — LAN IP address (string, auto-updated)
│       ├── control/
│       │   ├── power           — On/Off (boolean, writable)
│       │   ├── brightness      — Brightness 0-100% (number, writable)
│       │   ├── colorRgb        — Color as "#RRGGBB" (string, writable)
│       │   ├── colorTemperature — Color temperature in Kelvin (number, writable)
│       │   └── gradient_toggle — Gradient on/off (boolean, writable)
│       ├── scenes/
│       │   ├── light_scene     — Light scene (string, dropdown, writable)
│       │   ├── diy_scene       — DIY scene (string, dropdown, writable)
│       │   └── scene_speed     — Scene speed level (number, slider, writable)
│       ├── music/
│       │   ├── music_mode      — Music mode effect (string, dropdown, writable)
│       │   ├── music_sensitivity — Music sensitivity 0-100 (number, writable)
│       │   └── music_auto_color — Music auto color (boolean, writable)
│       ├── snapshots/
│       │   ├── snapshot          — Cloud snapshot (string, dropdown, writable)
│       │   ├── snapshot_local    — Local snapshot (string, dropdown, writable)
│       │   ├── snapshot_save     — Save current state as local snapshot (string, writable)
│       │   ├── snapshot_delete   — Delete a local snapshot (string, writable)
│       │   ├── diagnostics_export — Export device diagnostics (button, writable)
│       │   └── diagnostics_result — Diagnostics JSON output (string, read-only)
│       └── segments/
│           ├── count           — Number of segments (number)
│           ├── command         — Batch control "1-5:#ff0000:20" (string, writable)
│           └── {0..n}/
│               ├── color       — Segment color "#RRGGBB" (string, writable)
│               └── brightness  — Segment brightness 0-100% (number, writable)
└── groups/
    └── basegroup_1280/         — Govee device groups
        └── info/
            ├── name            — Group name (string)
            └── online          — Group reachable (boolean)
```

---

## Batch Segment Control

LED strips with multiple segments can be controlled in bulk via the `segments.command` state. This sends a single string command instead of setting each segment individually.

### Format

```
segments:color:brightness
```

| Part | Description | Required |
|------|-------------|----------|
| **segments** | Which segments to target | Yes |
| **color** | Hex color (`#RRGGBB` or `RRGGBB`) | No (omit with `::`) |
| **brightness** | Brightness 0–100% | No |

At least **color** or **brightness** must be provided.

### Segment Selection

| Syntax | Meaning | Example |
|--------|---------|---------|
| `all` | All segments | `all:#ff0000:50` |
| `3` | Single segment | `3:#00ff00` |
| `1-5` | Range (inclusive) | `1-5:#0000ff:80` |
| `0,3,7` | Specific segments | `0,3,7:#ffffff` |
| `0,3-5,10` | Mixed | `0,3-5,10:#ff00ff:60` |

Segment indices start at 0. Values beyond the device's segment count are automatically clamped.

### Examples

| Command | Effect |
|---------|--------|
| `all:#ff0000:50` | All segments red at 50% brightness |
| `1-5:#00ff00` | Segments 1–5 green (brightness unchanged) |
| `0,3,7:#0000ff:80` | Segments 0, 3 and 7 blue at 80% |
| `all::30` | All segments brightness to 30% (color unchanged) |
| `2-4:ff8800` | Segments 2–4 orange (# prefix optional) |

### Notes

- Requires a **Cloud API key** (segments are controlled via Cloud API)
- Each command sends at most 2 API calls (one for color, one for brightness) regardless of how many segments are selected
- Individual segment states (`segments.0.color`, `segments.0.brightness`, etc.) are automatically updated after a batch command

---

## Troubleshooting

### No devices discovered

- Ensure your Govee lights are connected to the **same network** as ioBroker
- Check that UDP multicast (239.255.255.250) is not blocked by your router/firewall
- Only devices with **LAN API support** are discovered — [Supported devices list](https://app-h5.govee.com/user-manual/wlan-guide)
- Verify your lights have the latest firmware via the Govee Home app

### Scenes/segments not available

- An **API Key** is required for scene and segment control
- Scenes are loaded from the Cloud API — check the API key is valid

### Status updates are delayed

- Without MQTT credentials, status is only updated via LAN responses
- Add your **Govee email and password** for real-time MQTT status push

### MQTT connection fails

- MQTT uses the same credentials as the Govee Home app
- If you use social login (Google/Apple), create a password in the Govee app first
- Check adapter logs for authentication errors

---

## Changelog
### 1.1.1 (2026-04-12)
- Remove redundant CI checkout, add `no-floating-promises` lint rule, remove unused devDependencies, fix duplicate news entry

### 1.1.0 (2026-04-11)
- Add diagnostics export per device — structured JSON for GitHub issue submission
- Add community quirks database — external JSON (`community-quirks.json`) for user-contributed SKU overrides
- Fix array bounds checks in scene/DIY/snapshot index lookups (prevents crash on invalid indices)
- Fix segment batch parsing edge cases (negative indices, empty device list growth)
- Major internal refactoring: 8 focused refactorings for improved maintainability
  - Extract `CommandRouter` from DeviceManager (device-manager.ts: 1,459 → 886 lines)
  - Extract `GoveeApiClient` from MQTT client (govee-mqtt-client.ts: 785 → 483 lines)
  - Extract `buildDeviceStateDefs` to capability-mapper (main.ts: 1,077 → 921 lines)
  - Shared HTTP client replacing 3 duplicate implementations
  - Shared color utilities (`rgbToHex`, `hexToRgb`, `rgbIntToHex`)
  - Channel field on `StateDefinition` replacing fragile Set-based routing
  - Consolidated rate-limiter pattern and split `loadFromCloud` into sub-methods
- Test coverage increased to 309 tests (was 291)

### 1.0.1 (2026-04-11)
- Fix segment capability matching: color and brightness commands now route to correct API capabilities
- Fix segment count using maximum across all segment capabilities instead of first found
- Fix hardcoded 15-segment fallback replaced with safe default
- Fix missing clearTimeout for one-shot timers in onUnload

### 1.0.0 (2026-04-11)
- **BREAKING:** Multi-channel state tree — states split into `control`, `scenes`, `music`, `snapshots` channels
- **BREAKING:** Removed `pollInterval` setting (Cloud polling was removed in 0.9.3)
- Fix incomplete cache detection bug (type check `"devices.types.light"` never matched Cloud's `"light"`)
- Remove dead code: unused methods, config fields, LanDevice version fields
- Dynamic segment count from capabilities, excess segments cleaned up on startup
- Groups minimal: BaseGroup only has `info.name` + `info.online`

### 0.9.6 (2026-04-11)
- Fix scenes missing for most devices due to incomplete cache from rate-limited Cloud fetch
- Fix MQTT "account abnormal" incorrectly treated as wrong credentials (keeps reconnecting instead of stopping)
- Ready message now waits for LAN scan and state creation before logging
- Remove per-device detail lines from ready summary (redundant with state tree)
- Fill scenes from scene library when Cloud scenes are missing (ptReal fallback)

### 0.9.5 (2026-04-11)
- Fix device names not updating from cache when LAN discovery runs first

### 0.9.4 (2026-04-11)
- Improve startup and ready logging: clear channel summary, per-device details with LAN IPs and scene counts
- Remove excessive debug noise: default value checks, periodic LAN scan messages
- Promote MQTT first-connect to info level for better visibility

### 0.9.3 (2026-04-09)
- Add local snapshots: save/restore device state via LAN without Cloud
- Add device quirks system: correct wrong API data for specific SKUs
- Add scene speed control infrastructure (speed adjustment pending live testing)
- Extend test coverage to 254 tests

Older entries have been moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.govee-smart/issues)

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
