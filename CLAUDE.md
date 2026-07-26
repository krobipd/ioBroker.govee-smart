# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Die APIs (LAN-Protokoll, MQTT AWS IoT, ptReal BLE, Scene-Speed, Segment-Detection, Snapshot-ptReal) sind größtenteils undokumentiert — die verifizierten Details stehen unten bei der jeweiligen Sektion.

## Projekt

**ioBroker Govee Smart Adapter** — Steuert Govee WiFi-Geräte: Lights (LED-Strips, Lampen, Panels), Sensoren (Thermometer/Hygrometer), Appliances (Heater, Humidifier, Kettle, Ice Maker, Fan, Purifier). LAN first für Lights, App-API + OpenAPI-MQTT für Sensoren/Appliances, Cloud REST v2 für Capabilities + Steuer-Fallback.

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.govee-smart · **npm:** https://www.npmjs.com/package/iobroker.govee-smart
- **Runtime-Deps:** `@iobroker/adapter-core`, `mqtt`, `node-forge` · **Wiki:** auditiert + bilingual EN/DE ([Link](https://github.com/krobipd/ioBroker.govee-smart/wiki))

## LAN-first für Lights (harte Regel — Cloud überschreibt LAN-States nie)

- **LAN-States für Lights (power, brightness, color_rgb, color_temperature) dürfen NIE von Cloud überschrieben werden** (State-IDs snake_case seit B2; die Cloud-Capability-Instances heißen weiter `colorRgb`/`colorTemperatureK`)
- State-Definitionen: LAN-fähige Geräte → immer `getDefaultLanStates()` als Basis
- State-Werte: `loadCloudStates()` filtert LAN-State-IDs für LAN-fähige Geräte (`if (device.lanIp && lanStateIds.has(...)) continue;`)
- `applyOnlineCap` (device-manager.ts) macht Multi-Source-Online-Merge mit `lastSeenOnNetwork`-Tracking — robust gegen LAN/MQTT/Cloud-Widersprüche
- Cloud ist NUR für: Capabilities, Szenen, Snapshots, Toggles, Segmente, Sensor-Capabilities

## Kanal-Priorität pro Operation

| Bereich | Primär | Fallback |
| --- | --- | --- |
| Lights-Steuerung (power, brightness, color_rgb, color_temperature, Segmente, Gradient) | LAN UDP | Cloud REST = **Notfall**¹ |
| Music-Mode, Scene-Speed | LAN UDP | keiner |
| Scene-/DIY-/Snapshot-Aktivierung | LAN UDP (ptReal) | Cloud REST (backup) |
| Generic Capability | Cloud REST | — |
| Lights-Status: Discovery, devStatus, `info.online`, `info.ip` | LAN UDP | — |
| Lights-Status: Status-Push, Segment-State-Echo | AWS-IoT MQTT | — |
| Cloud-Setup (Geräteliste+Capabilities, Scene-Library, Snapshot-BLE, Snapshot-Liste) | Cloud REST | — |
| Group-Members | App-API | — |
| Sensor-Werte (Temp/Hum), Battery | App-API | — |
| Appliance-Events | OpenAPI-MQTT | — |
| Appliance-Steuerung | Cloud REST | — |
| Appliance `info.online` | App-API | OpenAPI-MQTT |

¹ **Notfall-Fallback** — nur wenn lokale API nicht aktiviert (`lanIp === null`). 5-10s Latenz pro Call, 10/min Rate-Limit. Adapter warnt beim Start („LAN ✗") mit Anleitung zur LAN-Aktivierung.

## govee-appliances ist DEPRECATED

Seit v2.0.0 (2026-04-25) gemerged in govee-smart. Repo `iobroker.govee-appliances` archiviert. Falls Code-Pfade noch von „Koexistenz" reden — das ist Legacy. APPLIANCE_TYPES filter, MQTT-ClientID-Trennung, Rate-Budget-Sharing waren v1.x. Aktuell: ein Adapter macht alles. Memory: `project_govee_appliances_deprecated`.

## Credential-Stufen (graceful degradation)

| Eingabe | Funktionsumfang |
| --- | --- |
| Nichts | LAN-only: Discovery, Power, Brightness, Color, Status |
| + API Key | + Geräteliste mit Namen, Capabilities, Szenen, Snapshots, Segmente |
| + Email/Passwort | + Echtzeit Status-Push via MQTT |

## Architektur

`main.ts` = Lifecycle + Wiring; die Arbeit liegt in `src/lib/`. Zwei Aufteilungen sind nicht offensichtlich:

- **`src/lib/handlers/`** — entlastet `main.ts`, ein File je Zuständigkeit (Cloud-Creds, Cloud-Retry, Cloud-State-Loading, Connection-State, Device-Events, Diagnostics, Group-Fanout, Dropdown-Reset, Snapshot-Glue, State-Change-Router, Wizard). `cloud-creds-handler.ts` persistiert MQTT-Creds als **verschlüsselte Datei im Instanz-Datenverzeichnis** (wie SKU-Cache) — bewusst KEIN `meta.user`, weil re-derivierbarer Cache keinen sichtbaren Objektbaum-Knoten braucht.
- **`src/lib/device-manager/`** — Sub-Files für Cloud-Merge, Cache, Library-Loading, Reconcile sowie die reinen (pure) `lookups.ts` + `mapping.ts`, die dadurch direkt testbar sind.

`src-admin/` ist eine eigenständige Module-Federation-React-Komponente (Vite, Vorbild `iobroker.public-holidays`) → baut nach `admin/custom/customComponents.js` (gitignored, via `files[]` + `prepublishOnly` im Tarball). Eigene i18n mit `gsw_`-Keys, 11 Sprachen. Build `npm run build:admin`, Tests `npm --prefix src-admin run test`.

## State Tree

Ordnername = immer `sku_shortid` (z.B. `h61be_1d6f` = SKU + letzte 4 Hex der Device-ID). Cloud-Name **nur** in `common.name` — der Ordner bleibt stabil, wenn der User das Gerät in der App umbenennt.

Geräte unter `devices/`, Gruppen unter `groups/`. Pro Gerät vier Channels: `control`, `scenes`, `music`, `snapshots`, dazu `info` und dynamisch `segments`. Gruppen bekommen nur die Fan-Out-fähige Teilmenge (kein Snapshot, keine Diagnostics).

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
- Response: `{data: {categories: [{scenes: [{sceneName, sceneCode, sceneId, sceneParamId}]}]}}`

## Cloud REST API v2

**Base URL:** `https://openapi.api.govee.com` · **Auth:** Header `Govee-API-Key: <key>`

- Rate Limits: 10/min/Gerät, 10.000/Tag — **Appliances aber nur 100/Tag (!)**. Rate-Limiter schützt, Cloud nur als letzter Ausweg.
- Unit-Normalisierung: `unit.percent` → `%`, `unit.kelvin` → `K`, `unit.celsius` → `°C`

## AWS IoT MQTT

**Auth-Flow (v2-Header erforderlich):**

1. Login: `POST app2.govee.com/.../v1/login` → token + accountId + topic (Headers: User-Agent, clientId, appVersion, timezone, country, envId, iotVersion)
2. IoT Key: `GET app2.govee.com/.../iot/key` → endpoint + P12 cert
3. Connect: Mutual TLS, Client-ID `AP/<accountId>/<uuid>`

**Topics:** Subscribe Account-Topic → Echtzeit-Status aller Geräte; Publish Device-Topic → Befehle (turn, brightness, colorwc).

## LAN UDP

Discovery `239.255.255.250:4001` · Antworten an Client `:4002` · Commands an Geräte-IP `:4003`. Ports sind fix (Govee-Protokoll). Nur Lights mit aktivierter LAN-Funktion in der Govee-Home-App.

## Admin UI

Single Page: **1.** LAN (immer aktiv) · **2.** Cloud API (optional, API Key → Szenen/Segmente/Namen) · **3.** Govee Account (optional, Email+Passwort → Echtzeit-Push) · **4.** Donation.

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
10. **ptReal Scene Activation** — Szenen mit sceneCode aus Scene Library via BLE-over-LAN statt Cloud; Name-Matching mit Suffix-Stripping (-A/-B)
11. **Keine null-Werte** — Alle States haben `def` in StateDefinition + werden beim Erstellen initialisiert
12. **Stale State Cleanup** — `cleanupAllChannelStates()` entfernt alte States aus allen Channels + leere Channels; handelt auch Migration vom alten Single-Control-Layout
13. **Error-Dedup** — `classifyError()` + `lastErrorCategory` in DeviceManager; warn nur bei Kategorie-Wechsel
14. **Rate-Limited Startup** — Scene-Loading über `rateLimiter.tryExecute()` auch beim Cloud-Init
15. **Segment-Routing** — `segmentColor:N`/`segmentBrightness:N` → LAN ptReal first (`33 05 15`), Cloud fallback; Batch-Command → multi-segment bitmask in einem Paket
16. **Shared Utilities** — `normalizeDeviceId()` + `classifyError()` in types.ts, nicht dupliziert
17. **Kein Fire-and-forget** — Alle async void-Calls haben `.catch()` Handler
18. **Dropdown-Reset** — Moduswechsel (Scene/DIY/Snapshot/Music/Color) setzt alle ANDEREN Dropdowns auf „---" (0) zurück
19. **Generic Capability Routing** — States mit `native.capabilityType/Instance` werden automatisch via Cloud API geroutet
20. **Batch Segment Command** — `segments.command`: `1-5:#ff0000:20`, `all:#00ff00`, `0,3,7::50` — max 2 API-Calls statt N×2
21. **MQTT Auth-Backoff** — Nach 3 konsekutiven Login-Fehlern Reconnect stoppen, actionable Warning
22. **Error-Dedup überall** — MQTT + Cloud: first warn, repeat debug; Recovery-Meldung bei Wiederherstellung
23. **MQTT Login-Klassifizierung** — Credential-Fehler → Auth-Backoff; Rate-Limit/Account-Issues/Abnormal → weiter reconnecten (kein „check email/password")
24. **info.ip State** — LAN-IP pro Gerät, auto-aktualisiert via `onLanIpChanged` Callback
25. **Network Interface Selection** — `networkInterface` Config (IP-Selector im Admin) bindet Multicast + Listen; Ports fix
26. **MQTT before Cloud** — MQTT wird vor Cloud initialisiert, damit Scene Library beim ersten `loadFromCloud` verfügbar ist
27. **Ready-Message Ordering** — `checkAllReady()` prüft MQTT+Cloud vor dem Ready-Log; Safety-Timeout **60s** (seit v1.6.0, war 30s) mit ehrlicher „noch im Aufbau"-Meldung
28. **SKU Cache** — persistiert Device-Daten + Libraries lokal; nach erstem Start null Cloud-Calls nötig. `scenesChecked`-Flag verhindert Endlos-Refetch bei legitim leeren Scenes; `pruneStale(14)` entfernt stale Einträge
29. **Local Snapshots** — Gerätezustand per LAN als JSON inkl. Per-Segment Color+Brightness; Restore replayed einzelne LAN-Commands
30. **Device Quirks (v2.10.0 „fertig")** — `device-registry.ts` lädt `devices.json`, korrigiert per-SKU; `seed`-Quirks nur mit Toggle „experimentalQuirks". Drei Pattern-Familien: **Range-Override** (`colorTempRange` → `capability-mapper.ts:applyColorTempQuirk`), **Boolean-Flag** (`brokenPlatformApi` → `buildCloudStateDefs` skippt Cloud-Cap-Mapping, fällt auf LAN-Defaults zurück), **Map-Override** (`transportOverrides` → `command-router.ts:resolveTransport`; Segment-Suffix-Commands erben den `segmentBatch`-Override). **Nicht-Quirks:** `manualMode`/`manualSegments` (runtime user-setting), Identitäts-/Metadatenfelder, Per-User-Defaults → jsonConfig. **Neues Quirk verdrahten:** Interface erweitern → `devices.schema.json` (mit `additionalProperties:false`) → Konsumstelle → `devices.json`-Eintrag mit `since` → Test in `device-registry.test.ts` + Konsumstelle.
31. **Scene Speed** — `speedInfo.moveIn[]` aus sceneLibrary; Speed-Byte an Position `pageLength - 5` im scenceParam; `applySceneSpeed()` ersetzt vor dem Senden
32. **Multi-Channel State Tree** — 4 Channels via `def.channel`, Pfad-Auflösung über `resolveStatePath()`
33. **Groups Fan-Out** — Capabilities = Intersection der Mitglieder; Befehle → LAN/ptReal pro Mitglied; keine Snapshots/Diagnostics
34. **Dynamic Segments** — Segment-Anzahl aus Capability-Daten, überschüssige Channels werden gelöscht
35. **Diagnostics Export** — Button pro Gerät erzeugt strukturiertes JSON (Capabilities, Szenen, Libraries, Quirks, State) für GitHub Issues
36. **Community Quirks** — Beiträge zu `devices.json` über GitHub Issues + PRs (CONTRIBUTING.md); keine externe `community-quirks.json` mehr
37. **Separated Concerns (seit 1.1.0)** — CommandRouter, GoveeApiClient, http-client, capability-mapper als eigenständige Module
38. **MQTT Segment State-Sync** — `parseMqttSegmentData()` dekodiert AA-A5-BLE-Pakete → Per-Segment Brightness+RGB; nur bei `segmentCount > 0` und nur im Gradient/Color-Modus (Scene/Music liefert keine AA A5)
39. **Snapshot ptReal** — BLE-Pakete von `/bff-app/v1/devices/snapshots` als `snapshotBleCmds`; Aktivierung lokal via `sendPtReal()`, Cloud-Fallback ohne BLE-Daten
40. **Scene Variants** — `fetchSceneLibrary()` iteriert ALLE `lightEffects` pro Szene (nicht nur [0]); Varianten als „Name-Suffix" (z.B. „Aurora-A")
41. **Manual Segments (v1.6.0)** — `manual_mode` + `manual_list` für gekürzte Strips. `parseSegmentList()` akzeptiert `"0-9"`, `"0-8,10-14"`, Kommas, whitespace; validiert gegen `segmentCount-1`, Backstop 0-99. `parseSegmentBatch "all"` und der MQTT-Filter honorieren `manualSegments`
42. **Segment Detection Wizard (v1.7.0, React seit v2.21.0)** — Der Wizard MISST die echte Strip-Länge unabhängig von der Cloud (bis Protokoll-Limit 55 oder User-Abbruch), erkennt Lücken. In-Memory-Session, Baseline-Capture, 5-Min-Idle-Timeout, globaler Session-Lock. Ergebnis via `applyWizardResult`: setzt `segmentCount`, `manualMode` nur bei erkannten Lücken, persistiert Cache. **v2.21.0:** eigene React-Komponente (`src-admin/`) statt jsonConfig-Button-Tab. Backend **additiv** — `runStep` faltet einen Grid-`snapshot` in JEDE Response, `apply(indices)` finalisiert die im Review korrigierte Karte als **alternativer Finalizer** zu `finish` (gleiche Guards, teilt `finalize()`). `done`/`finish` unverändert, vom React-Flow nicht mehr genutzt.
43. **Cloud-Retry-Loop (v1.6.0)** — `CloudLoadResult` union (`ok`/`transient`/`rate-limited`/`auth-failed`). Auth-Fail stoppt permanent, Rate-Limit wartet Retry-After, transient 5min. Cloud-Init via `Promise.race` 60s-Timeout
44. **Segment-Count Single-Source-of-Truth (v1.7.0)** — `resolveSegmentCount(device)` ist DIE eine Funktion. Priorität: `device.segmentCount` → **Min** über positive `segment_color_setting`-Caps → 0. Warum Min: Govee meldet Brightness + ColorRgb separat und sie widersprechen sich (H70D1: 10 vs 15, echt ist 10). MQTT AA A5 darf nach oben korrigieren; jede Änderung sofort im SKU-Cache persistiert
45. **Dropdown Dual-Write (v1.11.0)** — Alle Dropdown-States sind `type: "mixed"` mit eindeutiger `common.states`-Map (`buildUniqueLabelMap`, `(2)`/`(3)`-Suffix bei Duplikaten). `resolveDropdownInput` löst Number/Number-String/Klartext case-insensitive auf den kanonischen Key auf. **Warum `mixed`:** ohne das loggt js-controller bei Number-Schreibung `State value to set ... has to be type "string"` — und zwar auf **`log.info`**, NICHT `warn` (geprüft an `validator.js:performStrictObjectCheck`, js-controller 7.0.7); `mixed` unterdrückt den Check komplett. **Warum `role: "state"` statt `level.effect`** (seit v2.14.1): `level.effect` würde `type:"string"` erzwingen und damit die bewusst gewollte Number-Eingabe bei JEDER Nutzung ins INFO-Log schreiben. v2.14.1 korrigierte `text`/`level`/`level.mode` (ungültig für `mixed`, `level.mode` existiert gar nicht) auf `state`/`level.mode.work` → behebt E1009 + latentes E1008, ohne Verhaltensänderung

## Logging-Philosophie

- **Startup:** `Starting with channels: LAN, Cloud, MQTT — please wait...`
- **Ready:** Channel-Status-Summary (`LAN ✓  Cloud REST ✓  Lights Push ✓  Sensor Push ✓`), jedes `✗` gefolgt von einer WARN mit konkretem Grund. **Bewusst KEINE** Per-Device-Counts hier — zur Ready-Zeit settlen LAN-Scan + MQTT-Push noch, ein „X online, Y offline" zeigt oft Lichter fälschlich offline. Per-Device-Status lebt im State-Tree, wo er akkurat bleibt.
- **Keine Redundanz:** Jede Info nur einmal (im Ready-Summary)
- **debug:** Routine (LAN scan, Discovery, Cache, State-Ops) · **info:** nur Start, Verbindungen, Ready-Summary, Snapshot-Ops
- **MQTT:** Erstverbindung = info, Reconnect-Versuche = debug, Restored = info

## Bug-Fix-Patterns (für künftige Releases)

46. **Race-Condition State-Delete (v2.5.2)** — States, die je nach Zustand „existieren oder nicht" sollen, erzeugen einen js-controller-WARN „has no existing object", wenn parallele async-Pfade den Object-Lifecycle togglen. Lösung: State IMMER existent halten, bei „nichts zu zeigen" empty-string schreiben. `state-manager.ts:updateGroupMembersUnreachable`.
47. **Echo-Cap defensive (v2.5.3)** — BLE-Paket-Echos können Indices oberhalb des echten `segmentCount` enthalten → Schreiben in nicht-existierende States → WARN-Spam. `onSegmentBatchUpdate` + `onMqttSegmentUpdate` filtern `if (cap === 0 || idx >= cap) continue;`.
48. **No-Channel Init-Race (v2.5.3)** — Cloud-only Geräte direkt nach Restart: Cloud-Client noch null → „No channel available" ist ein Fehlalarm. Fix: `channels.cloud === true && cloudClient === null` → debug + still verworfen. WARN nur bei permanent fehlendem Channel.
49. **429 RATE_LIMIT Bug (v2.5.1)** — `classifyError` matcht auf `err.message`; `HttpError(429, "Too many requests")` traf „Rate limited" nicht → UNKNOWN. Jetzt expliziter Branch auf `statusCode === 429`, sonst zeigt der Ready-Hint die generische statt der rate-limit-Meldung.
50. **httpsRequest + mqtt.connect-DI (v2.5.1, v2.5.4)** — Cloud- und MQTT-Client haben optionale Konstruktor-Parameter für die I/O-Impl (default = real). Tests injizieren Fakes ohne Network. Pattern für andere I/O-Module übernehmbar.
51. **Button-State = Write-true-Pattern** — `role: "button"` wird NICHT durch Klick im Object-Browser ausgelöst; der User muss `true` schreiben. In Doku entsprechend formulieren („setze X auf true", nie „klicke auf X"). Memory: `feedback_iobroker_button_role_write`.
52. **Wiki-User-Doku-Sicht** — Wiki ist USER-doku, nicht DEV-doku. ioBroker-Grundkenntnisse voraussetzen, keine „Objekte → Bearbeiten → Wert → Speichern"-Megaschritte.
53. **Mocha ESM-Loader-Falle bei test-helpers** — Der ESM-Loader tript, wenn der alphabetisch ERSTE test-file einen non-`.test.ts` sibling importiert; Folge-Imports ohne Extension werfen `ERR_MODULE_NOT_FOUND`. Helpers in `device-manager.test.ts` INLINE lassen. Memory: `feedback_mocha_esm_loader_bug`.
54. **Capability-Fallback ohne stale-Guard (v2.7.0, Issue #13)** — Bei zwei Quellen für User-Content darf der Fallback NIE auf „nur wenn Cache leer" gegated sein, sonst kommen neue App-Snapshots nie rein. Richtig: primary-empty → secondary ohne Guard; primary-**error** → Cache lassen (transient).
55. **Per-Device Button > globaler Button (v2.7.0)** — Refresh gehört pro Gerät unter den Channel, nicht auf Adapter-Ebene: 5 statt N×5 API-Calls, und der User klickt dort, wo das Resultat erscheint. Gating in `capability-mapper.ts` — Thermometer/Sensor/Heater bekommen den Button gar nicht.
56. **HTTP 200 mit empty body ≠ Fehler (v2.7.0)** — Undokumentierte Govee-Endpoints liefern für unbekannte SKUs HTTP 200 mit leerem Body. `httpsRequest` resolvet das als `null` statt zu werfen; Caller mit `resp?.data?.…` + `Array.isArray`-Guards bekommen es transparent. Nur non-empty non-JSON bleibt Parse-Error.
57. **Actionable-Problems-Registry (v2.16.0)** — `lib/actionable-problems.ts` trennt **actionable** von **transient**. Fehler, die der USER lösen muss (VERIFICATION_PENDING/FAILED, AUTH — heilen nicht von selbst), gehen über `report()` EINMAL raus: „what → what to do"-`warn` + persistente ioBroker-**Notification** (`registerNotification`, Scope = Adaptername, `severity: notify`, **`limit: 1`** = kein Pile-up). `report()` ist **dedup-by-message** — re-surface nur bei echter Lageänderung (pending→failed). `resolve()` loggt einmal Erfolg; die Notification bleibt, bis der User quittiert (ioBroker hat keine Adapter-Lösch-API). **Transiente** Fehler (NETWORK/TIMEOUT/RATE_LIMIT/UNKNOWN) erreichen die Registry NIE — sie behalten warn-once-then-debug. Verdrahtet für `mqtt-verification`, `cloud-auth`, `mqtt-auth`; weitere Sites = `report`/`resolve` an der Fehlerstelle aufrufen. **Fleet-fähig:** File kopieren + io-package-Scope deklarieren + verdrahten.

## Tests

One vitest suite per module (`src/**/*.test.ts`), jede mit einem „Drift"-Block gegen malformed / non-string / null API-Payloads (inkl. der ganzen `lib/handlers/`-Schicht). Ehrliche Coverage über `coverage.include: ["src/**/*.ts"]`; `main.ts` (integration-covered) + `test-helpers.ts` mit Begründung ausgenommen. Package + integration unter `test/`. Aktuelle Zahlen liefert `npx vitest run`.

## Konkurrenz-Lage

Schwester-Adapter `iobroker.govee` ist veraltet (nur LAN, keine MQTT, keine Sensoren/Appliances) — diese Implementation ist die einzige Govee-Lösung im Latest-Repo mit voller Multi-Channel + ptReal + Wizard. Aufnahme-PR ioBroker.repositories#5824 **MERGED 2026-06-06**. Live-Stand: `show-pr-status.py`.

## Befehle

```bash
npm run build        # Production (esbuild via @iobroker/adapter-dev)
npm run check        # tsc --noEmit type-check
npm test             # vitest run + mocha package tests
npm run coverage     # vitest --coverage
npm run lint         # ESLint + Prettier
npm run test:integration          # start-up harness
npm --prefix src-admin run test   # React-Admin-Komponente
```
