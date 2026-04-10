# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Vollständige API-Recherche: Memory `research_govee.md`

## Projekt

**ioBroker Govee Smart Adapter** — Steuert Govee Smart-Home-Geräte. LAN first, MQTT für Echtzeit-Status, Cloud nur wo nötig.

- **Version:** 0.9.6 (April 2026)
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
src/main.ts                   → Lifecycle, StateChange, Cloud State Loading, Local Snapshots
src/lib/types.ts              → Interfaces (API, Config, Capabilities, Devices, Scenes)
src/lib/govee-cloud-client.ts → Cloud REST API v2 (Devices, Capabilities, Szenen+Snapshots, Control)
src/lib/govee-mqtt-client.ts  → AWS IoT MQTT (Status-Push + Control Fallback + Scene Library)
src/lib/govee-lan-client.ts   → LAN UDP (Discovery + Control + Status + ptReal BLE Packets)
src/lib/device-manager.ts     → LAN → MQTT → Cloud Routing, Scene/Snapshot Loading, Device Quirks
src/lib/rate-limiter.ts       → Rate-Limits für Cloud REST Calls
src/lib/capability-mapper.ts  → Capability → ioBroker State Definition + Cloud State Value Mapping + Quirks
src/lib/state-manager.ts      → State CRUD + Cleanup
src/lib/local-snapshots.ts    → Local Snapshot Store (LAN-based save/restore, JSON files)
src/lib/device-quirks.ts      → SKU-specific overrides (colorTemp ranges, noMqtt, brokenPlatformApi)
src/lib/sku-cache.ts          → Persistent SKU cache (device data, scene/music/DIY libraries)
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
│       ├── control.power / .brightness / .colorRgb / .colorTemperature
│       ├── control.light_scene       (Dropdown: 78-237 Szenen, lokal via ptReal)
│       ├── control.diy_scene         (Dropdown: User-DIY-Szenen, lokal via ptReal)
│       ├── control.snapshot          (Dropdown: Cloud-Snapshots)
│       ├── control.snapshot_local    (Dropdown: Lokale Snapshots)
│       ├── control.snapshot_save     (Text: Neuen lokalen Snapshot speichern)
│       ├── control.snapshot_delete   (Text: Lokalen Snapshot löschen)
│       ├── control.scene_speed       (Slider: Szenen-Geschwindigkeit)
│       ├── control.gradient_toggle   (Boolean: Gradient ein/aus)
│       ├── control.music_mode / .music_sensitivity / .music_auto_color
│       └── segments.count / .command / .0.color / .0.brightness
└── groups.
    └── basegroup_1280.              (Govee-Gruppen)
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
- Geladen im Poll-Zyklus (MQTT-Client muss initialisiert sein wegen httpsGet-Helper)
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
**4. Einstellungen** — Poll Interval
**5. Donation**

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
12. **Stale State Cleanup** — `cleanupControlStates()` entfernt alte Control-States + leere Channels
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

## Logging-Philosophie (seit 0.9.4)

- **Startup:** `Starting with channels: LAN, Cloud, MQTT — please wait...`
- **Ready:** Summary mit Per-Device-Details (LAN IP, Kanäle, Szenen-Anzahl)
- **Keine Redundanz:** Jede Info nur einmal (im Ready-Summary)
- **debug:** Routine (LAN scan, Discovery, Cache, State-Ops) — kein "LAN scan sent", keine "Default xxx" Zeilen
- **info:** Nur Start, Verbindungen, Ready-Summary, Snapshot-Ops
- **MQTT:** Erstverbindung = info, Reconnect-Versuche = debug, Restored = info

## Tests (254)

```
test/testCapabilityMapper.ts → Capability Mapping + Cloud State Value Mapping + Quirks (40 Tests)
  - mapCapabilities: on_off, range, color, scenes, property, toggle, LAN defaults (11)
  - mapCapabilities branches: segment, dynamic_scene, music, work_mode, unknown, edge cases (10)
  - mapCloudStateValue: all types, null/undefined, unknown capability, edge cases (16)
  - applyQuirksToStates: known SKU, unknown SKU, non-colorTemp (3)
test/testDeviceManager.ts    → Device Manager (70 Tests)
  - LAN discovery, IP update, MQTT status, unknown device/IP handling (7)
  - sendCommand channel routing: LAN→MQTT→Cloud fallback, ptReal scene, segment→Cloud only (9)
  - toCloudValue: power, brightness, color hex→int, scene/snapshot/diy index lookup, segments (14)
  - parseSegmentBatch: range, all, comma, brightness-only, clamp, invalid, mixed (10)
  - findCapabilityForCommand: all command types, unknown, empty capabilities (11)
  - parseColor: hex with/without #, black, white, invalid (5)
  - logDedup: category tracking, warn vs debug (1+assertions)
  - handleMqttStatus edge cases: partial update, colorTemp, mqtt channel, empty state (4)
  - handleLanStatus edge cases: zero brightness, colorTemInKelvin 0 (2)
  - noMqtt quirk: H6121 skips MQTT, non-quirk uses MQTT (2)
  - DIY scene via LAN: library match, no match fallback (2)
  - colorTemperature via LAN, no channel warning (2)
test/testDeviceQuirks.ts     → Device Quirks (12 Tests)
  - getDeviceQuirks: known, case-insensitive, unknown, brokenPlatformApi, noMqtt, all broken, all noMqtt (7)
  - applyColorTempQuirk: override, passthrough, no range, H6022, case-insensitive (5)
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
test/testTypes.ts            → Shared Utilities (19 Tests)
  - normalizeDeviceId: colons, lowercase, empty string
  - classifyError: NETWORK, TIMEOUT, AUTH, RATE_LIMIT, UNKNOWN, string/non-Error, .code property
test/testPackageFiles.ts     → @iobroker/testing (57 Tests)
```

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
