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
- **BLE-over-LAN Scenes** — All available scenes activated locally via ptReal protocol (loaded once from Cloud, then cached)
- **Music Mode** — Local BLE-over-LAN music reactive effects with sensitivity and auto-color control
- **DIY Scenes** — User-created scenes activated locally via ptReal
- **Local Snapshots** — Save and restore basic device state (power, brightness, color) via LAN — no Cloud needed, but limited to LAN-controllable states
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
| **LAN Only** | None | Power, brightness, color, color temperature, local snapshots |
| **+ Cloud API** | API Key | + Device names, scenes (activated locally), segments, cloud snapshots, groups (basic) |
| **+ Govee Account** | Email + Password | + Real-time status push via MQTT, group fan-out control (scenes, music via member devices) |

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

Channel indicators: **[LAN]** = LAN UDP control, **[LAN ptReal]** = BLE-over-LAN (scenes, music — activated locally but scene list comes from Cloud), **[Cloud]** = Cloud REST API, **[MQTT]** = AWS IoT MQTT status push, **[local]** = adapter-internal.

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
│       │   └── diy_scene       — DIY scene (dropdown, writable) [LAN ptReal]
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
│               ├── color       — Segment color "#RRGGBB" (writable) [Cloud, MQTT sync]
│               └── brightness  — Segment brightness 0-100% (writable) [Cloud, MQTT sync]
└── groups/
    ├── info/
    │   └── online              — Cloud connection status (boolean) [Cloud]
    └── basegroup_1280/         — Govee device groups
        ├── info/
        │   ├── name            — Group name (string) [Cloud]
        │   ├── members         — Member device IDs (string, read-only) [Cloud]
        │   └── membersUnreachable — Unreachable members (string, dynamic) [local]
        ├── control/
        │   ├── power           — On/Off → fan-out to all members [LAN]
        │   ├── brightness      — Brightness → fan-out to all members [LAN]
        │   ├── colorRgb        — Color → fan-out to all members [LAN]
        │   └── colorTemperature — Color temp → fan-out to all members [LAN]
        ├── scenes/
        │   └── light_scene     — Scene → fan-out by name matching [LAN ptReal]
        └── music/
            └── music_mode      — Music → fan-out by name matching [LAN ptReal]
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

## Scenes & Music Mode

### Light Scenes

The `scenes.light_scene` dropdown lists all available scenes for a device. Scenes are **loaded from the Cloud API** on first start (requires API key), then cached locally. Activation happens **locally via BLE-over-LAN** (ptReal protocol) — fast and without Cloud calls.

### DIY Scenes

The `scenes.diy_scene` dropdown shows user-created scenes from the Govee Home app. These are also activated locally via ptReal.

### Music Mode

Music-reactive effects are activated via `music.music_mode` (dropdown). The device listens to ambient sound through its built-in microphone.

| State | Description |
|-------|-------------|
| `music_mode` | Effect style (Energic, Spectrum, Rolling, Rhythm, etc.) |
| `music_sensitivity` | Microphone sensitivity 0–100% |
| `music_auto_color` | Automatic color cycling on/off |

Music mode is activated **locally via BLE-over-LAN**. The music library is loaded once from Cloud, then cached — after that no Cloud needed.

### Dropdown Reset Behavior

When switching between modes, all **other** mode dropdowns automatically reset to "---":

- Selecting a **scene** resets music, snapshots, and DIY dropdowns
- Selecting a **music mode** resets scene and snapshot dropdowns
- Changing **color or color temperature** resets scene, music, and snapshot dropdowns

This reflects reality — the device can only be in one mode at a time. If a dropdown shows "---", it means that mode is not currently active.

---

## Snapshots

There are two types of snapshots — **Cloud snapshots** and **local snapshots**. They serve different purposes.

### Cloud Snapshots (`snapshots.snapshot`)

Cloud snapshots are created in the **Govee Home app** and stored on Govee's servers. They can capture the complete device state including scenes, segments, and effects. Selecting one sends a Cloud API command to restore it.

- Requires **Cloud API key**
- Created/managed in the Govee Home app only
- Can restore any state the app can set

### Local Snapshots (`snapshots.snapshot_local`)

Local snapshots are created and stored **by the adapter** on your ioBroker server. They are independent of Govee Cloud but can only save what the LAN API can control.

**What is saved:**
- Power on/off
- Brightness
- Color (RGB)
- Color temperature (Kelvin)

**What is NOT saved:**
- Scenes, DIY scenes
- Music mode settings
- Segment colors and brightness
- Gradient toggle

### Local Snapshot Workflow

**Save:** Write a name into `snapshots.snapshot_save` (e.g., "Evening Warm"). The adapter reads the current device state and saves it locally. The name appears in the `snapshot_local` dropdown.

**Restore:** Select a snapshot from the `snapshots.snapshot_local` dropdown. The adapter sends individual LAN commands for power, brightness, and color/colorTemp.

**Delete:** Write the exact snapshot name into `snapshots.snapshot_delete`.

**Tip:** If you want to save a complete setup with segments and scenes, use **Cloud snapshots** via the Govee Home app instead.

---

## Groups

Groups are **Govee device groups** created in the Govee Home app (e.g., "All Living Room Lights"). They appear under the `groups/` folder.

- Groups require an **API key** for basic visibility (name, folder)
- Full group control (scenes, music) additionally requires **Email + Password** for member device resolution
- Commands are **fanned out** to each member device individually via LAN/ptReal — not sent as a single Cloud command
- Group capabilities are the **intersection** of all member devices (only states that all members support)
- `info.members` shows which devices belong to the group
- `info.membersUnreachable` appears dynamically when member devices are offline
- `groups.info.online` reflects the Cloud connection status

Groups do not have model, serial, IP, snapshots, segments, or diagnostics — they are virtual collections that route commands to real devices.

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

### Scenes dropdown is empty

- An **API Key** is required — the scene list comes from the Cloud API
- On first start, scenes are loaded from Cloud. After that, the SKU cache provides them without Cloud calls
- If the cache is incomplete (e.g., after a rate-limited first start), restart the adapter

### Segment colors don't change

- Segment control requires a **Cloud API key** — segments are controlled exclusively via Cloud API
- Check that `info.cloudConnected` is `true`
- Make sure you're not exceeding the rate limit (10 commands/min per device)

### Local snapshot doesn't restore my scene/segments

- Local snapshots only save **basic LAN states**: power, brightness, color, color temperature
- Scenes, segments, gradient, and music mode are **not included**
- Use **Cloud snapshots** (via Govee Home app) to save complete device states including scenes and segments

### Groups not showing

- Groups are loaded from the **Cloud API** — an API key is required
- Groups must be created in the **Govee Home app** first

### Group commands not working (only power toggle)

- Full group fan-out (scenes, music, color) requires **Email + Password** for member device resolution
- Without account credentials, only basic group info (name) is available from the Cloud API
- Check that `info.members` is populated — if empty, the adapter could not resolve group membership

### Status updates are delayed

- Without MQTT credentials, status is only updated via LAN responses
- Add your **Govee email and password** for real-time MQTT status push

### MQTT connection fails

- MQTT uses the same credentials as the Govee Home app
- If you use social login (Google/Apple), create a password in the Govee app first
- Check adapter logs for authentication errors

---

## Changelog
### 1.4.1 (2026-04-13)
- Fix group member resolution returning empty (API field name mismatch: `gId`/`name` vs `groupId`/`groupName`)
- Add bearer token pre-check with descriptive log message for group membership loading
- Add debug logging when group membership API returns no data

### 1.4.0 (2026-04-13)
- Redesign group handling: fan-out commands to member devices via LAN/ptReal instead of Cloud-only power toggle
- Group capabilities computed as intersection of member devices (power, brightness, color, scenes, music)
- Add `info.members` state showing group member device IDs
- Add dynamic `info.membersUnreachable` state (only created when unreachable members exist)
- Remove snapshots and diagnostics from groups (not applicable to virtual devices)
- Update undocumented API headers to match current Govee app version (7.3.30)
- 327 tests (was 314)

### 1.3.0 (2026-04-12)
- Add MQTT segment state sync — per-segment brightness and color updated in real-time via MQTT BLE notifications
- Remove non-functional scene speed slider (byte layout unknown, no project worldwide implements this)
- Remove dead code: unused types, methods, and write-only fields (comprehensive audit, 8 findings)

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
