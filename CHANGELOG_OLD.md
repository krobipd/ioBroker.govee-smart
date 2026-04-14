# Older Changes

## 1.1.1 (2026-04-12)
- **BREAKING:** Move diagnostics states from `snapshots/` to `info/` channel (where device information belongs)
- Fix community quirks loading from persistent data directory instead of adapter directory (survives updates)
- Document diagnostics export and community quirks in README
- Remove redundant CI checkout, add `no-floating-promises` lint rule, remove unused devDependencies, fix duplicate news entry

## 1.1.0 (2026-04-11)
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

## 1.0.1 (2026-04-11)
- Fix segment capability matching: color and brightness commands now route to correct API capabilities
- Fix segment count using maximum across all segment capabilities instead of first found
- Fix hardcoded 15-segment fallback replaced with safe default
- Fix missing clearTimeout for one-shot timers in onUnload

## 1.0.0 (2026-04-11)
- **BREAKING:** Multi-channel state tree — states split into `control`, `scenes`, `music`, `snapshots` channels
- **BREAKING:** Removed `pollInterval` setting (Cloud polling was removed in 0.9.3)
- Fix incomplete cache detection bug (type check `"devices.types.light"` never matched Cloud's `"light"`)
- Remove dead code: unused methods, config fields, LanDevice version fields
- Dynamic segment count from capabilities, excess segments cleaned up on startup
- Groups minimal: BaseGroup only has `info.name` + `info.online`

## 0.9.6 (2026-04-11)
- Fix scenes missing for most devices due to incomplete cache from rate-limited Cloud fetch
- Fix MQTT "account abnormal" incorrectly treated as wrong credentials (keeps reconnecting instead of stopping)
- Ready message now waits for LAN scan and state creation before logging
- Remove per-device detail lines from ready summary (redundant with state tree)
- Fill scenes from scene library when Cloud scenes are missing (ptReal fallback)

## 0.9.5 (2026-04-11)
- Fix device names not updating from cache when LAN discovery runs first

## 0.9.4 (2026-04-11)
- Improve startup and ready logging: clear channel summary, per-device details with LAN IPs and scene counts
- Remove excessive debug noise: default value checks, periodic LAN scan messages
- Promote MQTT first-connect to info level for better visibility

## 0.9.3 (2026-04-09)
- Add local snapshots: save/restore device state via LAN without Cloud
- Add device quirks system: correct wrong API data for specific SKUs
- Add scene speed control infrastructure (speed adjustment pending live testing)
- Extend test coverage to 254 tests

## 0.9.2 (2026-04-09)
- Add SKU cache: device data persisted locally, zero Cloud calls after first start
- Remove periodic Cloud polling (was every 60s)
- Add authenticated endpoint support for music/DIY libraries and SKU feature flags
- Fix MQTT login classification for account-blocked scenarios

## 0.9.1 (2026-04-09)
- Add ptReal BLE-over-LAN scene activation (local scenes without Cloud API)
- Fix initialization order: MQTT before Cloud for scene library on first cycle
- Fix ready message only appears after all channels are fully initialized

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
