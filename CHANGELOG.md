# Changelog
## 0.8.0 (2026-04-06)
- Network interface selection for LAN discovery (multi-NIC/VLAN support)
- Ports documented as non-configurable (fixed by Govee LAN protocol)

## 0.7.0 (2026-04-06)
- Add IP address to device info (`info.ip`), auto-updated on LAN discovery
- Batch segment control documentation in README (format, examples, notes)

## 0.6.4 (2026-04-06)
- Fix misleading "check email/password" error when Govee rejects login for non-credential reasons (e.g. "account abnormal")
- MQTT login errors now classified by actual Govee response: rate-limit, credential, or account issue
- Only credential errors trigger auth-backoff; account issues and rate-limits keep reconnecting

## 0.6.3 (2026-04-06)
- MQTT auth backoff: stop reconnecting after 3 consecutive login failures with actionable warning
- MQTT error dedup: first error warns, repeated same category silent (debug)
- MQTT/Cloud recovery logging: "connection restored" info message when coming back online
- Improved error classification: detect OS-level error codes (EHOSTUNREACH, EAI_AGAIN, ETIMEDOUT)

## 0.6.2 (2026-04-06)
- Comprehensive test suite: 78 → 175 tests covering command routing, value conversions, segment batch parsing, capability matching, cloud state mapping, error classification

## 0.6.1 (2026-04-06)
- Fix snapshots not appearing: values are integers from device capabilities, not objects from scenes endpoint
- Snapshot dropdowns now show on all devices with saved snapshots (e.g. "Snap1", "Snap2")
- DIY scene support prepared (API currently returns no options — app-only feature)
- Scene dropdown reset now also clears diy_scene and snapshot on color/colorTemp change

## 0.6.0 (2026-04-06)
- Batch segment control: new `segments.command` state (e.g. "1-5:#ff0000:20", "all:#00ff00:50")
- Generic capability routing for toggle/dynamic_scene states (gradient_toggle, diy_scene, music_mode)
- Scene dropdown auto-reset when switching to solid color or color temperature
- Fix writable states without command routing (writes were silently ignored)

## 0.5.0 (2026-04-06)
- Fix segment control commands (were silently failing, now routed via Cloud API)
- Rate-limited Cloud startup to prevent API throttling
- Error dedup logging — only warn on category change, debug on repeat
- Scene/snapshot refresh on each Cloud poll (not only on first load)
- Startup logging: "ready" message only after all channels initialized
- Shared utilities (normalizeDeviceId, classifyError), removed code duplication
- Add .catch() to all fire-and-forget async calls
- Fix MQTT reconnect null safety, Cloud API requestId, LanStatusCallback type
- Remove stale file (javscript.txt)

## 0.4.1 (2026-04-06)
- Fix null state values: sensible defaults for all control states
- Remove stale control states on startup (e.g. leftover snapshot JSON state)
- Only create light_scene/snapshot states as dropdowns when data available
- Set info.online on device creation
- Add error handler for async state creation

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
