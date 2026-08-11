# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis (allgemeine Patterns, Coding-Regeln, Release/CI, Repochecker): `../CLAUDE.md` + `../CLAUDE_*.md`. **Hier steht ausschließlich govee-Spezifisches** — die undokumentierten Govee-APIs, die Kanal-Architektur und die nicht-offensichtlichen Entscheidungen dieses Adapters. Generische ioBroker-Mechanik (async-Fehlerfänger, State-Delete-Race, Test-Dependency-Injection, Netzwerk-Interface-Bindung, Actionable-Problems-Registry …) liegt bewusst in der Fleet-Doku, nicht hier.

## Projekt

**ioBroker Govee Smart Adapter** — steuert Govee-WLAN-Geräte: Lights (LED-Strips, Lampen, Panels), Sensoren (Thermo-/Hygrometer), Appliances (Heizer, Luftbefeuchter, Wasserkocher, Eiswürfelbereiter, Ventilator, Luftreiniger). **LAN first** für Lights, **App-API + OpenAPI-MQTT** für Sensoren/Appliances, **Cloud-REST** für Capabilities + Steuer-Fallback.

- **Version + Changelog:** aktuelle Version in `io-package.json`; user-facing Changelog in `README.md` + `io-package.json:common.news` (11 Sprachen, handgeschrieben). Interne Entwicklungs-Historie: `.claude/dev-history.md` (lokal, nicht git-getrackt).
- **GitHub:** https://github.com/krobipd/ioBroker.govee-smart · **npm:** https://www.npmjs.com/package/iobroker.govee-smart
- **Runtime-Deps:** `@iobroker/adapter-core`, `mqtt`, `node-forge` · **Wiki:** bilingual EN/DE, Geräte-Liste generiert aus `devices.json`

Die APIs (LAN-Protokoll, AWS-IoT-MQTT, ptReal BLE-over-LAN, Scene-Speed, Segment-Detection, Snapshot-ptReal) sind größtenteils **undokumentiert** — die verifizierten Details stehen unten bei der jeweiligen Sektion.

## LAN-first für Lights (harte Regel — Cloud überschreibt LAN-States nie)

- **LAN-States für Lights (`power`, `brightness`, `color_rgb`, `color_temperature`) dürfen NIE von Cloud überschrieben werden.** State-IDs snake_case seit B2; die Cloud-Capability-Instances heißen weiter `colorRgb`/`colorTemperatureK`.
- LAN-fähige Geräte → immer `getDefaultLanStates()` als Basis.
- `loadCloudStates()` filtert LAN-State-IDs für LAN-fähige Geräte (`if (device.lanIp && lanStateIds.has(...)) continue;`).
- `applyOnlineCap` (device-manager.ts) macht Multi-Source-Online-Merge mit `lastSeenOnNetwork`-Tracking — robust gegen LAN/MQTT/Cloud-Widersprüche.
- Cloud ist NUR für: Capabilities, Szenen, Snapshots, Toggles, Segmente, Sensor-Capabilities.

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

¹ **Notfall-Fallback** — nur wenn lokale API nicht aktiviert (`lanIp === null`). 5–10 s Latenz pro Call, 10/min Rate-Limit. Adapter warnt beim Start („LAN ✗") mit Anleitung zur LAN-Aktivierung.

## Credential-Stufen (graceful degradation)

| Eingabe | Funktionsumfang |
| --- | --- |
| Nichts | LAN-only: Discovery, Power, Brightness, Color, Status |
| + API Key | + Geräteliste mit Namen, Capabilities, Szenen, Snapshots, Segmente |
| + Email/Passwort | + Echtzeit Status-Push via AWS-IoT-MQTT |

Der Account-Login (Email/Passwort) läuft NUR, wenn beide Felder gesetzt sind (getrimmt) — sonst kein Login-Versuch (`main.ts`, Guard `hasAccountCreds`).

## Architektur

`main.ts` = Lifecycle + Wiring; die Arbeit liegt in `src/lib/`. Drei Aufteilungen sind nicht offensichtlich:

- **`src/lib/handlers/`** — entlastet `main.ts`, ein File je Zuständigkeit: `cloud-creds-handler`, `cloud-retry-handler`, `cloud-state-loader`, `connection-state`, `device-events`, `diagnostics-handler`, `dropdown-reset-helpers`, `group-fanout-handler`, `snapshot-handler-glue`, `state-change-router`, `wizard-handler`. `cloud-creds-handler` persistiert MQTT-Creds als **verschlüsselte Datei im Instanz-Datenverzeichnis** (wie SKU-Cache) — bewusst KEIN `meta.user`, weil re-derivierbarer Cache keinen sichtbaren Objektbaum-Knoten braucht.
- **`src/lib/device-manager/`** — Sub-Files für Cloud-Merge (`cloud-merge`), Cache (`cache`), Library-Loading (`library-loader`), Reconcile (`reconciler`) sowie die reinen `lookups.ts` + `mapping.ts`, die dadurch direkt testbar sind.
- **Die vier API-Clients:** `govee-cloud-client` (Cloud-REST v2, API-Key) · `govee-mqtt-client` (AWS-IoT, Account-Login) · `govee-openapi-mqtt-client` (Cloud-Events, API-Key) · `govee-lan-client` (UDP) · `govee-api-client` (App-API app2.govee.com). Beide MQTT-Clients erben Reconnect/Backoff aus `reconnecting-mqtt-client`.

`src-admin/` ist eine eigenständige Module-Federation-React-Komponente (Vite, Vorbild `iobroker.public-holidays`) → baut nach `admin/custom/customComponents.js` (git-getrackt, via `files[]` + `prepublishOnly` im Tarball). Eigene i18n mit `gsw_`-Keys, 11 Sprachen. Enthält `SegmentWizard`/`SegmentGrid`/`useWizardApi` + `SegmentWizardConfig` (Module-Federation-Mount).

## State Tree

Ordnername = immer `sku_shortid` (z.B. `h61be_1d6f` = SKU + letzte 4 Hex der Device-ID). Cloud-Name **nur** in `common.name` — der Ordner bleibt stabil, wenn der User das Gerät in der App umbenennt.

Geräte unter `devices/`, Gruppen unter `groups/`. Pro Gerät fünf Channels: `control`, `scenes`, `music`, `snapshots`, `info`, dazu dynamisch `segments`. Gruppen bekommen nur die Fan-Out-fähige Teilmenge (kein Snapshot, keine Diagnostics). **Alle States haben `def`** in der StateDefinition und werden beim Erstellen initialisiert (keine null-Werte).

## Cloud REST API v2

**Base URL:** `https://openapi.api.govee.com` · **Auth:** Header `Govee-API-Key: <key>`

- Rate Limits: 10/min/Gerät, 10.000/Tag — **Appliances aber nur 100/Tag (!)**. Rate-Limiter (`rate-limiter.ts`) schützt, Cloud nur als letzter Ausweg.
- Unit-Normalisierung: `unit.percent` → `%`, `unit.kelvin` → `K`, `unit.celsius` → `°C`.
- **HTTP 200 mit leerem Body ≠ Fehler:** undokumentierte Govee-Endpoints liefern für unbekannte SKUs HTTP 200 mit leerem Body. `httpsRequest` resolvet das als `null` statt zu werfen; Caller mit `resp?.data?.…` + `Array.isArray`-Guards bekommen es transparent. Nur non-empty non-JSON bleibt Parse-Error.
- **429 RATE_LIMIT:** `classifyError` hat einen expliziten Branch auf `statusCode === 429` (nicht nur Message-Match), sonst zeigt der Ready-Hint die generische statt der Rate-Limit-Meldung.
- **Cloud-Retry-Loop:** `cloud-retry.ts` — `CloudLoadResult`-Union (`ok`/`transient`/`rate-limited`/`auth-failed`). `auth-failed` stoppt permanent (User muss API-Key fixen), `rate-limited` wartet den server-`Retry-After` (mit Floor), `transient` 5 min. Cloud-Init via `Promise.race` mit 60-s-Timeout.

## App-API (app2.govee.com — internal)

Die interne App-API liefert, was die öffentliche OpenAPI nicht kann: **Sensor-Werte, Gruppen-Mitglieder, Scene-/Music-Libraries.** Auth teils via Bearer-Token aus dem MQTT-Login, teils public (Scene-Library braucht KEINE Auth, nur AppVersion + User-Agent-Header).

- Sensor-Werte (z.B. H5179): OpenAPI v2 `/device/state` liefert `[]` → Werte kommen aus App-API `POST /device/rest/devices/v1/list` → `deviceExt.lastDeviceData`. App-API-Poll alle 2 min.
- Scene Library: `GET /appsku/v1/light-effect-libraries?sku=<SKU>` (public) → `sceneCode` für ptReal BLE-over-LAN.

## AWS IoT MQTT (Echtzeit-Status-Push)

**Auth-Flow (v2-Header erforderlich):**

1. Login: `POST app2.govee.com/account/rest/account/v2/login` → token + accountId + topic (Headers: User-Agent, clientId=UUIDv5(email), appVersion, timezone, country, envId, iotVersion).
2. IoT Key: `GET app2.govee.com/app/v1/account/iot/key` → endpoint + P12 cert.
3. Connect: Mutual TLS, Client-ID `AP/<accountId>/<uuid>`.

**Topics:** Subscribe Account-Topic → Echtzeit-Status aller Geräte; Publish Device-Topic → Befehle. **Wir sind subscribe-only für Status** (Commands gehen über LAN/ptReal/Cloud, nicht MQTT-Publish).

**Login-Sturm-Schutz (Issue #39, Account-24h-Sperre-Prävention):** Der Account-Login-Reconnect hat ein **globales Cap** (`MQTT_MAX_AUTH_FAILURES = 3`). Jeder Login-Versuch, der Govee **erreicht** und abgelehnt wird — falsche Zugangsdaten, Rate-Limit, Account gesperrt, unerwartete Antwort — zählt auf dieses Cap (`reachedGovee = category ≠ NETWORK ≠ TIMEOUT`). Nur reine Netz-/Timeout-Fehler (der Login-POST erreichte Govee nicht) laufen ungedeckelt weiter, weil sie den Account nicht belasten. Der Zähler wird **ausschließlich bei erfolgreichem Subscribe** zurückgesetzt (nicht im Fehlerpfad) — sonst umgeht ein Wechsel aus Ablehnung + Netz-Blip das Cap. Bei Erreichen: permanenter Stopp + eine handlungsleitende Meldung (falsche Zugangsdaten → „Email/Passwort prüfen"; sonst → „Neuversuche gestoppt, Account prüfen, Adapter neu starten"). **`refreshBearerSilently` ist ein zweiter Login-Pfad** (proaktiver Token-Refresh 5 min vor Ablauf) und bailt bei ausgeschöpftem Cap oder getrennter Session, damit er das Cap nicht umgeht. Vorbild = `cloud-retry.ts`-Disziplin.

**Login-Klassifizierung:** Credential-Fehler → dauerhafter Stopp; 2FA (454/455) → Reconnect pausiert bis User-Code; Rate-Limit/Account-Locked/Abnormal → zählt jetzt aufs Cap (früher: endloser Reconnect). Verifikations-Code (2FA): 454 = „neuer Client, einmalig verifizieren", nicht „2FA aktiviert"; Code-Request mit 30-s-Throttle gegen Email-Spam.

**Cert-Reuse:** persistierte Credentials (Bearer + P12) werden über Neustarts wiederverwendet (`tryPersistedReuse`) → kein 2FA-Email-Sturm bei jedem Restart; abgelaufener/ungültiger Cert fällt auf frischen Login zurück.

**MQTT before Cloud:** MQTT wird vor Cloud initialisiert, damit die Scene-Library beim ersten `loadFromCloud` verfügbar ist. Erstverbindung = info-Log, Reconnect-Versuche = debug, Restored = info.

## LAN UDP

Discovery `239.255.255.250:4001` · Antworten an Client `:4002` · Commands an Geräte-IP `:4003`. Ports fix (Govee-Protokoll). Nur Lights mit aktivierter LAN-Funktion in der Govee-Home-App. Der Multicast-Egress muss an die richtige Netzwerkkarte gebunden werden (Config `networkInterface`).

## Szenen-Architektur

Szenen kommen vom **separaten Scenes-Endpoint** (`POST /device/scenes`), NICHT aus den Device-Capabilities.

**Response:** `{payload: {capabilities: [{type, instance, parameters: {options: [{name, value}]}}]}}`

- `lightScene` Options → Szenen-Dropdown (Index-basierte Auswahl) · `snapshot` Options → Snapshot-Dropdown.
- **Aktivierung:** User wählt Index → `device.scenes[idx-1].value` → direkt als `capability.value` an Control-Endpoint.
- **ptReal Scene Activation:** Szenen mit `sceneCode` aus der Scene-Library via BLE-over-LAN (`33 05 15`-Präfix) statt Cloud; Name-Matching mit Suffix-Stripping (-A/-B). Cloud-Fallback ohne sceneCode.
- **Scene Speed:** `speedInfo.moveIn[]` aus der Library; Speed-Byte an Position `pageLength - 5` im sceneParam; `applySceneSpeed()` ersetzt vor dem Senden.
- **Scene Variants:** `fetchSceneLibrary()` iteriert ALLE `lightEffects` pro Szene (nicht nur [0]); Varianten als Name-Suffix („Aurora-A").
- **Snapshot ptReal:** BLE-Pakete aus `/bff-app/v1/devices/snapshots` als `snapshotBleCmds`; lokale Aktivierung via `sendPtReal()`, Cloud-Fallback ohne BLE-Daten. Lokale Snapshots (`local-snapshots.ts`): Gerätezustand per LAN als JSON inkl. Per-Segment Color+Brightness; Restore replayed einzelne LAN-Commands.
- **Dropdown-Reset:** Moduswechsel (Scene/DIY/Snapshot/Music/Color) setzt alle ANDEREN Dropdowns auf „---" (0) zurück.

## Segmente, Wizard & manuelle Segmente

- **Segment-Routing:** `segmentColor:N`/`segmentBrightness:N` → LAN ptReal first (`33 05 15`), Cloud-Fallback; Batch-Command → Multi-Segment-Bitmask in einem Paket. `segments.command`-Syntax: `1-5:#ff0000:20`, `all:#00ff00`, `0,3,7::50` — max 2 API-Calls statt N×2.
- **Segment-Count Single-Source-of-Truth:** `resolveSegmentCount(device)` ist DIE eine Funktion. Priorität: `device.segmentCount` → **Min** über positive `segment_color_setting`-Caps → 0. Warum Min: Govee meldet Brightness + ColorRgb separat und sie widersprechen sich (z.B. H70D1: 10 vs 15, echt ist 10). MQTT-AA-A5 darf nach oben korrigieren; jede Änderung sofort im SKU-Cache persistiert.
- **MQTT Segment State-Sync:** `parseMqttSegmentData()` dekodiert AA-A5-BLE-Pakete → Per-Segment Brightness+RGB; nur bei `segmentCount > 0` und nur im Gradient/Color-Modus (Scene/Music liefert keine AA-A5).
- **Echo-Cap defensive:** BLE-Paket-Echos können Indices oberhalb des echten `segmentCount` enthalten → `onSegmentBatchUpdate` + `onMqttSegmentUpdate` filtern `if (cap === 0 || idx >= cap) continue;` (sonst Schreiben in nicht-existierende States → WARN-Spam).
- **Manual Segments** (`manual_mode` + `manual_list`) für gekürzte Cut-Strips: `parseSegmentList()` akzeptiert `"0-9"`, `"0-8,10-14"`, Kommas, Whitespace; validiert gegen `segmentCount-1`, Backstop 0-99. `parseSegmentBatch "all"` und der MQTT-Filter honorieren `manualSegments`.
- **Segment Detection Wizard (React seit v2.21.0):** misst die echte Strip-Länge unabhängig von der Cloud (bis Protokoll-Limit 55 oder User-Abbruch), erkennt Lücken. In-Memory-Session, Baseline-Capture, 5-Min-Idle-Timeout, globaler Session-Lock. React-Komponente (`src-admin/`) statt jsonConfig-Button. Backend **additiv**: `runStep` faltet einen Grid-`snapshot` in JEDE Response; `apply(indices)` finalisiert die im Review korrigierte Karte als alternativer Finalizer zu `finish` (gleiche Guards, teilt `finalize()`).

## Geräte-Katalog & Quirks

`devices.json` (Schema `devices.schema.json`, Validierung `npm run validate-devices`) — pro SKU `name`/`type`/`status`/`since` + optionale `quirks`. `device-registry.ts` lädt es, korrigiert per-SKU.

- **Status:** `seed` (extern importiert, ungetestet) · `reported` (1 User mit Diagnose) · `verified` (mehrfach/krobi-Hardware). Wiki-Geräte-Liste wird per `npm run gen-wiki` aus `devices.json` erzeugt (Icons ⚪/🟢/✅).
- **Quirk-Familien:** **Range-Override** (`colorTempRange` → `capability-mapper.ts:applyColorTempQuirk`) · **Boolean-Flag** (`brokenPlatformApi` → `buildCloudStateDefs` skippt Cloud-Cap-Mapping, fällt auf LAN-Defaults zurück) · **Map-Override** (`transportOverrides` → `command-router.ts:resolveTransport`; erzwingt Cloud/LAN pro Command; auf cloud-only ein No-op).
- **Nicht-Quirks:** `manualMode`/`manualSegments` (Runtime-User-Setting), Identitäts-/Metadatenfelder, Per-User-Defaults → jsonConfig.
- **Neues Quirk verdrahten:** Interface erweitern → `devices.schema.json` (`additionalProperties:false`) → Konsumstelle → `devices.json`-Eintrag mit `since` → Test in `device-registry.test.ts` + Konsumstelle.
- **Diagnostics Export:** Button pro Gerät (`diag.export`) erzeugt strukturiertes JSON (Capabilities, Szenen, Libraries, Quirks, State, recentLogs, lastMqttPackets, runtimeState) für GitHub-Issues.
- **govee-appliances ist DEPRECATED** seit v2.0.0 (in govee-smart gemerged, Repo archiviert). Falls Code-Pfade noch von „Koexistenz" reden — Legacy.

## Admin UI

Single Page: **1.** LAN (immer aktiv) · **2.** Cloud API (optional, API Key → Szenen/Segmente/Namen) · **3.** Govee Account (optional, Email+Passwort → Echtzeit-Push) · **4.** Donation. Plus die React-Segment-Wizard-Komponente (eigener Tab, Module Federation).

## Design-Prinzipien (govee-spezifisch)

1. **LAN first** — schnellster Kanal, Kern des Adapters; Cloud darf LAN-States nie überschreiben.
2. **MQTT für Echtzeit** — Status-Push only (kein Command-Sending).
3. **Cloud nur wo nötig** — Definitionen, Szenen, Snapshots, Segmente.
4. **Graceful degradation** — ohne Credentials funktioniert LAN-only.
5. **Capability-driven** — States aus API generiert, nichts hardcodiert.
6. **Szenen als echte Dropdowns** — Index-basiert, value-Payload aus Cloud; nur wenn Daten vorhanden.
7. **Stabile Ordner** — `sku_shortid`, Cloud-Name nur in `common.name`.
8. **Nahtlos** — User merkt nicht, welcher Kanal gerade greift.
9. **Rate-Limited Startup** — Scene-Loading auch beim Cloud-Init über `rateLimiter.tryExecute()`.
10. **Error-Dedup** — `classifyError()` + `lastErrorCategory` (DeviceManager, MQTT, Cloud): warn beim ersten/neuen Kategorie-Wechsel, danach debug; Recovery-Meldung bei Wiederherstellung.
11. **Generic Capability Routing** — States mit `native.capabilityType/Instance` werden automatisch via Cloud-API geroutet (z.B. Ventilator-Speed, Toggles).
12. **info.ip / info.gateway State** — LAN-IP pro Gerät (auto via `onLanIpChanged`); Gateway-angebundene Sensoren zeigen das Gateway statt leerem IP-Feld.
13. **Ready-Message Ordering** — `checkAllReady()` prüft MQTT+Cloud vor dem Ready-Log; Safety-Timeout 60 s mit ehrlicher „noch im Aufbau"-Meldung. Ready-Summary zeigt Channel-Status (`LAN ✓ Cloud ✓ Lights Push ✓ Sensor Push ✓`), jedes `✗` gefolgt von einer WARN mit konkretem Grund. **Bewusst KEINE Per-Device-Counts** — zur Ready-Zeit settlen LAN-Scan + MQTT-Push noch.
14. **SKU Cache** (`sku-cache.ts`) — persistiert Device-Daten + Libraries lokal; nach erstem Start null Cloud-Calls nötig. `scenesChecked`-Flag verhindert Endlos-Refetch bei legitim leeren Scenes; `pruneStale(14)`.
15. **Multi-Channel State Tree** — Channels via `def.channel`, Pfad-Auflösung über `resolveStatePath()`.
16. **Groups Fan-Out** — Capabilities = Intersection der Mitglieder; Befehle → LAN/ptReal pro Mitglied; keine Snapshots/Diagnostics.
17. **Dynamic Segments** — Segment-Anzahl aus Capability-Daten, überschüssige Channels werden gelöscht.
18. **Community Quirks** — Beiträge zu `devices.json` über GitHub-Issues + PRs (CONTRIBUTING.md); keine externe Quirks-Datei.
19. **Separated Concerns** — CommandRouter, GoveeApiClient, http-client, capability-mapper als eigenständige Module.
20. **Shared Utilities** — `normalizeDeviceId()` + `classifyError()` in `types.ts`, nicht dupliziert.
21. **Dropdown Dual-Write** — alle Dropdown-States sind `type: "mixed"` mit eindeutiger `common.states`-Map (`buildUniqueLabelMap`, `(2)`/`(3)`-Suffix bei Duplikaten); `resolveDropdownInput` löst Number/Number-String/Klartext case-insensitive auf den kanonischen Key. **Warum `mixed`:** unterdrückt den js-controller-Strict-Type-Check, der sonst bei Number-Schreibung ins Log schreibt. **Warum `role: "state"`:** `level.effect` würde `type:"string"` erzwingen und die bewusst gewollte Number-Eingabe loggen.

## Bekannte Fallstricke (govee-spezifisch)

- **No-Channel Init-Race:** Cloud-only-Geräte direkt nach Restart — Cloud-Client noch null → „No channel available" ist Fehlalarm. Fix: `channels.cloud === true && cloudClient === null` → debug + still verworfen. WARN nur bei permanent fehlendem Channel.
- **Capability-Fallback ohne stale-Guard (Issue #13):** bei zwei Quellen für User-Content darf der Fallback NIE auf „nur wenn Cache leer" gegated sein, sonst kommen neue App-Snapshots nie rein. Richtig: primary-empty → secondary ohne Guard; primary-**error** → Cache lassen (transient).
- **Per-Device Button > globaler Button:** Refresh gehört pro Gerät unter den Channel, nicht auf Adapter-Ebene (5 statt N×5 API-Calls, User klickt dort, wo das Resultat erscheint). Thermometer/Sensor/Heater bekommen den Button gar nicht.
- **SameModeGroup-Phantom:** Govee `/user/devices` liefert App-Gerätegruppen als Pseudo-Geräte; `BaseGroup` wird unterstützt, `SameModeGroup` wird an `mergeCloudDevices` geskippt (sonst steuerloses Phantom-Licht) + One-Shot-`delObject`-Cleanup für Altlasten.
- **Sensor-Temperatur ist immer °C:** App-API `lastData.tem` = °C-Hundertstel (`/100`); `settings.fahOpen` kippt nur die App-Anzeige (display-only), nicht den Wert. OpenAPI `sensorTemperature` ist oft leer → App-API ist der zuverlässige Pfad.

## Tests

One vitest suite per Modul (`src/**/*.test.ts`), jede mit einem „Drift"-Block gegen malformed / non-string / null API-Payloads (inkl. der ganzen `handlers/`-Schicht). Ehrliche Coverage über `coverage.include: ["src/**/*.ts"]`; `main.ts` (integration-covered) + `test-helpers.ts` mit Begründung ausgenommen. Package + Integration unter `test/`. React-Komponente: `npm --prefix src-admin run test` (vitest + jsdom). Aktuelle Zahlen: `npx vitest run`.

## Konkurrenz-Lage

Schwester-Adapter `iobroker.govee` ist veraltet (nur LAN, keine MQTT, keine Sensoren/Appliances). Diese Implementation ist die einzige Govee-Lösung im Latest-Repo mit voller Multi-Channel + ptReal + Wizard. Aufnahme-PR ioBroker.repositories#5824 MERGED 2026-06-06.
