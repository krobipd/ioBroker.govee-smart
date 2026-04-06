# Older Changes

## 0.5.0 (2026-04-06)
- Fix segment control commands (now routed via Cloud API)
- Rate-limited Cloud startup, error dedup logging
- Scene/snapshot refresh on each Cloud poll
- Startup "ready" message only after all channels initialized

## 0.4.1 (2026-04-06)
- Fix null state values: sensible defaults for all control states
- Remove stale control states on startup
- Only create light_scene/snapshot states when data available

## 0.4.0 (2026-04-06)
- Scenes and snapshots as real dropdowns (78-237 scenes per device)
- Cloud state loading for Cloud-only states
- Cloud never overwrites LAN states
- Added `info.mqttConnected` and `info.cloudConnected`
- Cleaner logging with device/group summary

## 0.3.0 (2026-04-06)
- Stable device folder naming (`sku_shortId`), LAN-first controls
- Fix MQTT login v2, groups folder, Cloud unit normalization

## 0.2.1 (2026-04-06)
- Fix duplicate SKU collision: LAN-only devices now use SKU with short device ID suffix for unique folder names
- Fix deploy workflow: add build step before npm publish

## 0.2.0 (2026-04-06)

- Device folders use Cloud device name (falls back to SKU without API key)
- Control states moved to `control/` channel for cleaner structure
- Added `info.serial` state for device ID
- Removed misleading device count from startup log

## 0.1.2 (2026-04-05)

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
