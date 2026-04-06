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

Control [Govee](https://www.govee.com/) smart lights (H6xxx/H7xxx series) via three seamless channels: **LAN** (fastest, primary), **AWS IoT MQTT** (real-time status push), and **Cloud API v2** (scenes, segments, capabilities).

---

## Features

- **LAN First** — UDP multicast discovery and control for lowest latency
- **Real-Time Status** — AWS IoT MQTT push updates (no polling)
- **Scene Control** — Dropdown select with all available scenes from Cloud API
- **Segment Control** — Per-segment color and brightness for LED strips
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

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 4001 | UDP | Outbound (multicast 239.255.255.250) | LAN device discovery |
| 4002 | UDP | Inbound | LAN device responses |
| 4003 | UDP | Outbound | LAN device commands |

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
| **API Key** | Govee Cloud API key (optional) | — |
| **Email** | Govee account email (optional) | — |
| **Password** | Govee account password (optional) | — |
| **Poll Interval** | Cloud device list refresh interval | 60s |

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
│       │   └── online          — Device reachable (boolean)
│       ├── control/
│       │   ├── power           — On/Off (boolean, writable)
│       │   ├── brightness      — Brightness 0-100% (number, writable)
│       │   ├── colorRgb        — Color as "#RRGGBB" (string, writable)
│       │   ├── colorTemperature — Color temperature in Kelvin (number, writable)
│       │   ├── light_scene     — Light scene (string, dropdown, writable)
│       │   └── snapshot        — Saved snapshot (string, dropdown, writable)
│       └── segments/
│           ├── count           — Number of segments (number)
│           └── {0..n}/
│               ├── color       — Segment color "#RRGGBB" (string, writable)
│               └── brightness  — Segment brightness 0-100% (number, writable)
└── groups/
    └── basegroup_1280/         — Govee device groups
        ├── info/ ...
        └── control/ ...
```

---

## Troubleshooting

### No devices discovered

- Ensure your Govee lights are connected to the **same network** as ioBroker
- Check that UDP multicast (239.255.255.250) is not blocked by your router/firewall
- Only devices with **LAN API support** are discovered (primarily H6xxx/H7xxx lights)
- Verify your lights have the latest firmware via the Govee Home app

### Scenes/segments not available

- An **API Key** is required for scene and segment control
- Scenes are loaded from the Cloud API — check the API key is valid

### Status updates are delayed

- Without MQTT credentials, status is only updated via LAN responses and cloud polling
- Add your **Govee email and password** for real-time MQTT status push

### MQTT connection fails

- MQTT uses the same credentials as the Govee Home app
- If you use social login (Google/Apple), create a password in the Govee app first
- Check adapter logs for authentication errors

---

## Changelog

### 0.5.0 (2026-04-06)
- Fix segment control commands (now routed via Cloud API)
- Rate-limited Cloud startup, error dedup logging
- Scene/snapshot refresh on each Cloud poll
- Startup "ready" message only after all channels initialized

### 0.4.1 (2026-04-06)
- Fix null state values: sensible defaults for all control states
- Remove stale control states on startup
- Only create light_scene/snapshot states when data available

### 0.4.0 (2026-04-06)
- Scenes and snapshots as real dropdowns (78-237 scenes per device)
- Cloud state loading for Cloud-only states
- Cloud never overwrites LAN states
- Added `info.mqttConnected` and `info.cloudConnected`
- Cleaner logging with device/group summary

### 0.3.0 (2026-04-06)
- Stable device folder naming (`sku_shortId`), LAN-first controls
- Fix MQTT login v2, groups folder, Cloud unit normalization

### 0.2.1 (2026-04-05)
- Fix duplicate SKU collision, fix deploy workflow

### 0.2.0 (2026-04-06)
- Control states in `control/` channel, `info.serial` state

[Older changelog entries](CHANGELOG_OLD.md)

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
