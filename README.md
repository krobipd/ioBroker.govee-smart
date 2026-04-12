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
- **Seamless Channel Routing** — Automatically uses the fastest available channel (LAN > Cloud)
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
| **+ MQTT** | Email + Password | Real-time status push |

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

Channel indicators: **[LAN]** = LAN UDP, **[Cloud]** = Cloud REST API, **[MQTT]** = AWS IoT MQTT, **[local]** = adapter-internal.

```
govee-smart.0.
├── info/
│   ├── connection              — Overall connection status (boolean)
│   ├── mqttConnected           — MQTT connection status (boolean)
│   └── cloudConnected          — Cloud API connection status (boolean)
├── devices/
│   └── h61be_1d6f/             — Stable SKU + short device ID
│       ├── info/
│       │   ├── name            — Cloud device name (string) [Cloud]
│       │   ├── model           — Product SKU (string) [Cloud]
│       │   ├── serial          — Device ID (string) [Cloud]
│       │   ├── online          — Device reachable (boolean) [LAN]
│       │   ├── ip              — LAN IP address (string, auto-updated) [LAN]
│       │   ├── diagnostics_export — Export device diagnostics (button) [local]
│       │   └── diagnostics_result — Diagnostics JSON output (string) [local]
│       ├── control/
│       │   ├── power           — On/Off (boolean, writable) [LAN]
│       │   ├── brightness      — Brightness 0-100% (number, writable) [LAN]
│       │   ├── colorRgb        — Color as "#RRGGBB" (string, writable) [LAN]
│       │   ├── colorTemperature — Color temp in Kelvin (number, writable) [LAN]
│       │   └── gradient_toggle — Gradient on/off (boolean, writable) [Cloud]
│       ├── scenes/
│       │   ├── light_scene     — Light scene (dropdown, writable) [LAN ptReal]
│       │   ├── diy_scene       — DIY scene (dropdown, writable) [LAN ptReal]
│       │   └── scene_speed     — Scene speed (number, slider, writable) [LAN ptReal]
│       ├── music/
│       │   ├── music_mode      — Music effect (dropdown, writable) [LAN ptReal]
│       │   ├── music_sensitivity — Sensitivity 0-100 (number, writable) [LAN ptReal]
│       │   └── music_auto_color — Auto color (boolean, writable) [LAN ptReal]
│       ├── snapshots/
│       │   ├── snapshot          — Cloud snapshot (dropdown, writable) [Cloud]
│       │   ├── snapshot_local    — Local snapshot (dropdown, writable) [LAN]
│       │   ├── snapshot_save     — Save state as local snapshot (string) [LAN]
│       │   └── snapshot_delete   — Delete a local snapshot (string) [LAN]
│       └── segments/
│           ├── count           — Number of segments (number) [Cloud]
│           ├── command         — Batch "1-5:#ff0000:20" (string, writable) [Cloud]
│           └── {0..n}/
│               ├── color       — Segment color "#RRGGBB" (writable) [Cloud]
│               └── brightness  — Segment brightness 0-100% (writable) [Cloud]
└── groups/
    ├── info/
    │   └── online              — Cloud connection status (boolean) [Cloud]
    └── basegroup_1280/         — Govee device groups
        └── info/
            └── name            — Group name (string) [Cloud]
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

## Diagnostics Export

Each device has a **diagnostics export** button (`info.diagnostics_export`). Pressing it writes a structured JSON to `info.diagnostics_result` containing:

- Device info (SKU, ID, name, channels, LAN IP)
- All Cloud capabilities (raw API data)
- Scenes, DIY scenes, snapshots (names and count)
- Scene/music/DIY libraries (codes, speed support)
- Applied quirks and SKU features
- Current device state

**Usage:** Press the button in ioBroker Objects or vis, copy the JSON from `info.diagnostics_result`, and paste it into a [GitHub Issue](https://github.com/krobipd/ioBroker.govee-smart/issues). This gives all the data needed to diagnose problems or add support for new devices.

---

## Community Quirks

Some Govee devices report wrong data via the Cloud API (e.g., incorrect color temperature range). The adapter has built-in corrections for known devices, but you can add your own via a `community-quirks.json` file.

### Setup

Create the file in your **adapter data directory** (persistent across updates):

```
/opt/iobroker/iobroker-data/govee-smart.0/community-quirks.json
```

### Format

```json
{
  "version": 1,
  "quirks": {
    "H6XXX": { "colorTempRange": { "min": 2200, "max": 6500 } },
    "H6YYY": { "brokenPlatformApi": true }
  }
}
```

### Available quirk options

| Option | Type | Effect |
|--------|------|--------|
| `colorTempRange` | `{ min, max }` | Override the color temperature range (Kelvin) |
| `brokenPlatformApi` | `boolean` | Skip Cloud API for this SKU (broken metadata) |

Community entries override built-in quirks for the same SKU. Use the **diagnostics export** to gather device data when contributing a new quirk.

---

## Acknowledgments

This adapter's MQTT authentication and BLE-over-LAN (ptReal) protocol implementation was informed by research from [govee2mqtt](https://github.com/wez/govee2mqtt) by Wez Furlong. Their reverse-engineering of the Govee AWS IoT MQTT protocol and undocumented API endpoints was invaluable.

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
### 1.2.0 (2026-04-12)
- Fix segment color commands not working (ptReal accepted but not rendered) — rerouted via Cloud API
- Fix dropdown states not resetting on mode switch (scene/music/snapshot/color changes now reset all other dropdowns)
- Replace individual group online states with single `groups.info.online` reflecting Cloud connection status
- Add channel annotations to state tree documentation
- Add acknowledgments for govee2mqtt project

### 1.1.2 (2026-04-12)
- Remove dead MQTT command code (MQTT is status-push only, never sent commands)
- Remove `noMqtt` device quirk (no longer needed without MQTT commands)
- Remove dead `CloudApiError` re-export
- Replace inline hex parsing with shared `hexToRgb()` utility
- Simplify LAN fallback to Cloud-only (was LAN → MQTT → Cloud)

### 1.1.1 (2026-04-12)
- **BREAKING:** Move diagnostics states from `snapshots/` to `info/` channel (where device information belongs)
- Fix community quirks loading from persistent data directory instead of adapter directory (survives updates)
- Document diagnostics export and community quirks in README
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

Older entries have been moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

---

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
