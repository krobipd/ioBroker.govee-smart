# Older Changes

## 1.7.2 (2026-04-19)
- Test infrastructure aligned with ioBroker standard — plain-JS package.js + integration.js

## 1.7.1 (2026-04-19)
- Segment commands force color mode before sending — previously silently ignored in Scene/Gradient/Music mode
- Side effect: automatic segment-count learning once you touch any segment control

## 1.7.0 (2026-04-19)
- Reliable segment count via single source of truth — cache → MQTT-learned → min of Cloud-advertised, persists across restarts
- Wizard redesign — three buttons (visible / dark / end-of-strip), measures real length up to Govee protocol limit 55, detects gaps automatically for cut strips
- Wizard forces color mode before each flash so the white flash isn't silently ignored in Scene/Gradient/Music mode
- Cut-strip settings (`manual_mode` + `manual_list`) are now part of the SKU cache, survive restarts
- Cloud-internal contradictions resolved conservatively — take the smaller value, let MQTT correct upwards

## 1.6.7 (2026-04-19)
- Fix race when MQTT reveals more segments than Cloud — the discovery push skips the segment-state sync so the new datapoints get created first (no more "State has no existing object" warnings). The next AA A5 push seconds later populates the fully-built tree.

## 1.6.6 (2026-04-19)
- Fix under-reporting of segment count — when Govee Cloud advertises fewer segments than the strip physically has, MQTT `AA A5` packets reveal the real count, and the adapter now bumps `segmentCount` and rebuilds the state tree so datapoints appear for ALL segments (fixes 20 m strips where Cloud says 15 but physical is 20)
- `parseMqttSegmentData` no longer caps output at Cloud's segmentCount; trailing all-zero padding slots are stripped so packet-padding is not mistaken for real segments
- Wizard's flash dims segments 0-55 (Govee bitmask maximum) rather than only up to Cloud segmentCount, so under-reported strips cannot leave any residual lit segments during the wizard
- `manual_list` validation accepts indices up to 55 instead of the Cloud-reported count, so users can declare more physical segments than the Cloud knows about

## 1.6.5 (2026-04-19)
- Fix wizard flash — all three BLE packets (others-dim + target-color + target-brightness) are now bundled into one `ptReal` UDP datagram. Previously separate datagrams were dropped by the device under back-pressure, leading to "only some segments went dark" symptoms
- Wizard now switches the strip ON and sets global brightness to 100 before the first flash, so the selected segment is visible regardless of the previous dim state (baseline is still captured and restored on abort/finish)
- Live status box — new `info.wizardStatus` state, written on every wizard step; admin panel uses `type: "state"` to show the current segment, the total and the next action live (Admin 7.1+)

## 1.6.4 (2026-04-18)
- Wizard UX rewrite — dropdown now shows only online devices, a persistent status box indicates which segment is currently being checked, and each button click triggers a multi-line info toast with clear Yes/No guidance
- Status box uses `textSendTo` (refreshes when the device is re-selected); button responses use the `message` field so admin shows info toasts correctly (previously silent because of wrong field name)

## 1.6.3 (2026-04-18)
- Fix Segment Detection Wizard crash on Start — `parseSegmentBatch` now guards against non-string values; `flashSegment` routing accepts parsed objects directly (the `cmd.split is not a function` crash that produced the v1.6.2 restart loop)
- Harden all async event handlers against unhandled rejections — `ready`/`stateChange`/`onMessage` now route errors via `.catch`; prevents SIGKILL-code-6 restart loops
- Harden Cloud/API/MQTT/LAN boundary types — `Array.isArray` + `typeof` guards added across every external-data iteration, `rgbToHex` NaN/clamp, `hexToRgb` non-string safe, snapshot file path safe against non-string deviceId
- Refactor segment-wizard and cloud-retry-loop into dedicated testable modules
- 511 tests (was 427)

## 1.6.2 (2026-04-18)
- Fix jsonConfig schema warnings for Segment Detection Wizard — removed unsupported `button` property, aligned variant/color to admin schema (`primary`/`secondary`, `contained`/`outlined`), set `xs=12` for mobile layout

## 1.6.1 (2026-04-18)
- Fix Segment Detection Wizard in admin UI — jsonConfig button type was `"sendto"` (lowercase) instead of `"sendTo"` causing validation errors
- Fix LED strip dropdown showed as free-text input because `selectSendTo` expects the array directly, not wrapped in `{list: ...}`

## 1.6.0 (2026-04-18)
- Add manual segment override for cut LED strips — declare which segment indices actually exist via `segments.manual_mode` + `segments.manual_list` (supports ranges like `"0-9"` or gaps like `"0-8,10-14"`)
- Add Segment Detection Wizard in admin UI — flashes each segment bright white one-by-one and records which indices the user confirms visible, writes result as `manual_list`
- Add Cloud-Retry-Loop with Rate-Limit handling — 429 responses honour `Retry-After`, auth-failures stop permanently, transient errors retry after 5 min
- Add SKU-cache pruning — 14-day aging + `scenesChecked` flag + hard-filter of stale Cloud entries without capabilities
- Extend startup grace period for MQTT+Cloud from 30s to 60s — covers normal MQTT reconnect-attempt timing
- Fix `info.mqttConnected` state not updating on disconnect
- 427 tests (was 399)

## 1.5.2 (2026-04-17)
- Harden all Cloud API boundaries against schema drift — `typeof`/`Array.isArray` guards and string coercion on every external field access (sku, device, capabilities, parameters, type, instance)
- Type `CloudCapability.parameters` is now optional — API may omit it even when docs require it
- `normalizeDeviceId` and cache file naming safe against non-string input
- 45 new regression tests covering API drift scenarios (399 tests total)

## 1.5.1 (2026-04-15)
- Fix device type matching — scenes only loaded via fallback because type comparison never matched Cloud API format
- Add dynamic API rate limit sharing with other Govee adapters on the same account
- Filter non-light device types (heaters, fans, sensors etc.) — this adapter handles lights only
- 354 tests (was 352)

## 1.5.0 (2026-04-14)
- Add local segment control via BLE-over-LAN (ptReal) — segments now controlled locally (~100ms) instead of Cloud (5-10s)
- Add scene variants — all light effects per scene (A/B/C/D) instead of only the first variant
- Add local snapshot activation via ptReal BLE packets — Cloud snapshots now activated locally
- Add scene speed control — adjust playback speed for supported scenes via slider
- Add per-segment color and brightness to local snapshots — full visual state capture without Cloud
- 352 tests (was 327)

## 1.4.1 (2026-04-13)
- Fix group member resolution returning empty (API field name mismatch: `gId`/`name` vs `groupId`/`groupName`)
- Add bearer token pre-check with descriptive log message for group membership loading
- Add debug logging when group membership API returns no data

## 1.4.0 (2026-04-13)
- Redesign group handling: fan-out commands to member devices via LAN/ptReal instead of Cloud-only power toggle
- Group capabilities computed as intersection of member devices (power, brightness, color, scenes, music)
- Add `info.members` state showing group member device IDs
- Add dynamic `info.membersUnreachable` state (only created when unreachable members exist)
- Remove snapshots and diagnostics from groups (not applicable to virtual devices)
- Update undocumented API headers to match current Govee app version (7.3.30)
- 327 tests (was 314)

## 1.3.0 (2026-04-12)
- Add MQTT segment state sync — per-segment brightness and color updated in real-time via MQTT BLE notifications
- Remove non-functional scene speed slider (byte layout unknown, no project worldwide implements this)
- Remove dead code: unused types, methods, and write-only fields (comprehensive audit, 8 findings)

## 1.2.0 (2026-04-12)
- Fix segment color commands not working (ptReal accepted but not rendered) — rerouted via Cloud API
- Fix dropdown states not resetting on mode switch (scene/music/snapshot/color changes now reset all other dropdowns)
- Replace individual group online states with single `groups.info.online` reflecting Cloud connection status
- Add channel annotations to state tree documentation
- Add acknowledgments for govee2mqtt project

## 1.1.2 (2026-04-12)
- Remove dead MQTT command code (MQTT is status-push only, never sent commands)
- Remove `noMqtt` device quirk (no longer needed without MQTT commands)
- Remove dead `CloudApiError` re-export
- Replace inline hex parsing with shared `hexToRgb()` utility
- Simplify LAN fallback to Cloud-only (was LAN → MQTT → Cloud)

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
