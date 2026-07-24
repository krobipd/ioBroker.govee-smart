# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Vollständige API-Recherche: `/Volumes/ssd/claude/iobroker/Ressourcen/govee-smart/` (LAN-Protokoll, MQTT AWS IoT, ptReal BLE, Scene-Speed, Segment-Detection, Snapshot-ptReal, API-Referenz, Features-Roadmap, Konkurrenz)

## Projekt

**ioBroker Govee Smart Adapter** — Steuert Govee WiFi-Geräte: Lights (LED-Strips, Lampen, Panels), Sensoren (Thermometer/Hygrometer), Appliances (Heater, Humidifier, Kettle, Ice Maker, Fan, Purifier). LAN first für Lights, App-API + OpenAPI-MQTT für Sensoren/Appliances, Cloud REST v2 für Capabilities + Steuer-Fallback.

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.govee-smart
- **npm:** https://www.npmjs.com/package/iobroker.govee-smart
- **Runtime-Deps:** `@iobroker/adapter-core`, `mqtt`, `node-forge`
- **Tests:** 1222 unit (vitest, src/lib/**/*.test.ts) + 57 package + integration, lint clean, ~83 % stmts (ehrlich via coverage.include). **Plus src-admin:** 19 vitest+jsdom (SegmentWizard/SegmentGrid/useWizardApi), `npm --prefix src-admin run test`
- **Wiki:** komplett auditiert + bilingual EN/DE (https://github.com/krobipd/ioBroker.govee-smart/wiki)

## LAN-first für Lights (harte Regel — Cloud überschreibt LAN-States nie)

- **LAN-States für Lights (power, brightness, color_rgb, color_temperature) dürfen NIE von Cloud überschrieben werden** (State-IDs snake_case seit B2; die Cloud-Capability-Instances heißen weiter `colorRgb`/`colorTemperatureK`)
- State-Definitionen: LAN-fähige Geräte → immer `getDefaultLanStates()` als Basis
- State-Werte: `loadCloudStates()` (main.ts:1340) filtert LAN-State-IDs für LAN-fähige Geräte (`if (device.lanIp && lanStateIds.has(...)) continue;`)
- `applyOnlineCap` (device-manager.ts:1490) macht Multi-Source-Online-Merge mit `lastSeenOnNetwork`-Tracking — robust gegen LAN/MQTT/Cloud-Widersprüche
- Cloud ist NUR für: Capabilities, Szenen, Snapshots, Toggles, Segmente, Sensor-Capabilities

## Kanal-Priorität pro Operation

### Lights — Steuerung

| Operation             | LAN UDP | AWS-IoT MQTT | OpenAPI-MQTT | Cloud REST | App-API |
| --------------------- | ------- | ------------ | ------------ | ---------- | ------- |
| power on/off          | primär  | —            | —            | Notfall¹   | —       |
| brightness            | primär  | —            | —            | Notfall¹   | —       |
| color_rgb             | primär  | —            | —            | Notfall¹   | —       |
| color_temperature     | primär  | —            | —            | Notfall¹   | —       |
| Segment-Color         | primär  | —            | —            | Notfall¹   | —       |
| Segment-Brightness    | primär  | —            | —            | Notfall¹   | —       |
| Segment-Batch         | primär  | —            | —            | Notfall¹   | —       |
| Music-Mode            | primär  | —            | —            | —          | —       |
| Scene-Speed           | primär  | —            | —            | —          | —       |
| Scene-Aktivierung     | primär  | —            | —            | backup     | —       |
| DIY-Scene-Aktivierung | primär  | —            | —            | backup     | —       |
| Snapshot-Aktivierung  | primär  | —            | —            | backup     | —       |
| Gradient-Toggle       | primär  | —            | —            | Notfall¹   | —       |
| Generic Capability    | —       | —            | —            | primär     | —       |

¹ **Notfall-Fallback** — nur wenn lokale API nicht aktiviert (lanIp === null). 5-10s Latenz pro Call, 10/min Rate-Limit. Adapter warnt beim Start ("LAN ✗") mit Anleitung zur LAN-Aktivierung.

### Lights — Status

| Operation                | LAN UDP | AWS-IoT MQTT | OpenAPI-MQTT | Cloud REST | App-API |
| ------------------------ | ------- | ------------ | ------------ | ---------- | ------- |
| LAN-Discovery            | primär  | —            | —            | —          | —       |
| devStatus (Unicast-Pull) | primär  | —            | —            | —          | —       |
| Status-Push              | —       | primär       | —            | —          | —       |
| Segment-State-Echo       | —       | primär       | —            | —          | —       |
| info.online              | primär  | —            | —            | —          | —       |
| info.ip                  | primär  | —            | —            | —          | —       |

### Cloud-Setup-Daten (einmaliger Import)

| Operation                  | LAN UDP | AWS-IoT MQTT | OpenAPI-MQTT | Cloud REST | App-API |
| -------------------------- | ------- | ------------ | ------------ | ---------- | ------- |
| Geräteliste + Capabilities | —       | —            | —            | primär     | —       |
| Scene-Library              | —       | —            | —            | primär     | —       |
| Snapshot-BLE-Pakete        | —       | —            | —            | primär     | —       |
| Cloud-Snapshot-Liste       | —       | —            | —            | primär     | —       |
| Group-Members              | —       | —            | —            | —          | primär  |

### Appliances + Sensoren

| Operation               | LAN UDP | AWS-IoT MQTT | OpenAPI-MQTT | Cloud REST | App-API |
| ----------------------- | ------- | ------------ | ------------ | ---------- | ------- |
| Sensor-Werte (Temp/Hum) | —       | —            | —            | —          | primär  |
| Battery                 | —       | —            | —            | —          | primär  |
| Appliance-Events        | —       | —            | primär       | —          | —       |
| Appliance-Steuerung     | —       | —            | —            | primär     | —       |
| info.online             | —       | —            | backup       | —          | primär  |

## govee-appliances ist DEPRECATED

Seit v2.0.0 (2026-04-25) gemerged in govee-smart. Repo `iobroker.govee-appliances` archiviert. Falls Code-Pfade noch von „Koexistenz" reden — das ist Legacy. APPLIANCE_TYPES filter, MQTT-ClientID-Trennung, Rate-Budget-Sharing waren v1.x. Aktuell: ein Adapter macht alles. Memory: `project_govee_appliances_deprecated`.

## Credential-Stufen (graceful degradation)

| Eingabe          | Funktionsumfang                                                    |
| ---------------- | ------------------------------------------------------------------ |
| Nichts           | LAN-only: Discovery, Power, Brightness, Color, Status              |
| + API Key        | + Geräteliste mit Namen, Capabilities, Szenen, Snapshots, Segmente |
| + Email/Passwort | + Echtzeit Status-Push via MQTT                                    |

## Architektur

```
src/main.ts                              → Lifecycle, Wiring, Field-Declarations (v2.6.5: 1159 Zeilen, war 2008)
src/lib/handlers/                        → 8 Handler-Files für main.ts (v2.6.5)
  cloud-creds-handler.ts                 → MQTT-Creds: clearVerification + load/persist (verschlüsselte Datei im Instanz-Datenverzeichnis, wie SKU-Cache; re-derivierbarer Cache → bewusst KEIN meta.user — kein sichtbarer Objektbaum-Knoten) + One-Shot-Migrationen (state v2.17.x, meta v2.18.x) + cleanupLegacy
  cloud-retry-handler.ts                 → cloudInitWithTimeout + buildCloudRetryHost + ensure + handleFailure + manualRefresh
  diagnostics-handler.ts                 → handleDiagnosticsExport (Throttle + JSON-Dump)
  group-fanout-handler.ts                → buildGroupFanoutHost + resolveGroupMembers + updateGroupReachability
  dropdown-reset-helpers.ts              → STATE_TO_COMMAND + COMMAND_DROPDOWN + MODE_DROPDOWNS + stateToCommand + reset-Helpers
  snapshot-handler-glue.ts               → buildSnapshotHost (closure-Factory)
  state-change-router.ts                 → onStateChange + sub-handlers + dropdown-resolver + sendMusicCommand + handleManualSegments
  wizard-handler.ts                      → buildWizardHost + applyWizardResult + runWizardStep + deviceKey-Helpers
src/lib/device-manager.ts                → DeviceManager-Class: Cloud-Load, MQTT-Handling, Group-Members, Cmd-Dispatch (v2.6.5: 1268 Zeilen, war 1660)
src/lib/device-manager/                  → 4 Sub-Files für device-manager (v2.6.5)
  cloud-merge.ts                         → mergeCloudDevices + applyOnlineCap (free fns mit CloudMergeAdapter)
  device-cache.ts (cache.ts)             → cachedToGoveeDevice + goveeDeviceToCached + persistDeviceToCache + saveDevicesToCache + populateScenesFromLibrary
  lookups.ts                             → MqttSegmentData + parseMqttSegmentData + getEffectiveSegmentIndices + resolveSegmentCount + SEGMENT_HARD_MAX + deviceKey + findDeviceBySkuAndId (alle pure)
  mapping.ts                             → cloudDeviceToGoveeDevice + buildCapabilitiesFromAppEntry (pure)
src/lib/segment-wizard.ts                → SegmentWizard + WizardHost — misst echte Strip-Länge, erkennt Lücken; runStep faltet Grid-snapshot ein + apply()-Finalizer (v2.21.0 React-UI)
src/lib/cloud-retry.ts                   → CloudRetryLoop + CloudRetryHost-Interface (v1.6.3 extracted for testability)
src/lib/capability-mapper.ts             → Capability → State Definition + buildDeviceStateDefs + Quirks + Scene Speed (907 Zeilen)
src/lib/command-router.ts                → Command Routing LAN → Cloud + Segment ptReal + Snapshot ptReal (677 Zeilen)
src/lib/state-manager.ts                 → State CRUD + Cleanup + Channel Routing + Groups Online + manual-state sync (v1.7.0)
src/lib/govee-lan-client.ts              → LAN UDP (Discovery + Control + Status + ptReal BLE + Segments + Speed) (711 Zeilen)
src/lib/govee-mqtt-client.ts             → AWS IoT MQTT (Auth + Status-Push, kein Command-Senden) (391 Zeilen)
src/lib/types.ts                         → Interfaces + Shared Utilities (rgbToHex, hexToRgb, classifyError) (435 Zeilen)
src/lib/govee-api-client.ts              → Undocumented API (Scene/Music/DIY Libraries, Snapshots, SKU Features) (364 Zeilen)
src/lib/govee-cloud-client.ts            → Cloud REST API v2 (Devices, Capabilities, Szenen+Snapshots, Control)
src/lib/sku-cache.ts                     → Persistent SKU cache (device data, scene/music/DIY libraries, snapshots) (145 Zeilen)
src/lib/rate-limiter.ts                  → Rate-Limits für Cloud REST Calls
src/lib/local-snapshots.ts               → Local Snapshot Store (LAN-based save/restore, JSON files)
src/lib/device-registry.ts               → SKU-specific overrides aus devices.json (status-aware: verified/reported/seed)
src/lib/diagnostics.ts                   → Ringbuffer pro Device (logs/MQTT-Pakete/API-Responses) für strukturiertes Diagnostics-JSON
src/lib/http-client.ts                   → Shared HTTPS request (httpsRequest + HttpError)
src/lib/message-router.ts                → MessageRouter (sendTo handler) — admin-jsonConfig-Befehle
src/lib/snapshot-handler.ts              → SnapshotHandler-Class für lokale Snapshots
src/lib/group-fanout.ts                  → GroupFanoutHandler-Class für Gruppen-Befehle
../scripts/sync-iopackage-from-i18n.py   → hält io-package.json:instanceObjects synchron mit admin/i18n (zentral)
src-admin/                               → Module-Federation React-Admin-Komponente (Vite, PH-Vorbild) → admin/custom/customComponents.js (gitignored, via files[]+prepublishOnly=node tasks im Tarball). SegmentWizardConfig (ConfigGeneric, MF-Mount) → SegmentWizard (3-Screen) + SegmentGrid + useWizardApi; eigene i18n (gsw_-Keys, 11 Sprachen). Build: `npm run build:admin`; Tests: `npm --prefix src-admin run test` (vitest+jsdom)
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
│       ├── control.power / .brightness / .color_rgb / .color_temperature
│       ├── control.gradient_toggle   (Boolean: Gradient ein/aus)
│       ├── scenes.light_scene        (Dropdown: Szenen vom Gerät, lokal via ptReal)
│       ├── scenes.diy_scene          (Dropdown: User-DIY-Szenen, lokal via ptReal)
│       ├── scenes.scene_speed        (Number: Speed 0-N, nur bei Szenen mit supSpeed)
│       ├── music.music_mode / .music_sensitivity / .music_auto_color
│       ├── snapshots.snapshot           (Dropdown: Cloud-Snapshots, lokal via ptReal)
│       ├── snapshots.snapshot_local     (Dropdown: Lokale Snapshots)
│       ├── snapshots.snapshot_save      (Text: Neuen lokalen Snapshot speichern)
│       ├── snapshots.snapshot_delete    (Text: Lokalen Snapshot löschen)
│       └── segments.count / .command / .0.color / .0.brightness (dynamisch)
└── groups.
    ├── info.online                  (Cloud-Verbindungsstatus, allgemein für alle Gruppen)
    └── basegroup_1311.
        ├── info.name / .members / .membersUnreachable (dynamisch)
        ├── control.power / .brightness / .color_rgb / .color_temperature (Fan-Out → LAN)
        ├── scenes.light_scene       (Fan-Out → ptReal, Name-basiertes Matching)
        └── music.music_mode         (Fan-Out → ptReal, Name-basiertes Matching)
```

## Szenen-Architektur

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

### Auth-Flow (v2-Header erforderlich)

1. Login: `POST app2.govee.com/.../v1/login` → token + accountId + topic
   - Headers: User-Agent, clientId, appVersion, timezone, country, envId, iotVersion
2. IoT Key: `GET app2.govee.com/.../iot/key` → endpoint + P12 cert
3. Connect: Mutual TLS, Client-ID `AP/<accountId>/<uuid>`

### Topics

- Subscribe: Account-Topic → Echtzeit Status aller Geräte
- Publish: Device-Topic → Befehle (turn, brightness, colorwc)

## LAN UDP

| Funktion  | Adresse           | Port |
| --------- | ----------------- | ---- |
| Discovery | `239.255.255.250` | 4001 |
| Antworten | Client            | 4002 |
| Commands  | Geräte-IP         | 4003 |

Nur Lights mit aktivierter LAN-Funktion in Govee Home App.

## Admin UI

Single Page, drei Sektionen:

**1. LAN (immer aktiv)** — "Geräte mit aktivierter LAN-Funktion werden automatisch gefunden"
**2. Cloud API (optional)** — API Key → "Ermöglicht Szenen, Segmente und Gerätenamen"
**3. Govee Account (optional)** — Email + Passwort → "Ermöglicht Echtzeit Status-Updates"
**4. Donation**

## Design-Prinzipien

1. **LAN first** — schnellster Kanal, Kern des Adapters, Cloud darf NIE LAN-States überschreiben
2. **MQTT für Echtzeit** — Status-Push only (kein Command-Sending)
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
15. **Segment-Routing** — `segmentColor:N`/`segmentBrightness:N` → LAN ptReal first (`33 05 15`), Cloud fallback; Batch-Command → multi-segment bitmask in einem Paket
16. **Shared Utilities** — `normalizeDeviceId()` + `classifyError()` in types.ts, nicht dupliziert
17. **Kein Fire-and-forget** — Alle async void-Calls haben `.catch()` Handler
18. **Dropdown-Reset** — Moduswechsel (Scene/DIY/Snapshot/Music/Color) setzt alle ANDEREN Dropdowns auf "---" (0) zurück
19. **Generic Capability Routing** — States mit `native.capabilityType/Instance` werden automatisch via Cloud API geroutet (toggle, dynamic_scene, etc.)
20. **Batch Segment Command** — `segments.command` State: `1-5:#ff0000:20`, `all:#00ff00`, `0,3,7::50` — max 2 API-Calls statt N×2
21. **MQTT Auth-Backoff** — Nach 3 konsekutiven Login-Fehlern Reconnect stoppen, actionable Warning
22. **Error-Dedup überall** — MQTT + Cloud: first warn, repeat debug; Recovery-Meldung bei Wiederherstellung
23. **MQTT Login-Klassifizierung** — Govee-Response wird differenziert: Credential-Fehler → Auth-Backoff, Rate-Limit/Account-Issues/Abnormal → weiter reconnecten (kein "check email/password")
24. **info.ip State** — LAN IP-Adresse pro Gerät unter `info.ip`, auto-aktualisiert bei LAN-Discovery via `onLanIpChanged` Callback
25. **Network Interface Selection** — `networkInterface` Config (IP-Selector im Admin), bindet Multicast + Listen auf gewähltes Interface; Ports fix (Govee-Protokoll)
26. **MQTT before Cloud** — MQTT wird vor Cloud initialisiert, damit Scene Library beim ersten loadFromCloud verfügbar ist
27. **Ready-Message Ordering** — `checkAllReady()` prüft MQTT+Cloud bevor Ready geloggt wird; Safety-Timeout **60s** (seit v1.6.0, war 30s) mit ehrlicher "noch im Aufbau"-Meldung für nicht-bereite Channels
28. **SKU Cache** — `sku-cache.ts` persistiert Device-Daten + Libraries lokal; nach erstem Start null Cloud-Calls nötig. `loadFromCache()` mergt in bereits vorhandene LAN-Geräte (Name, Capabilities, Szenen). **Seit v1.6.0:** `scenesChecked`-Flag verhindert Endlos-Refetch bei legitim leeren Scenes; `lastSeenOnNetwork`-Timestamp + `pruneStale(14)` entfernt stale Einträge; Hard-Filter bei Cloud-Load überspringt Einträge ohne capabilities
29. **Local Snapshots** — `local-snapshots.ts` speichert Gerätezustand per LAN als JSON inkl. Per-Segment Color+Brightness; Restore replayed einzelne LAN-Commands (power, brightness, color, colorTemp, segmentColor:N, segmentBrightness:N)
30. **Device Quirks (v2.10.0 „fertig")** — `device-registry.ts` lädt `devices.json` und korrigiert per-SKU. Status-aware: `seed`-Quirks greifen nur mit dem Adapter-Toggle „experimentalQuirks".

    **Drei Pattern-Familien:**
    - **Range-Override** (`colorTempRange`) — API liefert falsche Bereichs-Grenzen. Konsum: `capability-mapper.ts:applyColorTempQuirk`.
    - **Boolean-Flag** (`brokenPlatformApi`) — Verhalten an/aus pro SKU. Konsum: `capability-mapper.ts:buildCloudStateDefs` skippt Cloud-Cap-Mapping + Scene-Dropdowns + refresh_cloud-Button, fällt auf LAN-Defaults zurück.
    - **Map-Override** (`transportOverrides`) — Per-Operation-Routing-Zwang („cloud" / „lan"). Konsum: `command-router.ts:resolveTransport`. 9 base-Commands. Segment-Suffix-Commands (`segmentColor:N`/`segmentBrightness:N`) erben den `segmentBatch`-Override automatisch.

    **Nicht-Quirks:** `manualMode`/`manualSegments` (runtime user-setting für Cut-Strips), `name`/`type`/`status`/`since` (Pflichtfelder Identität+Metadaten), Per-User-Defaults (IP, brightness) → jsonConfig.

    **5-Schritt-Wiring für neue Quirks:**
    1. `DeviceQuirks`-Interface erweitern (`device-registry.ts:16`)
    2. JSON-Schema-Property in `devices.schema.json` + `additionalProperties: false` halten
    3. Konsumstelle: `const q = getDeviceQuirks(device.sku); if (q?.<feld>) ...`
    4. devices.json-Eintrag mit `since: "<version>"`
    5. Test in `device-registry.test.ts` (Lookup) + Test in Konsumstelle (Behavior)

    **Mögliche 4. Familie:** Number-Override (`forceColorModeDelayMs`, `appApiPollIntervalMs`) — hinzufügen wenn realer SKU-Bedarf auftaucht, nicht spekulativ. Architektur-Erweiterung ist additiv, kein Refactor.

31. **Scene Speed** — `sceneLibrary` enthält `speedInfo` mit `moveIn[]`-Arrays; Speed-Byte steht an Position `pageLength - 5` im scenceParam; `applySceneSpeed()` ersetzt Speed-Bytes vor dem Senden; `scenes.scene_speed` State (0-N) wird auf nächste Scene-Aktivierung angewendet
32. **Multi-Channel State Tree** — States aufgeteilt in 4 Channels: `control` (Basis), `scenes` (Szenen), `music` (Musik), `snapshots` (Aktionen); Routing über `def.channel` in StateDefinition, Pfad-Auflösung via `resolveStatePath()`
33. **Groups Fan-Out** — BaseGroup fan-out: Capabilities = Intersection der Mitgliedsgeräte; Befehle → LAN/ptReal pro Mitglied; `info.members` + dynamisches `info.membersUnreachable`; keine Snapshots/Diagnostics
34. **Dynamic Segments** — Segment-Anzahl aus Capability-Daten, überschüssige Segment-Channels werden gelöscht
35. **Diagnostics Export** — `info.diagnostics_export` Button pro Gerät erzeugt strukturiertes JSON (Capabilities, Szenen, Libraries, Quirks, State) für GitHub Issues
36. **Community Quirks** — Beiträge zu `devices.json` laufen ab v2.0 über GitHub Issues + Pull Requests (siehe CONTRIBUTING.md). Eine externe `community-quirks.json` gibt es nicht mehr
37. **Separated Concerns (seit 1.1.0)** — CommandRouter (Routing), GoveeApiClient (undoc API), http-client (shared HTTP), capability-mapper (State-Definitionen) als eigenständige Module
38. **MQTT Segment State-Sync** — `parseMqttSegmentData()` dekodiert AA A5 BLE-Pakete aus `op.command` → Per-Segment Brightness+RGB in ioBroker States; nur bei Geräten mit `segmentCount > 0`, nur bei Gradient/Color-Modus (Scene/Music liefert keine AA A5)
39. **Snapshot ptReal** — `fetchSnapshots()` holt BLE-Pakete von `/bff-app/v1/devices/snapshots`, gespeichert als `snapshotBleCmds` auf Device + SKU-Cache; Aktivierung lokal via `sendPtReal()`, Cloud-Fallback wenn keine BLE-Daten
40. **Scene Variants** — `fetchSceneLibrary()` iteriert alle `lightEffects` pro Szene (nicht nur [0]); Multi-Varianten werden als "Name-Suffix" gespeichert (z.B. "Aurora-A", "Aurora-B"); bestehende Name-Matching-Logik mit Suffix-Stripping funktioniert weiterhin
41. **Manual Segments (v1.6.0)** — `segments.manual_mode` + `segments.manual_list` pro Gerät für gekürzte LED-Strips. `parseSegmentList()` in types.ts akzeptiert `"0-9"`, `"0-8,10-14"`, Kommas, whitespace; validiert primär gegen device.segmentCount-1, Backstop 0-99. Toggle-Change triggert `handleManualSegmentsChange` in main.ts → `createSegmentStates` baut Segment-Tree neu, löscht überflüssige States. `parseSegmentBatch "all"` und `parseMqttSegmentData`-Filter honor `device.manualSegments` wenn manualMode=true
42. **Segment Detection Wizard (v1.7.0 redesign)** — jsonConfig `tabs`-Layout mit Tab "Segment-Erkennung". Der Wizard MISST die echte Strip-Länge unabhängig von Cloud (läuft bis zum Protokoll-Limit 55 oder bis User "Fertig – Strip zu Ende" klickt). Drei Action-Buttons: `yes`/`no`/`done`. `onMessage`-Handler routet `getSegmentDevices` / `segmentWizard` (start/yes/no/done/abort). In-Memory `SegmentWizardSession`, Baseline-Capture, flashSegment(idx) bright-white, 5-Min-Idle-Timeout, globaler Session-Lock. Ergebnis wird via `applyWizardResult`-Host-Callback angewendet: setzt `device.segmentCount`, setzt `manualMode` nur bei erkannten Lücken, persistiert Cache. **v2.21.0 — React-Admin-UI:** der jsonConfig-`sendTo`-Button-Tab ist durch eine eigene Module-Federation-React-Komponente ersetzt (`src-admin/`, `ConfigCustomGoveeSegmentSet/Components/SegmentWizardConfig`, jsonConfig `type:custom`+`bundlerType:module`; Vorbild `iobroker.public-holidays`). Backend **additiv**: `runStep` faltet einen Grid-`snapshot` (`{phase,total,currentIndex,confirmed}`) in JEDE Response, und ein neuer `apply(indices)`-Zweig finalisiert die im Review korrigierte Karte — **alternativer Finalizer** zu `finish` (gleiche Session-aktiv-Guards wie `done`, teilt sich `finalize()`). Flow: measure (yes/no) → „Fertig" wechselt **lokal** in Review (Session bleibt offen) → `apply` finalisiert; `done`/`finish` unverändert, vom React-Flow **nicht** mehr genutzt. `info.wizardStatus`-State + `getStatusText`/`wizardIdleText` + der Status-Mirror entfernt (React ownt den Status; One-Shot-`delObject`-Orphan-Cleanup). Komponenten-i18n eigenständig in `src-admin/src/i18n/` (11 Sprachen, `gsw_`-Keys, `%s`-Args)
43. **Cloud-Retry-Loop (v1.6.0)** — `CloudLoadResult` union type (`ok`/`transient`/`rate-limited`/`auth-failed`). Bei Fail: `handleCloudFailure` entscheidet — Auth-Fail stoppt permanent, Rate-Limit wartet Retry-After, transient 5min. Retry ruft `retryCloudOnce` auf, "Govee Cloud connection restored"-Log bei Erfolg. Cloud-Init via Promise.race 60s-Timeout
44. **Segment-Count Single-Source-of-Truth (v1.7.0)** — `resolveSegmentCount(device)` ist DIE eine Funktion für die Segmentzahl. Priorität: `device.segmentCount` (wenn gesetzt — aus Cache oder MQTT gelernt) → Min über positive `segment_color_setting`-Caps → 0. Warum Min: Govee meldet Brightness + ColorRgb separat, diese widersprechen sich (H70D1: 10 vs 15 echter Wert 10). MQTT AA A5 darf nach oben korrigieren; jede Änderung wird sofort im SKU-Cache persistiert (überlebt Restart). Cache persistiert auch `manualMode`+`manualSegments` — Cut-Strip-Einstellungen gehen nicht mehr verloren
45. **Dropdown Dual-Write (v1.11.0)** — Alle Dropdown-States (light_scene, diy_scene, snapshot_cloud, snapshot_local, music_mode, scene) sind `type: "mixed"` mit eindeutiger `common.states`-Map (`buildUniqueLabelMap` mit `(2)`/`(3)`-Suffix bei Duplikaten). `onStateChange` ruft `resolveDropdownInput` als erste Stage — löst Number/Number-String/Klartext-String case-insensitive auf den kanonischen Key auf, ack mit canonical Key zurück. Ein Code-Pfad für alle Dropdowns, keine Sonderfälle. Ohne `type:"mixed"` loggt js-controller bei Number-Schreibung `State value to set ... has to be type "string" but received type "number"` — und zwar auf **`log.info`**, NICHT `warn` (geprüft an `validator.js:performStrictObjectCheck` der empfohlenen Stable js-controller 7.0.7; `mixed` unterdrückt den Check komplett), und Klartext bleibt ohne Wirkung. **role-Wahl (seit v2.14.1):** diese mixed-Dropdowns nutzen `role: "state"` (work_mode → `level.mode.work`). Die semantisch hübschere `level.effect` scheidet aus, weil sie `type: "string"` erzwingen würde und damit die bewusst gewollte Number-Eingabe bei jeder Nutzung ins INFO-Log schreibt. v2.14.1 korrigiert die roles von `text`/`level`/`level.mode` (= ungültig für `mixed`, bzw. `level.mode` existiert gar nicht) auf `state`/`level.mode.work` → behebt den Object-Structure-Check E1009 + latentes E1008 auf PR #5824, ohne `type:"mixed"` und damit ohne Verhaltensänderung anzufassen

## Logging-Philosophie

- **Startup:** `Starting with channels: LAN, Cloud, MQTT — please wait...`
- **Ready:** Channel-Status-Summary (`LAN ✓  Cloud REST ✓  Lights Push ✓  Sensor Push ✓`), jedes `✗` gefolgt von einer WARN mit konkretem Grund. **Bewusst KEINE** Per-Device-Counts/Online-Summary hier — bei Ready-Zeit sind LAN-Scan + MQTT-Push noch am Settlen, ein „X online, Y offline" zeigt oft Lichter fälschlich offline. Per-Device-Status (Online/IP/Kanäle) lebt im State-Tree, wo er akkurat bleibt (`logDeviceSummary`)
- **Keine Redundanz:** Jede Info nur einmal (im Ready-Summary)
- **debug:** Routine (LAN scan, Discovery, Cache, State-Ops) — kein "LAN scan sent", keine "Default xxx" Zeilen
- **info:** Nur Start, Verbindungen, Ready-Summary, Snapshot-Ops
- **MQTT:** Erstverbindung = info, Reconnect-Versuche = debug, Restored = info

## Bug-Fix-Patterns (für künftige Releases)

46. **Race-Condition State-Delete (v2.5.2)** — Bei States die abhängig vom dynamischen Zustand „existieren oder nicht" sein sollen (z.B. `groups.*.info.membersUnreachable` nur wenn unreachable members) gibt's einen js-controller-WARN „has no existing object" wenn parallele async-Update-Pfade die Object-Lifecycle togglen. Lösung: state IMMER existent halten + bei „nichts zu zeigen" empty-string schreiben. Kein Object-Lifecycle-Toggle, keine Race. Detail: `state-manager.ts:800 updateGroupMembersUnreachable`.
47. **Echo-Cap defensive (v2.5.3)** — Wenn ein BLE-Paket-Echo (z.B. Wizard `segmentBatch` mit 0..SEGMENT_HARD_MAX) Indices oberhalb des echten `device.segmentCount` enthält, schreibt das ohne Filter in nicht-existierende States → js-controller WARN-Spam. `onSegmentBatchUpdate` + `onMqttSegmentUpdate` filtern jetzt defensiv `if (cap === 0 || idx >= cap) continue;`. Detail: `main.ts:234`.
48. **No-Channel Init-Race (v2.5.3)** — Cloud-only Geräte (z.B. H61A8 ohne LAN) auf user-Befehl direkt nach Restart: Cloud-Client noch null → CommandRouter warnt „No channel available". False alarm. Fix: wenn `channels.cloud === true && cloudClient === null` → debug + still verworfen. WARN nur wenn permanent kein Channel. Detail: `command-router.ts:204`.
49. **429 RATE_LIMIT Bug (v2.5.1)** — `classifyError` prüft err.message für Patterns; HttpError(429, "Too many requests") matcht „Rate limited" nicht → UNKNOWN. Cloud-Client hat jetzt expliziten Branch `if (err instanceof HttpError && err.statusCode === 429) lastErrorCategory = RATE_LIMIT`. Sonst zeigt der Ready-Hint die generische „Cloud request failed"-Meldung statt „rate-limited by Govee". Detail: `govee-cloud-client.ts:240`.
50. **httpsRequest + mqtt.connect-DI (v2.5.1, v2.5.4)** — GoveeCloudClient + GoveeMqttClient haben optionale Konstruktor-Parameter `httpsRequestImpl: HttpsRequestFn = httpsRequest` und `mqttConnectImpl: MqttConnectFn = mqtt.connect`. main.ts unverändert (default = real). Tests injizieren Fakes für unit-tests ohne Network. Pattern für andere I/O-Module übernehmbar.
51. **Button-State = Write-true-Pattern** — `role: "button"`-States im ioBroker werden NICHT durch Klick-auf-Knopf-Eintrag im Object-Browser ausgelöst — User muss `true` auf den State schreiben. In Wiki und User-Doku entsprechend formulieren („setze X auf true", nie „klicke auf X"). Memory: `feedback_iobroker_button_role_write`.
52. **Wiki-User-Doku-Sicht** — Wiki ist USER-doku, nicht DEV-doku. Knapp formulieren, ioBroker-Grundkenntnisse voraussetzen. Keine „in ioBroker-Objekte → Bearbeiten → Wert auf true → Speichern"-Megaschritte. Memory: `feedback_iobroker_button_role_write`.
53. **Mocha ESM-Loader-Falle bei test-helpers** — In dieser test-suite tripped der ESM-Loader wenn der alphabetisch ERSTE test-file einen non-`.test.ts` sibling importiert. Folge-Imports ohne explicit Extension werfen `ERR_MODULE_NOT_FOUND`. test-helpers.ts funktioniert in govee-cloud/govee-mqtt-tests (alphabetisch nach device-manager). Workaround: Helpers in device-manager.test.ts INLINE lassen, JSDoc-Kommentar im File. Memory: `feedback_mocha_esm_loader_bug`.
54. **Capability-Fallback ohne stale-Guard (v2.7.0, Issue #13)** — Bei zwei Quellen für User-Content (`/device/scenes` UND `/user/devices`-Capabilities mit `dynamic_scene.snapshot`-options) darf der Fallback NIE auf „nur ausführen wenn cache leer" gegated sein. Cache wird gefüllt = neue App-Snapshots/Szenen werden nie reingezogen. Richtige Logik: primary-source-empty → secondary-source ohne Guard ausführen, primary-source-error → cache lassen (transient). Gilt analog für andere User-Content-Felder die aus mehreren Cloud-Endpoints kommen können.
55. **Per-Device Button > globaler Button (v2.7.0)** — Wenn ein Refresh-Vorgang pro Gerät Sinn macht, gehört der Trigger pro Gerät unter den jeweiligen Channel — NICHT auf Adapter-Ebene. API-Budget: 5 Calls statt N×5. Discoverability: User klickt im selben Pfad wo das Refresh-Resultat erscheint, nicht in `info/*`. Gating in `capability-mapper.ts` über die relevante Capability — Thermometer/Sensor/Heater bekommen den Button gar nicht erst.
56. **HTTP 200 mit empty body ≠ Fehler (v2.7.0)** — Undokumentierte Govee-App-Endpoints liefern für unbekannte SKUs HTTP 200 mit komplett leerem Body. `httpsRequest` in `http-client.ts` resolvet das jetzt als `null` statt zu werfen. Caller mit `resp?.data?.…` optional chaining + `Array.isArray` Guards bekommen das transparent — kein Debug-Spam mehr. Nur non-empty non-JSON wird weiter als Parse-Error gemeldet.
57. **Actionable-Problems-Registry (v2.16.0) — actionable vs. transient, kein Spam** — `lib/actionable-problems.ts` (`ActionableProblems`-Klasse, Host-DI, isoliert + unit-getestet). Fehlerklassen die der USER lösen muss (VERIFICATION_PENDING / VERIFICATION_FAILED / AUTH — heilen NICHT von selbst; seit v2.16.1 nur Doku im Klassen-Kommentar, Enforcement = `report()`-Call-Site-Platzierung, kein Runtime-Gate) werden über `report()` EINMAL sichtbar gemacht: klarer „what → what to do"-`warn` + persistente ioBroker-**Notification** (`registerNotification("govee-smart", "userActionRequired", msg)`; io-package.json `notifications`-Scope = Adaptername, `severity: notify`, **`limit: 1`** = nur die neueste Meldung, kein Pile-up). `report()` ist **dedup-by-message**: re-surface nur bei echter Lageänderung (pending→failed), identische Wiederholung = no-op. `resolve()` loggt EINE Erfolgsmeldung (`info`); die Notification bleibt bis der User sie **quittiert** — ioBroker hat **keine** Adapter-Lösch-API, also Bordmittel statt Host-Kommando-Gebastel. **Transiente** Fehler (NETWORK/TIMEOUT/RATE_LIMIT/UNKNOWN) erreichen die Registry NIE — sie behalten warn-once-then-debug (`log-channel-fail.ts`). **Verdrahtet (3 unabhängige Keys):** (1) `mqtt-verification` — MQTT-2FA (`main.ts setOnVerificationFailed`→report, pending↔failed re-surface, MQTT-`connected`→resolve); (2) `cloud-auth` — falscher Cloud-API-Key (`handleCloudFailure` bei `{ok:false,reason:"auth-failed"}`→report, `onCloudRestored`→resolve); (3) `mqtt-auth` — falsches Govee-Passwort (neuer `GoveeMqttClient.onAuthFailed`-Callback bei authFailCount≥MAX→report, MQTT-`connected`→resolve). Weitere Sites = einfach `actionableProblems.report/resolve` an der Fehlerstelle aufrufen. **Systemsprache:** dynamische Problem-Meldung Englisch (Log-Regel #5667), Scope/Kategorie-Labels 11-sprachig. **Fleet-fähig** (Konsistenz-Ziel): isolierte Einheit → Übernahme = File kopieren + io-package-Scope deklarieren + Fehlerstellen verdrahten. Type-Augmentation `NotificationScopes` in `adapter-config.d.ts`.

## Tests (1222 unit + 57 package + integration; + 19 src-admin vitest+jsdom)

One vitest suite per module (`src/**/*.test.ts`), each with a "Drift" block hardening against malformed / non-string / null API payloads (incl. the full `lib/handlers/` layer). Honest coverage: `vitest.config.ts` `coverage.include: ["src/**/*.ts"]` (~83 % stmts); `main.ts` (integration-covered) + `test-helpers.ts` excluded with reasons. Package + integration under `test/` (`package.js` 57 checks, `integration.js` start-up harness).
Run: `npx vitest run` · `npm test` (+ package) · `npm run test:integration`.

## Konkurrenz-Lage

- Schwester-Adapter `iobroker.govee` ist veraltet (nur LAN, keine MQTT, keine Sensoren/Appliances) — diese Implementation ist die einzige Govee-Lösung im Latest-Repo mit voller Multi-Channel + ptReal + Wizard.
- ioBroker.repositories PR #5824 (Latest-Aufnahme) **MERGED 2026-06-06** — govee-smart ist im Latest-Repo. Live-Stand: `show-pr-status.py`.

## Befehle

```bash
npm run build        # Production (esbuild via @iobroker/adapter-dev)
npm run check        # tsc --noEmit type-check
npm test             # vitest run + mocha package tests
npm run coverage     # vitest --coverage
npm run lint         # ESLint + Prettier
```
