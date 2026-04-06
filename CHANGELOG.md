# Changelog
## 0.4.0 (2026-04-06)
- Scenes as real dropdowns — loaded from Cloud scenes endpoint (78-237 scenes per device)
- Snapshots as dropdowns — from scenes endpoint with device capability fallback
- Scene/snapshot activation via Cloud control endpoint
- Cloud state loading for Cloud-only states (toggles, modes)
- Cloud never overwrites LAN states (power, brightness, color, colorTemperature)
- Added `info.mqttConnected` and `info.cloudConnected` global connection states
- Cleaner logging: device/group summary on startup

## 0.3.0 (2026-04-06)
- Stable device folder naming: always `sku_shortId` (e.g. `h61be_1d6f`), Cloud name in `common.name` only
- LAN-first: basic control states (power, brightness, color, colorTemperature) always from LAN defaults
- Fix MQTT login: use v2 API endpoint with required headers
- Groups (BaseGroup) separated into `groups/` folder
- Fix Cloud API unit normalization (`unit.percent` → `%`)
- Fix `info.online` race condition on startup

## 0.2.1 (2026-04-05)
- Fix duplicate SKU collision: LAN-only devices now use SKU with short device ID suffix for unique folder names
- Fix deploy workflow: add build step before npm publish

## 0.2.0 (2026-04-06)

- Device folders use Cloud device name (falls back to SKU without API key)
- Control states moved to `control/` channel for cleaner structure
- Added `info.serial` state for device ID
- Removed misleading device count from startup log

## 0.1.2 (2026-04-06)

- Fix LAN discovery race condition: listen socket ready before first scan

## 0.1.1 (2026-04-05)

- Fix LAN-only devices missing control states (power, brightness, color, colorTemperature)
- Fix LAN status matching by source IP instead of broadcasting to all devices
- Request device status immediately after LAN discovery

## 0.1.0 (2026-04-05)

- Initial release
- LAN UDP discovery and control
- AWS IoT MQTT real-time status and control
- Cloud API v2 for capabilities, scenes, segments
- Automatic channel routing (LAN > MQTT > Cloud)
