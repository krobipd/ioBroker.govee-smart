# Older Changes
## 2.24.0 (2026-08-04)

- This version needs ioBroker Admin 8. The segment detection wizard is built for Admin 8 and no longer runs on Admin 7, so this update is not offered there.

## 2.23.1 (2026-08-04)

- Test release during the move to ioBroker Admin 8.

## 2.23.0 (2026-08-04)

- Test release during the move to ioBroker Admin 8.

## 2.22.0 (2026-07-23)

- A Govee app device group of the "same mode" type no longer appears as a phantom, uncontrollable device in the object tree.
- Seven more Govee models join the catalog, from Edison bulbs to a ceiling fan. They start as experimental — enable them in the adapter settings to try them.
- Sensors that reach the cloud through a Govee gateway now show which gateway they are connected through, instead of an empty IP field.

## 2.21.0 (2026-07-12) — stable

- The segment-detection wizard for cut LED strips now has a visual admin interface: a live map of the strip that fills in as you measure each segment and can be corrected before you apply it.

## 2.20.0 (2026-07-11)

- Channel names and the device-info labels such as Name, Model, Online and IP address now follow the ioBroker system language instead of always showing English.
- Clearer Cloud API feedback: the admin "test login" button reports the real login result, and a malformed API key now gives a plain "invalid key" message instead of a generic failure.
- Sensor-only setups are now told, both in the admin and at startup, that a Govee account login is required to receive sensor data.
- Actions that used to fail quietly now report it — the manual device-sync button surfaces errors, and commands queued behind a rate limit settle with their real success or failure.
- A network error on a manually pinned LAN interface is now raised as an actionable problem with a fix hint, instead of passing unnoticed.

## 2.19.0 (2026-07-04)

- Device log lines now consistently name devices as "name (model)" — cache maintenance, command errors and wizard messages included, no more bare model/address labels
- The credentials entry disappears from the object tree — login tokens stay saved in encrypted form, just no longer visible as an object

## 2.18.2 (2026-07-03)

- Internal refactoring. No user-facing changes.

## 2.18.1 (2026-07-03)

- Added several new Govee devices to the catalog — 4 more lamps and 3 sensors (including a CO2 monitor). They start as experimental; enable them in the adapter settings to try them.

## 2.18.0 (2026-07-03)

- Devices you removed from your Govee account (and not reachable on your local network) now disappear from the adapter after a safety delay, instead of lingering forever — deleted groups too.
- Restored colour control in groups that contain a cloud-only member — `control.color_rgb` and `control.color_temperature` had gone missing from those groups.
- The persisted MQTT credentials are no longer a visible datapoint (`info.mqttCredentials` is gone) — they moved to an internal, non-loggable store, still encrypted.
- `info.appVersionDrift` is gone — the adapter now keeps its Govee-app version current on its own, so it keeps working when Govee updates their app (no adapter update needed).

## 2.17.0 (2026-07-01)

- **Breaking:** colour datapoints renamed to snake_case — e.g. `control.colorRgb` → `control.color_rgb`, and the colour-temperature one likewise (devices + groups). Update your scripts.
- Security: the Govee Cloud API key can no longer leak into the ioBroker log — it was written in plaintext on the cloud-events connection and is now masked.
- Security: the diagnostics export (the JSON you paste into a GitHub issue) no longer contains device or gateway secrets — a gateway's secret key and push topic are now masked.
- Security: a spoofed LAN discovery reply can no longer redirect a device's commands to another IP — the device address is taken from the real network source, not the packet.
- Robustness: the Admin "Test login" button is now rate-limited, so repeated clicks can no longer trigger a burst of Govee logins that could get your account temporarily locked.
- Security: a hostile or misbehaving device on your network can no longer flood the adapter with fake device announcements and slow it down — new devices are now bounded.
- Fixed: a device you delete from your Govee account is now removed from the adapter on the next cloud refresh (e.g. after a restart), instead of lingering as a phantom device for up to two weeks.
- New: a "Manually sync devices" button (`info.manual_sync_devices`) — set it to true to sync the device list with your Govee account on demand (add new, drop deleted) without a restart.
- Fixed: multi-colour DIY scenes activated over the local network now load correctly — longer scenes could previously be corrupted and silently fail to apply.
- Fixed: after you remove a device and add it again, its info states (name, model, …) are recreated correctly instead of leaving "has no existing object" warnings until the next restart.
- Fixed: if a Govee push/cloud-events connection connects but can't subscribe (a rare server hiccup), the adapter no longer reconnects every few seconds — the retry now backs off normally.
- Fixed: the admin "Test login" button now waits for the real MQTT connection before reporting — valid Govee account credentials no longer show a false "MQTT not up, restart the adapter" message.
- Fixed: on lamps whose music modes start at zero, the first mode was unreachable and "off" was missing — the music-mode selector is fixed. **Breaking:** its numbers shift by one, adjust scripts.
- Fixed: cloud snapshots whose value is a plain number are no longer dropped from the snapshot dropdown, and an entry with an empty value no longer shows up as a phantom option.
- Fixed: clearing the preset-scene selector no longer fires a spurious empty scene command.
- Fixed: DIY scenes you create in the Govee app now show up in the DIY dropdown after a reload, instead of only on the very first load.
- Fixed: a malformed `segments.command` (e.g. `;` instead of `:`) now logs a clear warning with the expected syntax instead of being silently ignored.
- Fixed: a command to a group with no reachable members (or where every member fails) is no longer reported as successful — it warns and leaves the state un-acknowledged, like a single device.
- Fixed: setting music sensitivity or auto-color on a LAN-controlled light no longer silently appears to succeed — the adapter now makes clear only the music mode applies locally.
- Fixed: an out-of-range segment range in `segments.command` (e.g. `0-2000000000`) is now clamped to the protocol limit instead of briefly freezing the adapter while it expands the range.
- Fixed: the segment-detection wizard now leaves your light off after it finishes or is cancelled if it was off before — it no longer leaves a light on that you had switched off.
- Fixed: the segment-detection wizard now restores your strip's original per-segment gradient on finish/abort instead of flattening it to a single colour — a uniformly-coloured strip is unaffected.
- Fixed: starting the segment-detection wizard twice in quick succession can no longer open two overlapping sessions.
- Fixed: the Govee account email field no longer shows a "valid email" error when you leave it empty — LAN-only and API-key-only setups no longer see a false validation error.
- Fixed: per-segment colour and brightness now show a default value instead of reading as null in visualizations before the first change.
- Fixed: sensor readings (temperature/humidity/battery/CO₂) now default to 0 instead of null in visualizations before the first reading arrives.
- Fixed: device groups no longer expose a meaningless "verified" trust-tier datapoint (the trust tier only applies to real devices, not groups).
- Fixed: cleaner shutdown/restart — the adapter no longer opens a cloud connection or reports a stray error after it has been told to stop.
- Fixed: a broken rate-limit reply from Govee no longer causes rapid repeated retries — the adapter now waits at least 5 seconds before trying again.
- Fixed: under heavy cloud load a fresh control command (power/brightness) is no longer dropped in favour of queued scene activations.
- Fixed: a LAN light no longer loses its power and colour controls after a cloud data refresh.
- Added: device catalog entries for the H5109 Pool Thermometer and H1630 Lantern Floor Lamp (user-reported) — they are now recognised instead of logging a "not supported" warning.
- Fixed: a sensor sending fresh readings now shows `info.online = true` even when Govee's cloud wrongly reports it offline (e.g. gateway thermometers) — online is derived from data freshness.
- Fixed: temperature-only sensors no longer keep a phantom humidity datapoint stuck at 0 — a device with no humidity sensor drops it, while a real thermo-hygrometer keeps its humidity.
- Fixed: a rejected Govee API key is now always reported as "API key rejected — check Govee API key" and stops the retry loop, instead of a generic error and retrying a bad key forever.

## 2.16.2 (2026-06-16) — stable
- On hosts with multiple network interfaces, LAN device discovery now uses the selected interface for outgoing traffic, so it no longer misses devices by scanning on the wrong one.

## 2.16.1 (2026-06-11)

- Running in compact mode no longer intercepts errors from other adapters in the same process — error reporting stays correctly attributed per adapter.
- Cloud commands issued during a long rate-limit window no longer pile up without limit; stale queued calls are dropped with a single warning.
- Device info entries (name, model, IP address) no longer rewrite their timestamps on every refresh — state history stays clean.

## 2.16.0 (2026-06-09)

- Lights and appliances without a local connection can now be controlled through the Cloud and report their correct online status; devices that support local control keep using it first.
- When account verification, the Cloud API key or the Govee password needs your attention, the adapter now flags it once clearly and as an ioBroker notification instead of repeating the same error.
- Added many more supported device models to the catalog, including Curtain Lights v1 and v2, the TV Backlight 3 Pro and the DreamView T1.
- Requires ioBroker js-controller 7.2.2 or newer.

## 2.15.0 (2026-06-07)

- Added optional Sentry error reporting: crashes are sent to the developer so issues get fixed faster. Active only with ioBroker diagnostics enabled; anonymous.

## 2.14.1 (2026-06-05)

- Corrected the ioBroker role of the scene, mode and snapshot selector states (no change to how they work)

## 2.14.0 (2026-06-04)

- The segment-detection wizard and the Cloud login test now show their messages in all admin languages instead of falling back to English or German.
- For LAN-only lights, brightness, color and state are now recorded only when they actually change, keeping their history cleaner.

## 2.13.4 (2026-05-23)

- Changelog rewritten in user-centric style across all versions.

## 2.13.3 (2026-05-23)

- Internal cleanup. No user-facing changes.

## 2.13.2 (2026-05-23)

- User-modified state names are no longer overwritten on adapter restart

## 2.13.1 (2026-05-22)

- Fixed race condition where LAN control states (power, brightness, color) were missing when a cloud-known device got LAN-discovered later — previously required adapter restart (Issue #15)
- Added H607C Floor Lamp 2 to the device catalog

## 2.13.0 (2026-05-21)

- Honest LAN status at startup — shows "LAN ✗" when no lights are reachable locally, with instructions to enable the local API
- Lights without local API now fall back to cloud control instead of failing silently

## 2.12.2 (2026-05-20)

- Verified against Node.js 24. Internal cleanup.

## 2.12.1 (2026-05-19)

- Internal cleanup. No user-facing changes.

## 2.12.0 (2026-05-17)

- Removed unused datapoint left over from earlier versions.
- All info datapoint names now show in 11 languages instead of English-only.

## 2.11.1 (2026-05-16)

- Internal cleanup. No user-facing changes.

## 2.11.0 (2026-05-16)

- Security: the 2FA verification code is now stored encrypted (API key and Govee password were already encrypted in previous versions). If you had a 2FA code set, re-enter it once in the adapter settings.
- Locally saved snapshots are now included in ioBroker backups (BackItUp / `iob backup`). Existing snapshot files migrate automatically on first start.
- sendTo calls with an unknown command no longer hang in the admin — the adapter answers with a clear error.
- Ice-bucket, motion, dirt and water-tank sensors now show up correctly in vis and smart-home integrations.

## 2.10.1 (2026-05-14)

- Cleaner adapter log: each connected channel now shows ✓ or ✗ status. Cloud and network errors come as readable user-messages with a retry hint instead of raw Node internals.

## 2.10.0 (2026-05-14)

- Snapshots on Curtain Lights (H70B3), Christmas Strings (H70C5) and Outdoor Neon (H61A8) now work; matrix-light scenes too.
- Device-specific fixes can now be added without a full adapter update.

## 2.9.1 (2026-05-13)

- Issue reports now include the device's stored scene, snapshot and effect data, so device-specific problems are analysable directly from the export.
- Diagnostics now captures more data so "the adapter went silent" reports can be analysed without follow-up questions.
- Groups now have their own diagnostics export button, just like regular devices.
- Appliance and sensor values are now included in the diagnostics export.

## 2.9.0 (2026-05-13)

- `info.online` for Lights now tracks real LAN reachability (90 s window). Cloud and MQTT push no longer write it — they produced false-positive `true` during real outages.

## 2.8.4 (2026-05-12)

- Fixed a potential crash in the admin interface when viewing device properties.

## 2.8.3 (2026-05-12)

- Improved debug logging for easier issue analysis — a single debug log is now enough for a complete bug report.

## 2.8.2 (2026-05-11)

- Snapshot refresh per device now also reloads the activation data — when you re-record a snapshot in the Govee app it takes effect right away, no manual cache reset.
- Three redundant messages around optional device features are gone from the debug log.
- Commands that don't reach the device on the local network now appear as a warning instead of failing silently.

## 2.8.1 (2026-05-11)

- Info, warn and error logs are back to their normal short form. The channel-status prefix from 2.8.0 stays only in debug logs.

## 2.8.0 (2026-05-11)

- Restart no longer briefly removes and re-creates scene, music and snapshot datapoints.
- Lights without API key no longer have empty scene/snapshot dropdowns left over from earlier versions.

## 2.7.1 (2026-05-10)

- Cleaner startup log: the first line now tells you to wait for the "ready" message, and one redundant connection-info line is gone.

## 2.7.0 (2026-05-10)

- Newly created snapshots in the Govee Home app now appear in the ioBroker dropdown — both after the update and via the refresh button. Previously the cache held the old list forever.
- Refresh button is now per device under `devices.<id>.snapshots.refresh_cloud` instead of an adapter-wide button: a press hits Govee only for that one light, not for every device on your account.
- The refresh also re-fetches the Govee device list, so a brand-new snapshot from the Govee Home app is picked up even when Govee's cloud hasn't caught up to it yet.
- `info.refresh_cloud_data` is removed in favour of the per-device button above. ioBroker scripts that wrote to it need to point at `devices.<id>.snapshots.refresh_cloud` instead.

## 2.6.7 (2026-05-10)

- Cleaner ready-log: removed the device/sensor/group online-summary because it ran before the LAN scan had settled and could falsely show all lights as offline.

## 2.6.6 (2026-05-10)

- Internal refactoring. No changes for users.

## 2.6.5 (2026-05-10)

- Internal refactoring. No changes for users.

## 2.6.4 (2026-05-10)

- Internal tooling refresh. No changes for users.

## 2.6.3 (2026-05-10)

- Connection-status indicators recover on their own after a brief Govee outage instead of staying stuck until you restart the adapter.
- Restoring a snapshot on a multi-segment LED strip is fast again — a 30-segment snapshot replays in well under a second instead of about nine.
- A wrong manual pairing IP, a network blip, or a Cloud command that Govee rejects are now reported in the log instead of failing silently.
- LED segment 0 turning blue when a colour was set with a short hex value (e.g. `#FF`) is fixed — invalid colour input falls back to black.
- The segment-detection wizard restores the strip's previous look on adapter-stop, so the test pattern doesn't stay on the wall when you save the adapter settings.
- A rejected Govee API key now surfaces an actionable hint in the log so you know where to look.
- Various behind-the-scenes hardening of all four communication channels (LAN, MQTT, Cloud-events, Cloud REST) — invisible if everything was already running fine, robustness if something is unstable.

## 2.6.2 (2026-05-09)

- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names, descriptions and dropdown labels (11 languages) are unchanged. The user-visible segment-detection wizard text in the admin UI also remains localized.

## 2.6.1 (2026-05-06)

- Documentation: changelog entries (v2.5.x–v2.6.0) restored to English — a few bullets had been left in German. No code changes.

## 2.6.0 (2026-05-06)

- Multi-language: state names, descriptions and dropdown labels are now in your ioBroker system language (11 languages).

## 2.5.4 (2026-05-04)

- Internal cleanup. No user-facing changes.

## 2.5.3 (2026-05-04)

- Segment-detection wizard no longer spams warnings in the log for indices above the real strip length (Issue #8).
- Cloud-only devices right after restart no longer show a false "No channel available" warning.

## 2.5.2 (2026-05-04)

- Stops the `groups.*.info.membersUnreachable` WARN spam every 2 min — the group state stays present with an empty value when all members are reachable instead of being deleted/recreated.
- Verified H61A8 Outdoor Neon LED Strip 10m (reported by tukey42 in Issue #11).

## 2.5.1 (2026-05-04)

- Cloud rate-limit message now clearly says "rate-limited by Govee" instead of a generic error.

## 2.5.0 (2026-05-04)

- Internal refactoring. No changes for users.

## 2.4.1 (2026-05-04)

- Internal refactoring. No changes for users.

## 2.4.0 (2026-05-04)

- Internal refactoring. No changes for users.

## 2.3.1 (2026-05-04)

- Internal cleanup. No user-facing changes.

## 2.3.0 (2026-05-04)

- The adapter now warns when the bundled Govee app version gets too old — some Govee endpoints stop working with outdated client headers.

## 2.2.0 (2026-05-04)

- 2FA verification no longer triggers an adapter restart.
- Startup log now shows a clear summary of all active channels and connected devices.
- Faster HTTP calls and more reliable network handling.
- Removing a device from your Govee account now cleans up all related states properly.
- Reduced log noise for group states.

## 2.1.4 (2026-05-03)

- Online status correct again after adapter restart — lights flip to online with the first LAN scan, sensors with the first cloud poll (5 s after start instead of 2 minutes).

## 2.1.3 (2026-05-03)

- Critical fix: no more restart-loop after entering the verification code. The cached login is now stored in a state, not in the adapter config — saving the config doesn't trigger a restart anymore.
- Saving email + password in the adapter config works again. The previous loop made it look like only the "Test login" button worked.
- Honest startup messages: when MQTT really doesn't connect within the first minute, the log says why ("login rejected", "verification needed", etc.) instead of "still pending".
- Verification warning shortened. The full step-by-step instructions live in the Wiki, the log only states the action.
- "MQTT connected to AWS IoT" → "MQTT connected". "OpenAPI MQTT" → "Cloud-events" in user-facing logs.

## 2.1.2 (2026-05-02)

- The verification message no longer claims your account has 2FA when it doesn't. Govee asks for a one-time check the first time it sees this client — same dialog, but the wording matches reality now.
- Adapters upgrading from v2.1.0 had stored MQTT credentials as plain text by mistake. The corrupted leftover bytes are now cleared on first start, so the verification flow only runs once.
- New device added to the catalogue: H61D5 (LED Strip).

## 2.1.1 (2026-05-02)

- Security fix: in v2.1.0 your saved MQTT login (token + certificate) was accidentally stored unencrypted. Now actually encrypted at rest as intended.
- Diagnostics datapoints renamed from `info.diagnostics_*` to `diag.export` / `diag.result` / `diag.tier`. Old datapoints are removed on first start — adjust scripts that referenced the old names.
- The `diag.export` JSON now also shows failed Cloud calls (with status code) and recent log lines for the device, so a single JSON dump is enough for a bug report.
- 2-Factor verification warning no longer repeats on every reconnect attempt. You'll see it once when Govee actually wants a code, not every minute while the adapter retries.
- The MQTT connection is no longer dropped every few hours when the access token rotates — refreshed in the background. No more spurious 2FA warning after the adapter has been running a while.

## 2.1.0 (2026-05-01)

- Govee accounts that require email verification on login can now be used. Adapter settings have a button to request the code, plus a field to paste it.
- The MQTT login is remembered across restarts, so the verification email is not re-sent on every reboot.
- Reconnects no longer look like a brand-new login to Govee, which used to trigger a verification email even for already-verified accounts.
- `info.online` now reflects reality for sensors and appliances. Fixes thermometers (e.g. H5179) staying at offline while their values kept updating.
- New per-device datapoint shows whether your model is verified, community-reported, beta or unknown. Unknown SKUs get a one-time hint to file a diag.export.
- Scene / DIY-scene / snapshot dropdowns now appear from the first start instead of waiting for the first Cloud call to come back.
- The Refresh Cloud Data button reloads the scene / music / DIY libraries again (had been skipped since v1.10.1).
- Min js-controller `>=7.0.7`, min admin `>=7.7.22`.

## 2.0.3 (2026-04-26)

- Min js-controller `>=6.0.11`, admin `>=7.6.20` (correcting an accidental bump in 2.0.2).

## 2.0.2 (2026-04-26)

- Sensor and appliance events (lack-of-water, ice-bucket-full, etc.) now arrive reliably across reconnects. Govee used to treat each reconnect as a new connection and drop the subscription.
- Min js-controller `>=7.0.23`.

## 2.0.1 (2026-04-26)

- Sensor values and events now land under `sensor/` and `events/` (were both under `control/` in v2.0.0). Removes `no existing object` warnings in the log on first start.
- Snapshots and scenes only attach to lights now — thermometers, heaters and kettles no longer get `snapshot_local` / `snapshot_save` / `snapshot_delete`.
- The `N experimental device(s) detected` boot-time log line is gone. The hint now fires once per lifetime per SKU, only when that SKU actually shows up.
- Less info-level log noise on startup (the routine `OpenAPI MQTT connected` line was removed; recovery messages stay).

## 2.0.0 (2026-04-26)

- Major release — Govee appliances and sensors (thermometers like H5179, heaters, kettles, ice makers) are now handled here alongside lights.
- The standalone `iobroker.govee-appliances` adapter is deprecated and rolls into here. Install govee-smart 2.0.0+ and uninstall govee-appliances when convenient.
- New **"Enable experimental device support"** checkbox in the adapter config — applies known per-model corrections to devices that are catalogued but not yet confirmed by a tester.
- New state `info.openapiMqttConnected` showing whether the push channel for sensor / appliance events is up; `info.mqttConnected` keeps tracking the channel used for lights.

## 1.11.0 (2026-04-25)

- Scene / DIY-scene / snapshot / music-mode dropdowns now accept the entry name (case-insensitive) as well as the numeric index. No more type-mismatch warning when scripts write a number.
- Duplicate scene names from the cloud are auto-disambiguated with `" (2)"`, `" (3)"` suffixes; reverse-lookup is deterministic.
- The adapter acks back the canonical key after activation, so the dropdown stays in sync regardless of how the value was written.

## 1.10.1 (2026-04-20)

- Refresh-Cloud-Data button is now much faster (about 2 calls per device instead of ~7) — the static library endpoints often returned 403 anyway and only produced rate-limiter backlogs.

## 1.10.0 (2026-04-20)

- Multi-packet A3 BLE scenes (`scenceParam`) are now activated via Cloud on devices without segments; bulbs and Curtain Lights silently dropped those packets before, so complex scenes never played.
- Powering a device off resets every mode dropdown to `"---"` — both ioBroker and Govee-app initiated off events.

## 1.9.1 (2026-04-20)

- Fix: existing snapshots were sometimes wiped from the dropdown after a Cloud refresh — the Govee API occasionally returns scenes but zero snapshots, the cleanup now keeps the last-known-good list.

## 1.9.0 (2026-04-20)

- **BREAKING** — `snapshots.snapshot` renamed to `snapshots.snapshot_cloud` (clearer alongside the local-snapshot states). Update scripts and VIS widgets; the old state is removed on first start.
- Scenes and snapshots are re-fetched from the Cloud on every adapter start. A stale `scenesChecked` flag could hide new Govee-app snapshots until the cache was wiped.
- New `info.refresh_cloud_data` button to trigger the same fresh fetch without restarting the adapter.
- All four snapshot states carry a `common.desc` so the object browser distinguishes Govee-app from ioBroker snapshots.

## 1.8.0 (2026-04-20)

- Faster state updates on large device lists.
- Rate-limiter daily reset aligned to UTC midnight so the budget resets with Govee's clock.
- Local snapshots survive unexpected adapter stops.
- Fresh installs with many devices no longer overwhelm Govee's servers.
- Wizard text fully localised (EN/DE) following system language, English fallback for others.
- govee-appliances coexistence detection covers all instances, not just the first.

## 1.7.8 (2026-04-19)

- MQTT connection stays stable after reconnect.
- LAN polling skipped when MQTT push is active (less network traffic).
- Improved stability and cleanup on adapter stop.

## 1.7.7 (2026-04-19)

- Wizard result and MQTT-learned segment count lost on every restart — cache load now merges segment fields into LAN-discovered devices.
- Cache writes use `fsync` to survive SIGKILL during adapter stop.

## 1.7.6 (2026-04-19)

- Invalid manual segment list no longer bounces the rejected value back.
- Wizard translations in 9 admin languages completed and corrected.
- Internal cleanup.

## 1.7.5 (2026-04-19)

- Wiki link in adapter settings — Markdown in staticText wasn't rendered, replaced with two staticLink buttons (DE + EN).

## 1.7.4 (2026-04-19)

- Language-aware Wiki link at the top of the main configuration tab.

## 1.7.3 (2026-04-19)

- Internal cleanup. No user-facing changes.

## 1.7.2 (2026-04-19)

- Internal cleanup. No user-facing changes.

## 1.7.1 (2026-04-19)

- Segment commands force color mode before sending — previously silently ignored in Scene/Gradient/Music mode.
- Side effect: automatic segment-count learning once you touch any segment control.

## 1.7.0 (2026-04-19)

- Reliable segment count via single source of truth (cache → MQTT-learned → min of Cloud-advertised), persists across restarts.
- Wizard redesigned — three buttons (visible/dark/end-of-strip), measures real length up to protocol limit 55, detects gaps for cut strips.
- Wizard forces color mode before each flash so the flash isn't ignored in Scene/Gradient/Music mode.
- Cut-strip settings (`manual_mode`, `manual_list`) are part of the SKU cache and survive restarts.
- Cloud-internal contradictions resolved conservatively — take the smaller value, let MQTT correct upwards.

## 1.6.7 (2026-04-19)

- Race when MQTT reveals more segments than Cloud — the discovery push skips the segment-state sync so new datapoints are created first; the next AA A5 push populates the tree.

## 1.6.6 (2026-04-19)

- Under-reported segment count — adapter now learns the real count from the device and rebuilds the state tree (fixes 20 m strips where Govee reports 15).
- Wizard flash covers the full strip so under-reported strips leave no residual lit segments.
- Manual segment list accepts indices up to 55, not just the cloud-reported count.

## 1.6.5 (2026-04-19)

- Wizard flash is more reliable — packets are no longer dropped under load.
- Wizard switches the strip ON at full brightness before the first flash; original state is restored on abort or finish.
- New live progress status during wizard operation.

## 1.6.4 (2026-04-18)

- Wizard dropdown now shows only online devices. Persistent status box with clear Yes/No guidance.
- Wizard status updates correctly when switching devices.

## 1.6.3 (2026-04-18)

- Fixed crash on Segment Detection Wizard start (restart-loop from v1.6.2).
- Improved stability — unexpected data from Govee no longer crashes the adapter.

## 1.6.2 (2026-04-18)

- Fixed Segment Detection Wizard layout on mobile screens.

## 1.6.1 (2026-04-18)

- Fixed Segment Detection Wizard buttons and LED strip dropdown in the admin UI.

## 1.6.0 (2026-04-18)

- Manual segment override for cut LED strips — declare existing indices via `segments.manual_mode` + `segments.manual_list` (ranges, gaps).
- Segment Detection Wizard in admin UI — flashes each segment, user confirms visibility, writes result as `manual_list`.
- Cloud connection now retries after rate-limits and temporary outages. Wrong credentials stop permanently.
- Old cached devices (>14 days without use) are automatically cleaned up.
- Startup waits longer for slow connections (60s instead of 30s).
- MQTT connection status now updates correctly on disconnect.

## 1.5.2 (2026-04-17)

- Improved stability against unexpected Govee API responses.

## 1.5.1 (2026-04-15)

- Scenes now load correctly for all devices (was broken by a type mismatch).
- API rate-limit shared with other Govee adapters on the same account.
- Non-light device types (heaters, fans, sensors) are filtered — this adapter handles lights only.

## 1.5.0 (2026-04-14)

- Segments now controlled locally (~100 ms) instead of via Cloud (5-10 s).
- Scene variants — all light effects per scene (A/B/C/D) instead of only the first variant.
- Snapshots now activated locally instead of via Cloud.
- Scene speed control via slider for supported scenes.
- Per-segment color and brightness in local snapshots — full visual state without Cloud.

## 1.4.1 (2026-04-13)

- Group members now load correctly (was returning empty).
- Clearer log messages when group membership data is unavailable.

## 1.4.0 (2026-04-13)

- Group handling redesigned — fan-out commands to member devices via LAN/ptReal instead of Cloud-only power toggle.
- Group capabilities computed as intersection of member devices (power, brightness, color, scenes, music).
- New `info.members` state with group member device IDs.
- New dynamic `info.membersUnreachable` state (only created when unreachable members exist).
- Snapshots and diagnostics removed from groups (not applicable to virtual devices).
- Updated to current Govee app version headers.

## 1.3.0 (2026-04-12)

- Per-segment brightness and color now update in real-time.
- Non-functional scene speed slider removed.

## 1.2.0 (2026-04-12)

- Segment color commands now work correctly.
- Switching between scene/music/snapshot/color mode now resets the other dropdowns.
- Group online state simplified to a single indicator.

## 1.1.2 (2026-04-12)

- Internal cleanup. No user-facing changes.

## 1.1.1 (2026-04-12)

- **BREAKING** — diagnostics states moved from snapshots to the info channel.
- Device corrections now survive adapter updates.
- Diagnostics export documented in README.

## 1.1.0 (2026-04-11)

- Diagnostics export per device — structured JSON for GitHub issue submission.
- Community device corrections database for user-contributed model fixes.
- Fixed crash on invalid scene/snapshot selection.

## 1.0.1 (2026-04-11)

- Segment color and brightness commands now work correctly for all strip models.
- Improved adapter shutdown handling.

## 1.0.0 (2026-04-11)

- **BREAKING** — state tree reorganized into separate channels: control, scenes, music, snapshots.
- **BREAKING** — pollInterval setting removed (cloud polling was replaced by push in 0.9.3).
- Dynamic segment count from device capabilities, excess segments cleaned up on startup.
- Groups show name and online status.

## 0.9.6 (2026-04-11)

- Scenes missing for most devices due to incomplete cache from rate-limited Cloud fetch.
- MQTT "account abnormal" incorrectly treated as wrong credentials (now keeps reconnecting instead of stopping).
- Ready message waits for LAN scan and state creation before logging.
- Per-device detail lines removed from ready summary (redundant with state tree).
- Scenes filled from scene library when Cloud scenes are missing (ptReal fallback).

## 0.9.5 (2026-04-11)

- Device names not updating from cache when LAN discovery runs first.

## 0.9.4 (2026-04-11)

- Startup and ready logging improved — clear channel summary, per-device details with LAN IPs and scene counts.
- Excessive debug noise removed — default value checks, periodic LAN scan messages.
- MQTT first-connect promoted to info level for better visibility.

## 0.9.3 (2026-04-09)

- Local snapshots — save/restore device state via LAN without Cloud.
- Device quirks system — correct wrong API data for specific SKUs.
- Scene speed control infrastructure (speed adjustment pending live testing).
- 254 tests.

## 0.9.2 (2026-04-09)

- SKU cache — device data persisted locally, zero Cloud calls after first start.
- Periodic Cloud polling removed (was every 60 s).
- Authenticated endpoint support for music/DIY libraries and SKU feature flags.
- MQTT login classification for account-blocked scenarios.

## 0.9.1 (2026-04-09)

- ptReal BLE-over-LAN scene activation — local scenes without Cloud API.
- Initialization order — MQTT before Cloud for scene library on first cycle.
- Ready message only appears after all channels are fully initialized.

## 0.9.0 (2026-04-09)

- Dedicated DIY-scenes endpoint for user-created scenes.
- Music mode controls — dropdown, sensitivity slider, auto-color toggle.
- Scene library per SKU from undocumented API (78-159 scenes per device).
- Ready message waits for MQTT before logging channel summary.
- Scene library — correct endpoint path, no auth required, query parameters preserved.

## 0.8.3 (2026-04-09)

- Internal release-script fix. No user-facing changes.

## 0.8.2 (2026-04-08)

- Internal cleanup. No user-facing changes.

## 0.8.1 (2026-04-06)

- Ready message no longer shows disconnected channels as active.
- Network interface default selection in admin UI fixed.

## 0.8.0 (2026-04-06)

- Network interface selection for LAN discovery (multi-NIC / VLAN support).

## 0.7.0 (2026-04-06)

- IP address per device under `info.ip`, auto-updated on LAN discovery.
- Batch segment control documentation (format, examples, notes).

## 0.6.4 (2026-04-06)

- Misleading "check email/password" for non-credential Govee login errors fixed.
- MQTT login errors classified by actual Govee response (rate-limit, credential, account issue).

## 0.6.3 (2026-04-06)

- MQTT connection stops retrying after 3 credential failures instead of looping forever.
- Cloud connection recovery now detected and logged.
- Clearer error messages for network and connection problems.

## 0.6.2 (2026-04-05)

- Internal cleanup. No user-facing changes.

## 0.6.1 (2026-04-05)

- Snapshots not appearing fixed; DIY scene dropdown prepared.

## 0.6.0 (2026-04-06)

- Batch segment control via `segments.command` state (e.g. `"1-5:#ff0000:20"`).
- Generic capability routing — `gradient_toggle`, `diy_scene`, `music_mode`.
- Scene dropdown auto-reset on color/colorTemp change.

## 0.5.0 (2026-04-06)

- Segment control commands now work via Cloud.
- Scenes and snapshots refresh on each startup.
- Startup "ready" message only appears after all channels are connected.

## 0.4.1 (2026-04-06)

- Null state values — sensible defaults for all control states.
- Stale control states removed on startup.
- `light_scene` / `snapshot` states only created when data is available.

## 0.4.0 (2026-04-06)

- Scenes and snapshots as real dropdowns (78-237 scenes per device).
- Cloud state loading for Cloud-only states.
- Cloud never overwrites LAN states.
- New `info.mqttConnected` and `info.cloudConnected`.
- Cleaner logging with device/group summary.

## 0.3.0 (2026-04-06)

- Stable device folder naming (`sku_shortId`), LAN-first controls.
- MQTT login v2, groups folder, Cloud unit normalization.

## 0.2.1 (2026-04-06)

- Fixed duplicate device names — LAN-only devices now use a unique suffix.

## 0.2.0 (2026-04-06)

- Device folders use Cloud device name (falls back to SKU without API key).
- Control states moved to `control/` channel.
- New `info.serial` state with device ID.

## 0.1.2 (2026-04-05)

- LAN discovery race condition — listen socket ready before first scan.

## 0.1.1 (2026-04-05)

- LAN-only devices missing control states.
- LAN status matching by source IP.
- Device status requested immediately after LAN discovery.

## 0.1.0 (2026-04-05)

- Initial release.
- LAN UDP discovery and control.
- AWS IoT MQTT real-time status and control.
- Cloud API v2 for capabilities, scenes, segments.
- Automatic channel routing (LAN > MQTT > Cloud).
