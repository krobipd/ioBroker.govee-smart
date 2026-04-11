# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Vollständige API-Recherche: Memory `research_govee.md`

## Projekt

**ioBroker Govee Smart Adapter** — Steuert Govee Smart-Home-Geräte. LAN first, MQTT für Echtzeit-Status, Cloud nur wo nötig.

- **Version:** 1.1.1 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.govee-smart
- **npm:** https://www.npmjs.com/package/iobroker.govee-smart
- **Runtime-Deps:** `@iobroker/adapter-core`, `@iobroker/types`, `mqtt`, `node-forge`

## KRITISCH: LAN-first ist unantastbar!

- **LAN-States (power, brightness, colorRgb, colorTemperature) dürfen NIE von Cloud überschrieben werden**
- State-Definitionen: LAN-fähige Geräte → immer `getDefaultLanStates()` als Basis
- State-Werte: `loadCloudStates()` filtert LAN-State-IDs für LAN-fähige Geräte
- Cloud ist NUR für: Szenen, Snapshots, Toggles, Segmente, Sensoren

## Kanal-Priorität: LAN → MQTT → Cloud

Jeder Kanal hat genau eine Rolle. Kein Overlap.

| Feature | LAN UDP (1.) | MQTT (2.) | Cloud REST (3.) |
|---------|-------------|-----------|----------------|
| Steuern (Power, Brightness, Color) | **primär** | Fallback | letzter Ausweg |
| Status anfragen | **primär** | Fallback | letzter Ausweg |
| Status Push (echtzeit) | — | **einzige Quelle** | — |
| Geräteliste + Capabilities | — | — | **einzige Quelle** |
| Szenen + Snapshots | — | — | **einzige Quelle** |
| Segmente | — | — | **einzige Quelle** |

**Nur Lights!** Keine Appliances, Sensoren, Plugs — dafür ggf. eigener Adapter. Nur Geräte mit lokaler API. Siehe [Supported devices](https://app-h5.govee.com/user-manual/wlan-guide).

## Credential-Stufen (graceful degradation)

| Eingabe | Funktionsumfang |
|---------|----------------|
| Nichts | LAN-only: Discovery, Power, Brightness, Color, Status |
| + API Key | + Geräteliste mit Namen, Capabilities, Szenen, Snapshots, Segmente |
| + Email/Passwort | + Echtzeit Status-Push via MQTT |

## Architektur

```
src/main.ts                   → Lifecycle, StateChange, Cloud State Loading, Local Snapshots (921 Zeilen)
src/lib/device-manager.ts     → Device-Map, Cloud-Loading, LAN/MQTT Status Handling (886 Zeilen)
src/lib/capability-mapper.ts  → Capability → State Definition + buildDeviceStateDefs + Quirks (785 Zeilen)
src/lib/command-router.ts     → Command Routing LAN → MQTT → Cloud + Segment Batch (718 Zeilen)
src/lib/state-manager.ts      → State CRUD + Cleanup + Channel Routing (630 Zeilen)
src/lib/govee-lan-client.ts   → LAN UDP (Discovery + Control + Status + ptReal BLE Packets) (581 Zeilen)
src/lib/govee-mqtt-client.ts  → AWS IoT MQTT (Auth + Status-Push + Control Fallback) (483 Zeilen)
src/lib/types.ts              → Interfaces + Shared Utilities (rgbToHex, hexToRgb, classifyError) (450 Zeilen)
src/lib/govee-api-client.ts   → Undocumented API (Scene/Music/DIY Libraries, SKU Features) (237 Zeilen)
src/lib/govee-cloud-client.ts → Cloud REST API v2 (Devices, Capabilities, Szenen+Snapshots, Control)
src/lib/sku-cache.ts          → Persistent SKU cache (device data, scene/music/DIY libraries)
src/lib/rate-limiter.ts       → Rate-Limits für Cloud REST Calls
src/lib/local-snapshots.ts    → Local Snapshot Store (LAN-based save/restore, JSON files)
src/lib/device-quirks.ts      → SKU-specific overrides + community quirks (external JSON)
src/lib/http-client.ts        → Shared HTTPS request (httpsRequest + HttpError)
```

## State Tree

Ordnername = immer `sku_shortid` (z.B. `h61be_1d6f`). Cloud-Name nur in `common.name`. Gruppen unter `groups/`.

```
govee-smart.0.
├── info.connection
├── info.mqttConnected
├── info.cloudConnected
├── devices.
│   └── h61be_1d6f.                  (SKU + letzte 4 Hex der Device-ID)
│       ├── info.name / .model / .serial / .online / .ip
│       ├── info.diagnostics_export   (Button: Diagnostik-JSON exportieren)
│       ├── info.diagnostics_result   (String: Diagnostik-JSON Ausgabe, read-only)
│       ├── control.power / .brightness / .colorRgb / .colorTemperature
│       ├── control.gradient_toggle   (Boolean: Gradient ein/aus)
│       ├── scenes.light_scene        (Dropdown: 78-237 Szenen, lokal via ptReal)
│       ├── scenes.diy_scene          (Dropdown: User-DIY-Szenen, lokal via ptReal)
│       ├── scenes.scene_speed        (Slider: Szenen-Geschwindigkeit)
│       ├── music.music_mode / .music_sensitivity / .music_auto_color
│       ├── snapshots.snapshot           (Dropdown: Cloud-Snapshots)
│       ├── snapshots.snapshot_local     (Dropdown: Lokale Snapshots)
│       ├── snapshots.snapshot_save      (Text: Neuen lokalen Snapshot speichern)
│       ├── snapshots.snapshot_delete    (Text: Lokalen Snapshot löschen)
│       └── segments.count / .command / .0.color / .0.brightness (dynamisch)
└── groups.
    └── basegroup_1280.              (nur info.name + info.online, kein model/serial/ip)
```

## Szenen-Architektur (WICHTIG!)

Szenen kommen vom **separaten Scenes-Endpoint** (`POST /device/scenes`), NICHT aus den Device-Capabilities!

**Response-Format:** `{payload: {capabilities: [{type, instance, parameters: {options: [{name, value}]}}]}}`

- `lightScene` Options → Szenen-Dropdown mit Index-basierter Auswahl
- `snapshot` Options → Snapshot-Dropdown (User-gespeicherte Zustände)
- Snapshots auch als Fallback aus Device-Capabilities `dynamic_scene`/`snapshot`/`parameters.options`
- **Aktivierung:** User wählt Index → `device.scenes[idx-1].value` → direkt als `capability.value` an Control-Endpoint

### Scene Library (undokumentierte API)
- **Endpoint:** `GET https://app2.govee.com/appsku/v1/light-effect-libraries?sku=<SKU>`
- **Auth:** KEINE! Nur AppVersion + User-Agent Header nötig (public endpoint)
- Liefert erweiterte Szenen-Daten inkl. `sceneCode` für ptReal BLE-over-LAN
- Geladen via `GoveeApiClient` (eigenständiger HTTP-Client, unabhängig von MQTT)
- Response: `{data: {categories: [{scenes: [{sceneName, sceneCode, sceneId, sceneParamId}]}]}}`

## Cloud REST API v2

**Base URL:** `https://openapi.api.govee.com`
**Auth:** Header `Govee-API-Key: <key>`

### Rate Limits
- 10/min/Gerät, 10.000/Tag (allgemein)
- Appliances: **100/Tag** (!)
- Rate-Limiter schützt, Cloud nur als letzter Ausweg

### Unit-Normalisierung
Cloud API liefert nicht-standard Units: `unit.percent` → `%`, `unit.kelvin` → `K`, `unit.celsius` → `°C`

## AWS IoT MQTT

### Auth-Flow (v2 Headers erforderlich!)
1. Login: `POST app2.govee.com/.../v1/login` → token + accountId + topic
   - Headers: User-Agent, clientId, appVersion, timezone, country, envId, iotVersion
2. IoT Key: `GET app2.govee.com/.../iot/key` → endpoint + P12 cert
3. Connect: Mutual TLS, Client-ID `AP/<accountId>/<uuid>`

### Topics
- Subscribe: Account-Topic → Echtzeit Status aller Geräte
- Publish: Device-Topic → Befehle (turn, brightness, colorwc)

## LAN UDP

| Funktion | Adresse | Port |
|----------|---------|------|
| Discovery | `239.255.255.250` | 4001 |
| Antworten | Client | 4002 |
| Commands | Geräte-IP | 4003 |

Nur Lights mit aktivierter LAN-Funktion in Govee Home App.

## Admin UI

Single Page, drei Sektionen:

**1. LAN (immer aktiv)** — "Geräte mit aktivierter LAN-Funktion werden automatisch gefunden"
**2. Cloud API (optional)** — API Key → "Ermöglicht Szenen, Segmente und Gerätenamen"
**3. Govee Account (optional)** — Email + Passwort → "Ermöglicht Echtzeit Status-Updates"
**4. Donation**

## Design-Prinzipien

1. **LAN first** — schnellster Kanal, Kern des Adapters, Cloud darf NIE LAN-States überschreiben
2. **MQTT für Echtzeit** — Status-Push, Steuer-Fallback
3. **Cloud nur wo nötig** — Definitionen, Szenen, Snapshots, Segmente
4. **Graceful degradation** — ohne Credentials: LAN-only funktioniert
5. **Capability-driven** — States aus API generiert, nichts hardcodiert
6. **Szenen als echte Dropdowns** — Index-basiert, value-Payload aus Cloud; nur wenn Daten vorhanden
7. **Stabile Ordner** — `sku_shortid`, Cloud-Name nur in `common.name`
8. **Gruppen-Ordner** — BaseGroup unter `groups/`, Devices unter `devices/`
9. **Nahtlos** — User merkt nicht welcher Kanal
10. **ptReal Scene Activation** — Szenen mit sceneCode aus Scene Library werden via BLE-over-LAN (ptReal) aktiviert statt Cloud; Name-Matching mit Suffix-Stripping (-A/-B)
11. **Keine null-Werte** — Alle States haben `def` in StateDefinition + werden beim Erstellen initialisiert
12. **Stale State Cleanup** — `cleanupAllChannelStates()` entfernt alte States aus allen Channels (control, scenes, music, snapshots) + leere Channels; handelt auch Migration von altem Single-Control-Layout
13. **Error-Dedup** — `classifyError()` + `lastErrorCategory` in DeviceManager; warn nur bei Kategorie-Wechsel
14. **Rate-Limited Startup** — Scene-Loading über `rateLimiter.tryExecute()` auch beim Cloud-Init
15. **Segment-Routing** — `segmentColor:N`/`segmentBrightness:N` Commands → Cloud `segment_color_setting`
16. **Shared Utilities** — `normalizeDeviceId()` + `classifyError()` in types.ts, nicht dupliziert
17. **Kein Fire-and-forget** — Alle async void-Calls haben `.catch()` Handler
18. **Scene-State Sync** — `light_scene` wird auf "0" zurückgesetzt wenn colorRgb/colorTemperature gesetzt wird
19. **Generic Capability Routing** — States mit `native.capabilityType/Instance` werden automatisch via Cloud API geroutet (toggle, dynamic_scene, etc.)
20. **Batch Segment Command** — `segments.command` State: `1-5:#ff0000:20`, `all:#00ff00`, `0,3,7::50` — max 2 API-Calls statt N×2
21. **MQTT Auth-Backoff** — Nach 3 konsekutiven Login-Fehlern Reconnect stoppen, actionable Warning
22. **Error-Dedup überall** — MQTT + Cloud: first warn, repeat debug; Recovery-Meldung bei Wiederherstellung
23. **MQTT Login-Klassifizierung** — Govee-Response wird differenziert: Credential-Fehler → Auth-Backoff, Rate-Limit/Account-Issues/Abnormal → weiter reconnecten (kein "check email/password")
24. **info.ip State** — LAN IP-Adresse pro Gerät unter `info.ip`, auto-aktualisiert bei LAN-Discovery via `onLanIpChanged` Callback
25. **Network Interface Selection** — `networkInterface` Config (IP-Selector im Admin), bindet Multicast + Listen auf gewähltes Interface; Ports fix (Govee-Protokoll)
26. **MQTT before Cloud** — MQTT wird vor Cloud initialisiert, damit Scene Library beim ersten loadFromCloud verfügbar ist
27. **Ready-Message Ordering** — `checkAllReady()` prüft MQTT+Cloud bevor Ready geloggt wird; Safety-Timeout 30s
28. **SKU Cache** — `sku-cache.ts` persistiert Device-Daten + Libraries lokal; nach erstem Start null Cloud-Calls nötig. `loadFromCache()` mergt in bereits vorhandene LAN-Geräte (Name, Capabilities, Szenen). Incomplete Cache (scenes=0 bei Lights) triggert automatisch Cloud re-fetch
29. **Local Snapshots** — `local-snapshots.ts` speichert Gerätezustand per LAN als JSON; Restore replayed einzelne LAN-Commands
30. **Device Quirks** — `device-quirks.ts` korrigiert falsche API-Daten (colorTemp-Ranges, noMqtt, brokenPlatformApi)
31. **Scene Speed Infrastructure** — `sceneLibrary` enthält `speedInfo` (supSpeed, speedIndex, config); State + Routing fertig, Byte-Manipulation pending
32. **Multi-Channel State Tree** — States aufgeteilt in 4 Channels: `control` (Basis), `scenes` (Szenen), `music` (Musik), `snapshots` (Aktionen); Routing über `def.channel` in StateDefinition, Pfad-Auflösung via `resolveStatePath()`
33. **Groups minimal** — BaseGroup hat nur `info.name` + `info.online`, kein model/serial/ip
34. **Dynamic Segments** — Segment-Anzahl aus Capability-Daten, überschüssige Segment-Channels werden gelöscht
35. **Diagnostics Export** — `info.diagnostics_export` Button pro Gerät erzeugt strukturiertes JSON (Capabilities, Szenen, Libraries, Quirks, State) für GitHub Issues
36. **Community Quirks** — `community-quirks.json` im Data-Dir (`iobroker-data/govee-smart.0/`) erlaubt User-beigetragene SKU-Korrekturen, persistent über Updates
37. **Separated Concerns (seit 1.1.0)** — CommandRouter (Routing), GoveeApiClient (undoc API), http-client (shared HTTP), capability-mapper (State-Definitionen) als eigenständige Module

## Logging-Philosophie (seit 0.9.4)

- **Startup:** `Starting with channels: LAN, Cloud, MQTT — please wait...`
- **Ready:** Summary mit Per-Device-Details (LAN IP, Kanäle, Szenen-Anzahl)
- **Keine Redundanz:** Jede Info nur einmal (im Ready-Summary)
- **debug:** Routine (LAN scan, Discovery, Cache, State-Ops) — kein "LAN scan sent", keine "Default xxx" Zeilen
- **info:** Nur Start, Verbindungen, Ready-Summary, Snapshot-Ops
- **MQTT:** Erstverbindung = info, Reconnect-Versuche = debug, Restored = info

## Tests (309)

```
test/testCapabilityMapper.ts → Capability Mapping + Cloud State Value Mapping + Quirks (40 Tests)
  - mapCapabilities: on_off, range, color, scenes, property, toggle, LAN defaults (11)
  - mapCapabilities branches: segment, dynamic_scene, music, work_mode, unknown, edge cases (10)
  - mapCloudStateValue: all types, null/undefined, unknown capability, edge cases (16)
  - applyQuirksToStates: known SKU, unknown SKU, non-colorTemp (3)
test/testDeviceManager.ts    → Device Manager + CommandRouter (75 Tests)
  - LAN discovery, IP update, MQTT status, unknown device/IP handling (7)
  - sendCommand channel routing: LAN→MQTT→Cloud fallback, ptReal scene, segment→Cloud only (9)
  - toCloudValue: power, brightness, color hex→int, scene/snapshot/diy index lookup, segments (14)
  - parseSegmentBatch: range, all, comma, brightness-only, clamp, invalid, mixed (10)
  - findCapabilityForCommand: all command types, unknown, empty capabilities (11)
  - logDedup: category tracking, warn vs debug (1+assertions)
  - handleMqttStatus edge cases: partial update, colorTemp, mqtt channel, empty state (4)
  - handleLanStatus edge cases: zero brightness, colorTemInKelvin 0 (2)
  - noMqtt quirk: H6121 skips MQTT, non-quirk uses MQTT (2)
  - DIY scene via LAN: library match, no match fallback (2)
  - colorTemperature via LAN, no channel warning (2)
  - generateDiagnostics: all data, quirks (2)
  - toCloudValue bounds checks: NaN, zero, out-of-range (5)
test/testDeviceQuirks.ts     → Device Quirks + Community Quirks (17 Tests)
  - getDeviceQuirks: known, case-insensitive, unknown, brokenPlatformApi, noMqtt, all broken, all noMqtt (7)
  - applyColorTempQuirk: override, passthrough, no range, H6022, case-insensitive (5)
  - loadCommunityQuirks: load+override, add new, missing file, corrupt JSON, case-insensitive (5)
test/testLocalSnapshots.ts   → Local Snapshots (10 Tests)
  - Create dir, empty device, save/retrieve, overwrite, multiple, delete, non-existent, per-device, corrupt, colorTemp
test/testLanClient.ts        → LAN Client BLE Packet Builder (16 Tests)
  - buildScenePackets: activation, little-endian, A3 data, XOR checksum, empty param (5)
  - buildGradientPacket: ON, OFF, checksum (3)
  - buildSegmentColorPacket: single, multiple, all, overflow, checksum (5)
  - buildMusicModePacket: Energic, Spectrum, Rolling, Rhythm, checksum (5 → overlaps)
  - buildDiyPackets: activation-only, A1 data, checksums (3)
test/testRateLimiter.ts      → Rate Limiter (9 Tests)
  - Limits, daily usage, queueing, priority sorting, stop/clear, counter tracking
test/testSkuCache.ts         → SKU Cache (12 Tests)
  - Create dir, null entry, save/load, overwrite, separate devices, same SKU, loadAll, clear, corrupt, normalized ID, libraries, null features
test/testTypes.ts            → Shared Utilities (29 Tests)
  - normalizeDeviceId: colons, lowercase, empty string (4)
  - rgbToHex: standard, padding, white (3)
  - hexToRgb: with #, without #, black, invalid (4)
  - rgbIntToHex: standard, zero, white (3)
  - classifyError: NETWORK, TIMEOUT, AUTH, RATE_LIMIT, UNKNOWN, string/non-Error, .code property (15)
test/testStateManager.ts     → State Manager (37 Tests)
  - devicePrefix: SKU+shortId, BaseGroup folder, special chars, colons (4)
  - createDeviceStates: device+info+control, native props, defaults, unit/min/max, no IP, BaseGroup no model/serial/ip (9)
  - createDeviceStates channels: scenes routing, music routing, snapshot routing, multi-channel (4)
  - resolveStatePath: control, scenes, music, snapshots, diagnostics, unknown→control (6)
  - updateDeviceState: power, multiple fields, online, undefined fields, missing object (5)
  - removeDevice: recursive delete (1)
  - cleanupDevices: remove stale, keep existing (2)
  - cleanupAllChannelStates: remove stale, remove empty channel, migrate old→new channel (3)
  - createSegmentStates: per-segment states, default 15, excess cleanup, no fields (4)
test/testPackageFiles.ts     → @iobroker/testing (57 Tests)
```

## Versionshistorie (letzte 5)

| Version | Highlights |
|---------|------------|
| 1.1.1 | CI checkout entfernt, no-floating-promises, unused devDeps entfernt, doppelter news-Eintrag gefixt |
| 1.1.0 | Diagnostics export, community quirks, R1-R8 refactoring, 309 Tests |
| 1.0.1 | Segment capability matching, segment count, clearTimeout fixes |
| 1.0.0 | Multi-channel state tree, dynamic segments, groups minimal, dead code removal |
| 0.9.6 | Scenes missing fix, MQTT account abnormal fix, ready message wait |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
