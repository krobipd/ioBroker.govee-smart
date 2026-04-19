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

> **Lights only!** This adapter handles Govee LED strips, bulbs, and light panels. Heaters, humidifiers, fans, air purifiers, sensors, and other non-light devices are not supported.

---

## Features

- **LAN First** — UDP multicast discovery and control for lowest latency
- **Real-Time Status** — AWS IoT MQTT push updates (no polling)
- **Scenes** — All available scenes as dropdown, loaded once from Cloud then cached, activated locally via BLE-over-LAN (ptReal)
- **Music Mode** — Local BLE-over-LAN music reactive effects with sensitivity and auto-color control
- **DIY Scenes** — User-created scenes activated locally via ptReal
- **Local Snapshots** — Save and restore device state including per-segment colors via LAN — no Cloud needed
- **Cloud Snapshots** — Restore complete device state (scenes, effects) locally via BLE-over-LAN
- **Segment Control** — Per-segment color and brightness for LED strips, controlled locally via BLE-over-LAN
- **Manual Segments (Cut Strips)** — For LED strips that have been shortened physically, define which segment indices actually exist. Includes an interactive wizard in the admin UI to detect the count automatically (flash + Yes/No per segment)
- **Scene Speed** — Adjust playback speed for supported scenes via slider
- **Scene Variants** — All light effect variants per scene (A/B/C/D) available as separate dropdown entries
- **SKU Cache** — Device data persisted locally, zero Cloud calls after first start. Stale entries are pruned automatically after 14 days without network sighting.
- **Resilient Startup** — 60-second startup grace for MQTT + Cloud; each channel keeps retrying in the background (MQTT auto-reconnect, Cloud every 5 min, Rate-Limit-Header respected)
- **Device Quirks** — Automatic correction of wrong API data for specific SKUs
- **Seamless Channel Routing** — Automatically uses the fastest available channel (LAN > Cloud)
- **Graceful Degradation** — Works LAN-only without any credentials; each credential level unlocks more features
- **Rate Limited** — Respects Govee Cloud API limits with priority queue

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
│       │   ├── diy_scene       — DIY scene (dropdown, writable) [LAN ptReal]
│       │   └── scene_speed     — Scene playback speed (number, writable) [LAN ptReal]
│       ├── music/
│       │   ├── music_mode      — Music effect (dropdown, writable) [LAN ptReal]
│       │   ├── music_sensitivity — Sensitivity 0-100 (number, writable) [LAN ptReal]
│       │   └── music_auto_color — Auto color (boolean, writable) [LAN ptReal]
│       ├── snapshots/
│       │   ├── snapshot          — Cloud snapshot (dropdown, writable) [LAN ptReal, Cloud fallback]
│       │   ├── snapshot_local    — Local snapshot (dropdown, writable) [LAN]
│       │   ├── snapshot_save     — Save state as local snapshot (string) [LAN]
│       │   └── snapshot_delete   — Delete a local snapshot (string) [LAN]
│       └── segments/
│           ├── count           — Number of segments (number) [Cloud]
│           ├── command         — Batch "1-5:#ff0000:20" (string, writable) [LAN ptReal, Cloud fallback]
│           ├── manual_mode     — Manual segments active (boolean, writable) [local]
│           ├── manual_list     — Physical indices "0-9" or "0-8,10-14" (string, writable) [local]
│           └── {0..n}/
│               ├── color       — Segment color "#RRGGBB" (writable) [LAN ptReal, MQTT sync]
│               └── brightness  — Segment brightness 0-100% (writable) [LAN ptReal, MQTT sync]
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

- Requires a **Cloud API key** (segment definitions come from Cloud API)
- Segments are controlled **locally via BLE-over-LAN** (ptReal) with Cloud fallback
- Each command sends at most 2 packets (one for color, one for brightness) using a multi-segment bitmask
- Individual segment states (`segments.0.color`, `segments.0.brightness`, etc.) are automatically updated after a batch command

---

## Segment Detection Wizard

Govee Cloud often disagrees with reality about how long your strip is — under-reports long strips (Cloud says 15, strip has 20) or contradicts itself between its own fields. The adapter learns the real count automatically from MQTT packets, but if you want a definitive measurement — or if you've **cut** your strip and need to declare the visible indices — use the wizard.

### Using the wizard

Open the adapter settings, switch to the **Segment Detection** tab:

1. Pick the LED strip from the dropdown
2. Click **▶ Start** — the first segment flashes bright white, all others dark
3. Look at the strip:
   - It lights up at the right spot? → **✓ Ja, sichtbar**
   - It's dark at this index (cut strip, gap)? → **✗ Nein, dunkel**
   - The strip ends here / nothing lights up anymore? → **■ Fertig – Strip zu Ende**
4. The adapter measures the total length from your answers, detects gaps automatically, and writes the result:
   - No gaps → `manual_mode=false`, the segment tree just matches the real length
   - Gaps detected → `manual_mode=true`, `manual_list` gets a compact notation (`"0-8,10-14"`)
5. Everything persists across restarts via the SKU cache

The session auto-aborts after 5 minutes of inactivity and restores the strip's previous colors.

### Manual editing (no wizard)

You can also set the states yourself:

- `segments.manual_list` — comma-separated indices, supports ranges:
  - `"0-9"` — first 10 segments of a 15-segment strip
  - `"0-8,10-14"` — segment 9 is cut/broken, skip it
  - `"0,1,2,3,4,5,6"` — individual indices equivalent to `"0-6"`
- `segments.manual_mode` — set to `true` to activate, `false` to restore contiguous behaviour

### Behavior details

- `segments.count` reflects the effective number of physical segments (manual list length, or the total when manual-mode is off)
- `segments.command all:...` expands to the physical indices only, skipping cut ones
- MQTT status updates for non-existent (cut) segments are ignored
- Turning `manual_mode` off treats the strip as contiguous again, using the real measured length

---

## Scenes & Music Mode

### Light Scenes

The `scenes.light_scene` dropdown lists all available scenes for a device. Scenes are **loaded from the Cloud API** on first start (requires API key), then cached locally. Activation happens **locally via BLE-over-LAN** (ptReal protocol) — fast and without Cloud calls.

### Scene Variants

Some scenes have multiple visual variants (A, B, C, D). These appear as separate entries in the dropdown (e.g., "Aurora-A", "Aurora-B"). Each variant has its own light effect and can be selected independently.

### Scene Speed

For scenes that support speed adjustment, a `scenes.scene_speed` slider appears (0 = slowest, higher = faster). Set the speed level first, then activate or re-activate a scene — the speed is applied on the next scene activation.

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

Cloud snapshots are created in the **Govee Home app** and stored on Govee's servers. They can capture the complete device state including scenes, segments, and effects. Selecting one activates it **locally via BLE-over-LAN** (ptReal) when BLE data is available, with Cloud API as fallback.

- Requires **Cloud API key**
- Created/managed in the Govee Home app only
- Can restore any state the app can set
- Activation is fast (~100ms) when BLE packets are cached

### Local Snapshots (`snapshots.snapshot_local`)

Local snapshots are created and stored **by the adapter** on your ioBroker server. They are independent of Govee Cloud and capture the visual state that can be controlled via LAN.

**What is saved:**
- Power on/off
- Brightness
- Color (RGB)
- Color temperature (Kelvin)
- Per-segment color and brightness (for LED strips with segments)

**What is NOT saved:**
- Scenes, DIY scenes
- Music mode settings
- Gradient toggle

### Local Snapshot Workflow

**Save:** Write a name into `snapshots.snapshot_save` (e.g., "Evening Warm"). The adapter reads the current device state and saves it locally. The name appears in the `snapshot_local` dropdown.

**Restore:** Select a snapshot from the `snapshots.snapshot_local` dropdown. The adapter sends individual LAN commands for power, brightness, color/colorTemp, and per-segment colors.

**Delete:** Write the exact snapshot name into `snapshots.snapshot_delete`.

**Tip:** Local snapshots capture the full visual state including segments. For saving scene/effect configurations, use **Cloud snapshots** via the Govee Home app.

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

- Segment control requires a **Cloud API key** (segment definitions come from Cloud)
- Segments are controlled locally via BLE-over-LAN with Cloud fallback
- Make sure the device is reachable on LAN (check `info.online`)

### Local snapshot doesn't restore my scene

- Local snapshots save visual state: power, brightness, color, color temperature, and per-segment colors
- Scenes, gradient, and music mode are **not included** (these are modes, not visual state)
- Use **Cloud snapshots** (via Govee Home app) to save scene/effect configurations

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
