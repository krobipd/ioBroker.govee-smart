# Older Changes

## 0.9.0 (2026-04-09)
- Add dedicated DIY-scenes endpoint for user-created scenes
- Add music mode controls: dropdown, sensitivity slider, auto-color toggle
- Add scene library per SKU from undocumented API (78-159 scenes per device)
- Fix ready message now waits for MQTT before logging channel summary
- Fix scene library: correct endpoint path, remove unnecessary auth, preserve query parameters

## 0.8.3 (2026-04-09)
- Fix release-script blocking on manual-review plugin

## 0.8.2 (2026-04-08)
- Remove build/ from git tracking, fix .gitignore, remove redundant CHANGELOG.md

## 0.8.1 (2026-04-06)
- Fix ready message showing disconnected channels as active
- Fix network interface default selection in admin UI

## 0.8.0 (2026-04-06)
- Network interface selection for LAN discovery (multi-NIC/VLAN support)

## 0.7.0 (2026-04-06)
- Add IP address to device info (`info.ip`), auto-updated on LAN discovery
- Batch segment control documentation (format, examples, notes)

## 0.6.4 (2026-04-06)
- Fix misleading "check email/password" for non-credential Govee login errors
- MQTT login errors classified by actual Govee response (rate-limit, credential, account issue)

## 0.6.3 (2026-04-06)
- MQTT auth backoff (stop after 3 failures), error dedup, recovery logging
- Cloud connection recovery detection
- Improved error classification (OS-level error codes)

## 0.6.2 (2026-04-05)
- Comprehensive test suite expansion (78 to 175 tests)

## 0.6.1 (2026-04-05)
- Fix snapshots not appearing, prepare DIY scene dropdown

## 0.6.0 (2026-04-06)
- Batch segment control: `segments.command` state (e.g. "1-5:#ff0000:20")
- Generic capability routing (gradient_toggle, diy_scene, music_mode)
- Scene dropdown auto-reset on color/colorTemp change

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
- Fix duplicate SKU collision: LAN-only devices now use SKU with short device ID suffix
- Fix deploy workflow: add build step before npm publish

## 0.2.0 (2026-04-06)
- Device folders use Cloud device name (falls back to SKU without API key)
- Control states moved to `control/` channel
- Added `info.serial` state for device ID

## 0.1.2 (2026-04-05)
- Fix LAN discovery race condition: listen socket ready before first scan

## 0.1.1 (2026-04-05)
- Fix LAN-only devices missing control states
- Fix LAN status matching by source IP
- Request device status immediately after LAN discovery

## 0.1.0 (2026-04-05)
- Initial release
- LAN UDP discovery and control
- AWS IoT MQTT real-time status and control
- Cloud API v2 for capabilities, scenes, segments
- Automatic channel routing (LAN > MQTT > Cloud)
