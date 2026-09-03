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

| Bereich                                                                                | Primär           | Fallback                  |
| -------------------------------------------------------------------------------------- | ---------------- | ------------------------- |
| Lights-Steuerung (power, brightness, color_rgb, color_temperature, Segmente, Gradient) | LAN UDP          | Cloud REST = **Notfall**¹ |
| Music-Mode, Scene-Speed                                                                | LAN UDP          | keiner                    |
| Scene-/DIY-/Snapshot-Aktivierung                                                       | LAN UDP (ptReal) | Cloud REST (backup)       |
| Generic Capability                                                                     | Cloud REST       | —                         |
| Lights-Status: Discovery, devStatus, `info.online`, `info.ip`                          | LAN UDP          | —                         |
| Lights-Status: Status-Push, Segment-State-Echo                                         | AWS-IoT MQTT     | —                         |
| Cloud-Setup (Geräteliste+Capabilities, Scene-Library, Snapshot-BLE, Snapshot-Liste)    | Cloud REST       | —                         |
| Group-Members                                                                          | App-API          | —                         |
| Sensor-Werte (Temp/Hum), Battery                                                       | App-API          | —                         |
| Appliance-Events                                                                       | OpenAPI-MQTT     | —                         |
| Appliance-Steuerung                                                                    | Cloud REST       | —                         |
| Appliance `info.online`                                                                | App-API          | OpenAPI-MQTT              |

¹ **Notfall-Fallback** — nur wenn lokale API nicht aktiviert (`lanIp === null`). 5–10 s Latenz pro Call, 10/min Rate-Limit. Adapter warnt beim Start („LAN ✗") mit Anleitung zur LAN-Aktivierung.

## Credential-Stufen (graceful degradation)

| Eingabe          | Funktionsumfang                                                    |
| ---------------- | ------------------------------------------------------------------ |
| Nichts           | LAN-only: Discovery, Power, Brightness, Color, Status              |
| + API Key        | + Geräteliste mit Namen, Capabilities, Szenen, Snapshots, Segmente |
| + Email/Passwort | + Echtzeit Status-Push via AWS-IoT-MQTT                            |

Der Account-Login (Email/Passwort) läuft NUR, wenn beide Felder gesetzt sind (getrimmt) — sonst kein Login-Versuch (`main.ts`, Guard `hasAccountCreds`).

## Architektur

`main.ts` = Lifecycle + Wiring; die Arbeit liegt in `src/lib/`. Vier Aufteilungen sind nicht offensichtlich:

- **`src/lib/handlers/`** — entlastet `main.ts`, ein File je Zuständigkeit: `cloud-creds-handler`, `cloud-retry-handler`, `cloud-state-loader`, `connection-state`, `device-events`, `diagnostics-handler`, `dropdown-reset-helpers`, `group-fanout-handler`, `snapshot-handler-glue`, `state-change-router`, `wizard-handler`. Jeder Handler deklariert seine Adapter-Schnittstelle (`XxxAdapter`); `main.ts` erfüllt sie **einmal** über `buildHost()` (Typ `AdapterHost` = Schnittmenge aller Handler-Verträge, Getter/Setter über die privaten Felder) und reicht dieses Host-Objekt weiter — nie `this`. Die Adapter-Felder sind privat; ein Handler bekommt nur, was sein Vertrag nennt (gleiches Muster wie `WizardHost`/`SnapshotHandlerHost`/`GroupFanoutHost`). `cloud-creds-handler` persistiert MQTT-Creds als **verschlüsselte Datei im Instanz-Datenverzeichnis** (wie SKU-Cache) — bewusst KEIN `meta.user`, weil re-derivierbarer Cache keinen sichtbaren Objektbaum-Knoten braucht.
- **`src/lib/device-manager/`** — Sub-Files für Cloud-Merge (`cloud-merge`), Cache (`cache`), Library-Loading (`library-loader`), Reconcile (`reconciler`) sowie die reinen `lookups.ts` + `mapping.ts`, die dadurch direkt testbar sind. Keine Re-Exports über `device-manager.ts` — Konsumenten importieren aus dem Sub-File.
- **Geräte-Katalog pro Instanz:** `DeviceRegistry` wird in `onReady` gebaut (mit dem `experimentalQuirks`-Schalter DIESER Instanz) und an StateManager, DeviceManager, CommandRouter, DiagnosticsCollector, `capability-mapper` und `device-events` gereicht. **Kein modulweiter Einzelwert** — im Kompaktmodus teilen sich mehrere Instanzen einen Prozess, und ein geteilter Katalog ließ die zuletzt gestartete Instanz den Experimentell-Schalter für alle bestimmen.
- **Die vier API-Clients:** `govee-cloud-client` (Cloud-REST v2, API-Key) · `govee-mqtt-client` (AWS-IoT, Account-Login) · `govee-openapi-mqtt-client` (Cloud-Events, API-Key) · `govee-lan-client` (UDP) · `govee-api-client` (App-API app2.govee.com). Beide MQTT-Clients erben Reconnect/Backoff aus `reconnecting-mqtt-client`.

`src-admin/` ist eine eigenständige Module-Federation-React-Komponente (Vite, Vorbild `iobroker.public-holidays`) → baut nach `admin/custom/customComponents.js` (git-getrackt, via `files[]` im Tarball; Bau läuft als Master-Release-Schritt `npm run --if-present build:admin`, Hand-Veröffentlichung nur via `npm run publish:manual` — kein `prepublishOnly` mehr seit dem W0095-Umbau 2026-09-01). Eigene i18n mit `gsw_`-Keys, 11 Sprachen. Enthält `SegmentWizard`/`SegmentGrid`/`useWizardApi` + `SegmentWizardConfig` (Module-Federation-Mount).

## State Tree

Ordnername = immer `sku_shortid` (z.B. `h61be_1d6f` = SKU + letzte 4 Hex der Device-ID). Cloud-Name **nur** in `common.name` — der Ordner bleibt stabil, wenn der User das Gerät in der App umbenennt.

Geräte unter `devices/`, Gruppen unter `groups/`. Pro Gerät fünf Channels: `control`, `scenes`, `music`, `snapshots`, `info`, dazu dynamisch `segments`. Gruppen bekommen nur die Fan-Out-fähige Teilmenge (kein Snapshot, keine Diagnostics). **Alle States haben `def`** in der StateDefinition und werden beim Erstellen initialisiert (keine null-Werte).

## Online-Kennzeichnung + Summen (ab 2.27.0)

Das Symbol am Geräte-Knoten kommt aus `common.statusStates` → `<gerät>.info.online`, **nicht** aus `info.connection`. Damit es beim Abschalten stimmt, braucht es **vier** Teile (allgemeine Herleitung: `Entwicklung/CLAUDE_CODING.md`): kein `supportedMessages.stopInstance` im Manifest (sonst läuft `onUnload` NIE) · `clearStopInstanceFlag()` als Erstes in `onReady` mit sofortigem `return`, und nur schreiben wenn gesetzt (sonst Neustart-Schleife) · `onUnload` meldet erst nach den Schreibvorgängen fertig (`.finally(callback)`) · Start-Stempel `markAllOffline()` vor dem ersten Scan, der einzige Teil, der nach Absturz/Stromausfall greift.

**Die drei Summen** (`info.devicesTotal`/`devicesOnline`/`devicesAllOnline`) reiten auf derselben 20-s-Runde, die die Einzelnen neu bewertet, und lesen dafür **nichts** aus der Datenbank zurück (`resolvedOnline` + `onlineMarkerCache`; der Cache wird nur beim Kaltstart per Scan gefüllt und danach von jedem Anlegen/Migrieren/Entfernen gepflegt). Nur `devices.*` zählt (App-Gruppen sind keine physischen Geräte) · `devicesAllOnline` verlangt `total > 0` · `devicesTotal` bleibt beim Abschalten stehen · `clearDeviceRollup()` legt nichts an, sonst bekäme eine frische Installation eine Summe, die sie nie hatte.

## Erreichbarkeit — Beweis oder nichts (ab 2.29.1)

`resolveDeviceReachability(device, cloudOnline)` (`device-manager/lookups.ts`) beantwortet „ist das Gerät erreichbar" für **jede** Geräteart. Es gibt genau drei Beweise, in dieser Reihenfolge: **LAN-Lampe** → die LAN-Antwortfrische (`LAN_REPLY_FRESHNESS_MS` 90 s, sonst nichts — Govees Cloud-Zwischenspeicher hinkt hinterher, Messung 2026-05-13). **Govee hat gemeldet** (`state.cloudReportedOnline`, gesetzt von `applyOnlineCap` aus App-Abruf, Konto-Push UND — seit 2.29.1 — dem Cloud-Zustandsabruf) → sein Wort, in beide Richtungen. **Sonst** → nicht erreichbar.

**Es gibt bewusst KEINE Ableitung aus dem Kanal.** 2.29.0 hatte eine („die Cloud antwortet und das Konto führt das Gerät") — das ist eine Aussage über das KONTO, nicht über das Gerät: auf krobis Anlage wurden zwei stromlose Streifen als erreichbar gemeldet. Ein falsches Grün ist schlimmer als ein falsches Grau, weil es niemandem auffällt.

**Die eigentliche Lücke war eine weggeworfene Quelle:** `/device/state` liefert Govees Erreichbarkeit mit, aber `mapCloudStateValue` hat keinen `online`-Zweig — die Fähigkeit fiel in den Standardfall und niemand sonst sah sie an. Deshalb hatte ein Gerät ohne lokale Schnittstelle überhaupt keinen Beweis. `cloud-state-loader` reicht die Antwort jetzt zusätzlich an `DeviceManager.applyCloudStateOnline`.

**`proven` ist der zweite Rückgabewert:** eine GEHÖRTE Erreichbarkeit darf in beide Richtungen ins Gerät zurückgeschrieben werden, eine unbewiesene nie. Ein unbewiesenes `false` zurückzuschreiben war der ursprüngliche Dauerdefekt — der Zwischenspeicher startet jedes Gerät offline, und die 20-s-Runde zementierte diese Unwissenheit als Messwert.

**`info.connection` folgt einer ANDEREN Regel und darf nicht angeglichen werden** (v2.13.0-Vertrag): der Datenpunkt beantwortet „arbeitet der Adapter", nicht „ist das Gerät da". Eine cloud-only Lampe hält ihn grün, solange die Cloud steht — 2.29.0 hat beide zusammengelegt und damit beide falsch gemacht. `groups.info.online` ist ebenfalls kein Erreichbarkeits-Marker, sondern die Cloud-Verbindung (i18n `cloudOnline`).

## Diagnose-Bericht = Datei, anonymisiert (ab 2.29.0)

Der Bericht ist das Ferndiagnose-Werkzeug (Anspruch: `feedback_diag_system_self_service`). Bis 2.28.0 lag er als Text in `diag.result` — bei einem H61BE **67.917 Zeichen**, über GitHubs Issue-Grenze und als Zustandswert eine Last für Datenbank und History-Abos.

- **Ablage:** Meta-Objekt `<namespace>.diagnostics` (Bauart wie `snapshots`), `diag.lastExport` nennt die Datei, `diag.result` ist weg — ausdrücklich in `migrateLegacyDiagnostics` entfernt, weil `cleanupCloudOwnedStates` den Kanal `diag` nicht verwaltet. `DIAGNOSTICS_KEEP_PER_DEVICE` = 3.
- **Dateiname erklärt sich selbst:** `govee-smart_<SKU>_<kurz-id>_v<version>_<datum>_<zeit>.json`.
- **Anonymisierung** (`anonymiser.ts`): gleichbleibende Marken statt Schwärzung, sonst ist „reden diese zwei Zeilen vom selben Gerät" nicht mehr beantwortbar. **Reihenfolge zwingend: schwärzen → anonymisieren → kappen** — die Größenbegrenzung macht eine flache Zeichenkette daraus. Falle: nur acht volle Gruppen oder `::` sind IPv6; „zwei oder mehr Hex-Gruppen" machte aus `AA:BB:CC` eine Adress-Marke.
- **Inhalt über 2.28.0 hinaus:** ioBroker-Umfeld, echter Objektbaum des Geräts (strikt EIN Präfix, kein Instanz-Scan), Gesamtlage, Befehlswirkung (`commandResults`), Segment-Herkunft. `generate()` ist dadurch asynchron.
- **Admin-Karte „Diagnose"** (`src-admin/DiagnosticsPanel`): Gerät wählen, ein Knopf, Browser-Download. Liste bewusst UNGEFILTERT — gebraucht wird der Bericht, wenn ein Gerät klemmt.

## Cloud REST API v2

**Base URL:** `https://openapi.api.govee.com` · **Auth:** Header `Govee-API-Key: <key>`

- Rate Limits: 10/min/Gerät, 10.000/Tag — **Appliances aber nur 100/Tag (!)**. Der `rate-limiter` deckt beides ab: die Minute über ein globales Dach von 8 (immer unter den 10/min eines einzelnen Geräts), den Tag zweigleisig — 9.000 global PLUS ein eigenes Tagesbudget je Appliance (90). Das Gerätebudget wandert **nicht** in die Warteschlange: es setzt sich erst beim Tageswechsel bei Govee zurück, ein wartender Befehl liefe also Stunden später los. Warum überhaupt nötig: Appliance-Steuerung hat keinen lokalen Weg, jede Schreiboperation ist ein Cloud-Aufruf, und ohne Gerätekonto könnte EIN Gerät die 9.000 des Kontos verbrauchen. Der Adapter selbst tut das nie (kein periodischer Geräte-Poll) — ein Skript schon.
- Unit-Normalisierung: `unit.percent` → `%`, `unit.kelvin` → `K`, `unit.celsius` → `°C`.
- **HTTP 200 mit leerem Body ≠ Fehler:** undokumentierte Govee-Endpoints liefern für unbekannte SKUs HTTP 200 mit leerem Body. `httpsRequest` resolvet das als `null` statt zu werfen; Caller mit `resp?.data?.…` + `Array.isArray`-Guards bekommen es transparent. Nur non-empty non-JSON bleibt Parse-Error.
- **429 RATE_LIMIT:** `classifyError` hat einen expliziten Branch auf `statusCode === 429` (nicht nur Message-Match), sonst zeigt der Ready-Hint die generische statt der Rate-Limit-Meldung.
- **Cloud-Retry-Loop:** `cloud-retry.ts` — `CloudLoadResult`-Union (`ok`/`transient`/`rate-limited`/`auth-failed`). `auth-failed` stoppt permanent (User muss API-Key fixen), `rate-limited` wartet den server-`Retry-After` (mit Floor), `transient` 5 min. Cloud-Init via `Promise.race` mit 60-s-Timeout.

## App-API (app2.govee.com — internal)

Die interne App-API liefert, was die öffentliche OpenAPI nicht kann: **Sensor-Werte, Gruppen-Mitglieder, Scene-/Music-Libraries.** Auth teils via Bearer-Token aus dem MQTT-Login, teils public (Scene-Library braucht KEINE Auth, nur AppVersion + User-Agent-Header).

- Sensor-Werte (z.B. H5179): OpenAPI v2 `/device/state` liefert `[]` → Werte kommen aus App-API `POST /device/rest/devices/v1/list` → `deviceExt.lastDeviceData`. App-API-Poll alle 2 min.
- Scene Library: `GET /appsku/v1/light-effect-libraries?sku=<SKU>` (public) → `sceneCode` für ptReal BLE-over-LAN.

## AWS IoT MQTT (Echtzeit-Status-Push)

Auth-Flow, Header und Topics: `Ressourcen/govee-smart/mqtt-aws-iot.md` — hier nur, was den Adapter betrifft. **Wir sind subscribe-only für Status** (Befehle gehen über LAN/ptReal/Cloud).

**Login-Sturm-Schutz (#39, Konto-24h-Sperre):** globales Cap `MQTT_MAX_AUTH_FAILURES = 3`. Jeder Versuch, der Govee **erreicht** und abgelehnt wird, zählt (`reachedGovee = category ≠ NETWORK ≠ TIMEOUT`); reine Netz-/Timeout-Fehler laufen ungedeckelt, weil sie das Konto nicht belasten. Der Zähler wird **ausschließlich bei erfolgreichem Subscribe** zurückgesetzt — sonst umgeht ein Wechsel aus Ablehnung + Netz-Blip das Cap. `refreshBearerSilently` ist ein zweiter Login-Pfad und bailt bei ausgeschöpftem Cap. Klassifizierung: Credential-Fehler → dauerhafter Stopp · 2FA (454/455) → Reconnect pausiert bis User-Code (454 = „neuer Client, einmalig verifizieren", nicht „2FA aktiviert"; Code-Anforderung mit 30-s-Drossel gegen Email-Spam) · Rate-Limit/Locked/Abnormal → zählt aufs Cap.

**Cert-Reuse:** persistierte Zugangsdaten (Bearer + P12) überleben Neustarts (`tryPersistedReuse`) → kein 2FA-Email-Sturm; abgelaufener Cert fällt auf frischen Login zurück. **MQTT vor Cloud** starten, damit die Szenen-Bibliothek beim ersten `loadFromCloud` da ist.

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
- **Segment-Count Single-Source-of-Truth:** `resolveSegmentCount(device, registry)` ist DIE eine Funktion. Priorität: **`segmentCount`-Quirk (harter Override)** → `device.segmentCount` (Cache/MQTT/Wizard) → **Min** über positive `segment_color_setting`-Caps → 0. **Jede Quelle läuft durch `plausibleSegmentCount` (1..56, die Bitmaske adressiert nicht mehr):** Cache-Datei, Cloud-Capability (`elementRange.max`), MQTT, Wizard-`apply`, Manual-Liste (`plausibleSegmentIndices`) — ein überhöhter Wert hätte sonst so viele Kanäle gebaut und den Adapter blockiert. **Gesetzt wird die Zahl nur an einer Stelle:** `DeviceManager.syncSegmentCount(device)` (= `effectiveSegmentCount` inkl. Manual-Liste) schreibt `device.segmentCount`; `StateManager.createSegmentStates(device, count)` baut den Baum für die übergebene Zahl und verändert das Gerät nicht. Warum Min: Govee meldet Brightness + ColorRgb separat und sie widersprechen sich (H70D1: 10 vs 15, echt ist 10). **MQTT-AA-A5 ist für die Anzahl autoritativ — hoch UND runter (Issue #44):** ein `complete`-Push (das Gerät hat seine Liste beendet, erkennbar am abgeschnittenen End-Padding) senkt eine zu hoch gemeldete Cloud-Zahl (H6076: 15→7); ein unvollständiger Push (am 20-Slot-Parser-Limit gekürzt) bleibt grow-only, damit ein >20-Segment-Streifen nie fälschlich auf 20 gekürzt wird. `parseMqttSegmentData` gibt `{segments, complete}` zurück; Padding = trailing all-null ODER unmögliche Helligkeit >100 (H6076 füllt den 8. Slot mit 0x92=146). Callback `onSegmentCountChanged` (reconciliert beide Richtungen via `createSegmentStates` → `cleanupExcessSegments`). Jede Änderung sofort im SKU-Cache persistiert.
- **MQTT Segment State-Sync:** `parseMqttSegmentData()` dekodiert AA-A5-BLE-Pakete → Per-Segment Brightness+RGB; nur bei `segmentCount > 0` und nur im Gradient/Color-Modus (Scene/Music liefert keine AA-A5).
- **Echo-Cap defensive:** BLE-Paket-Echos können Indices oberhalb des echten `segmentCount` enthalten → `onSegmentBatchUpdate` + `onMqttSegmentUpdate` filtern `if (cap === 0 || idx >= cap) continue;` (sonst Schreiben in nicht-existierende States → WARN-Spam).
- **Manual Segments** (`manual_mode` + `manual_list`) für gekürzte Cut-Strips: `parseSegmentList()` akzeptiert `"0-9"`, `"0-8,10-14"`, Kommas, Whitespace; validiert gegen `segmentCount-1`, Backstop 0-99. `parseSegmentBatch "all"` und der MQTT-Filter honorieren `manualSegments`.
- **Segment Detection Wizard (React seit v2.21.0):** misst die echte Strip-Länge unabhängig von der Cloud (bis Protokoll-Limit 55 oder User-Abbruch), erkennt Lücken. In-Memory-Session, Baseline-Capture, 5-Min-Idle-Timeout, globaler Session-Lock. React-Komponente (`src-admin/`) statt jsonConfig-Button. Backend-Antworten sind **knapp**: `snapshot` (Grid) + Flags `active`/`done`/`aborted`/`applied`/`error` — die React-Karte trägt ihre eigenen Texte. Aktionen: `start` · `yes` · `no` · `apply(indices)` (Finalizer mit der im Review korrigierten Karte, Indizes auf 0..55 gefiltert) · `abort`; am Protokoll-Limit finalisiert `finish()` von selbst. Das frühere `done` und die Schritt-Prosa (`message`/`progress`) sind seit 2.28.0 weg.

## Geräte-Katalog & Quirks

`devices.json` (Schema `devices.schema.json`, Validierung `npm run validate-devices`) — pro SKU `name`/`type`/`status`/`since` + optionale `quirks`. `device-registry.ts` lädt es, korrigiert per-SKU.

- **Status:** `seed` (extern importiert, ungetestet) · `reported` (1 User mit Diagnose) · `verified` (mehrfach/krobi-Hardware). Wiki-Geräte-Liste wird per `npm run gen-wiki` aus `devices.json` erzeugt (Icons ⚪/🟢/✅).
- **Quirk-Familien (4):** **Range-Override** (`colorTempRange` → `capability-mapper.ts:applyColorTempQuirk`) · **Boolean-Flag** (`brokenPlatformApi` → `buildCloudStateDefs` skippt Cloud-Cap-Mapping, fällt auf LAN-Defaults zurück) · **Map-Override** (`transportOverrides` → `command-router.ts:resolveTransport`; erzwingt Cloud/LAN pro Command; auf cloud-only ein No-op) · **Number-Override** (`segmentCount` → `resolveSegmentCount`; harter Override einer falsch gemeldeten Segment-Anzahl, überstimmt Cloud/Cache/MQTT; dormant — für cloud-only-Geräte ohne AA-A5-Selbstkorrektur, LAN/MQTT-Geräte heilen sich selbst).
- **Nicht-Quirks:** `manualMode`/`manualSegments` (Runtime-User-Setting), Identitäts-/Metadatenfelder, Per-User-Defaults → jsonConfig.
- **Neues Quirk verdrahten:** Interface erweitern → `devices.schema.json` (`additionalProperties:false`) → Konsumstelle → `devices.json`-Eintrag mit `since` → Test in `device-registry.test.ts` + Konsumstelle.
- **Diagnostics Export:** Button pro Gerät (`diag.export`) erzeugt strukturiertes JSON (Capabilities, Szenen, Libraries, Quirks, State, recentLogs, lastMqttPackets, runtimeState) für GitHub-Issues.
- **govee-appliances ist DEPRECATED** seit v2.0.0 (in govee-smart gemerged, Repo archiviert). Falls Code-Pfade noch von „Koexistenz" reden — Legacy.

## Admin UI

Single Page: **1.** LAN (immer aktiv) · **2.** Cloud API (optional, API Key → Szenen/Segmente/Namen) · **3.** Govee Account (optional, Email+Passwort → Echtzeit-Push) · **4.** Donation. Plus die React-Segment-Wizard-Komponente (eigener Tab, Module Federation).

**`admin/i18n/*.json` hat einen zweiten Konsumenten:** `Entwicklung/scripts/sync-iopackage-from-i18n.py` (Release-Gate) schreibt die `common.name`/`desc` der `instanceObjects` aus den Keys `information`, `infoConnection`, `infoMqttConnected`, `infoCloudConnected`, `infoOpenapiMqttConnected(Desc)`, `devicesFolder`, `groups`, `localSnapshotsFolder`, `infoManualSyncDevices(Desc)`. Ein grep über `src/` + `admin/` findet sie NICHT — sie sind trotzdem in Gebrauch (2.28.0: versehentlich entfernt, Gate hat es gefangen). Wird ein `instanceObjects`-Datenpunkt umbenannt, muss die Zuordnung im Skript mitziehen. Die Konto-E-Mail wird **getrimmt** verwendet — beim Karten-Test UND beim Start-Login (`accountEmail` in `onReady`); das Passwort bleibt roh (Leerzeichen können dazugehören).

## Design-Prinzipien (govee-spezifisch)

Die tragenden stehen oben in ihren eigenen Sektionen (LAN-first, Kanal-Priorität, Credential-Stufen, Erreichbarkeit, Segmente, Szenen). Hier nur, was man dem Code **nicht** ansieht:

1. **Error-Dedup** — `classifyError()` + `lastErrorCategory` (DeviceManager, MQTT, Cloud): warn beim ersten/neuen Kategorie-Wechsel, danach debug, Recovery-Meldung bei Wiederherstellung.
2. **Ready-Summary ohne Per-Device-Zahlen** — `checkAllReady()` prüft MQTT+Cloud, Safety-Timeout 60 s. Jedes `✗` bekommt eine WARN mit konkretem Grund. Bewusst keine Gerätezahlen: zur Ready-Zeit settlen LAN-Scan und Push noch.
3. **SKU-Cache** (`sku-cache.ts`) — nach dem ersten Start null Cloud-Aufrufe nötig. `scenesChecked` verhindert Endlos-Refetch bei legitim leeren Szenen; `pruneStale(14)`. `save()` ist asynchron (Temp-Datei + Flush + Rename, je Datei serialisiert) und überspringt byte-gleiche Inhalte — das frühere synchrone `fsyncSync` blockierte den Ereignis-Loop je Gerät.
4. **Diagnose-Puffer sind BYTE-begrenzt** (`diagnostics.ts`): 512 KB API-Historie je Gerät (älteste Einträge zuerst), 4 KB je MQTT-Umschlag, 16 KB je LAN-Payload. Zähl-Limits allein ließen >10 MB je Gerät zu.
5. **Dropdowns sind `type: "mixed"`** mit eindeutiger `common.states`-Map (`buildUniqueLabelMap`, `(2)`-Suffix bei Duplikaten); `resolveDropdownInput` löst Zahl/Zahl-Text/Klartext groß-klein-egal auf den kanonischen Schlüssel. **Warum `mixed`:** unterdrückt den js-controller-Typ-Check, der sonst bei Zahl-Schreibung ins Log schreibt. **Warum `role: "state"`:** `level.effect` erzwänge `type:"string"` und würde die gewollte Zahl-Eingabe loggen.

## Bekannte Fallstricke (govee-spezifisch)

- **Manifest-Objekte erreichen eine BESTEHENDE Anlage nur per `extendObject`.** js-controller legt `instanceObjects` nur an, wo sie fehlen — ein geänderter Name landete bis 2.29.0 ausschließlich bei Neuinstallationen, während Manifest und Namens-Gate grün aussahen. `ensureManifestObjects()` in `onReady` frischt alle elf auf, **je ein ausgeschriebener Aufruf**: eine Schleife über eine Tabelle wäre kürzer und würde verbergen, welche Objekte erreicht werden — vor dem Leser wie vor dem Konsistenz-Gate, das den wörtlichen Aufruf sucht.
- **Namen mit laufender Nummer:** `tNameWith(key, n)` statt `tName` — `getTranslatedObject` ersetzt `%s` je Sprache, aber **nur wenn der ENGLISCHE Text den Platzhalter trägt**, und **genau einer** ist zulässig (adapter-core setzt je Argument wieder am Ursprungstext an, ein zweiter überschriebe den ersten).

- **No-Channel Init-Race:** Cloud-only-Geräte direkt nach Restart — Cloud-Client noch null → „No channel available" ist Fehlalarm. Fix: `channels.cloud === true && cloudClient === null` → debug + still verworfen. WARN nur bei permanent fehlendem Channel.
- **Abonnements:** `devices.*` + `groups.*` + **explizit `info.manualSyncDevices`** — der Knopf liegt außerhalb beider Muster und war von 2.17.0 bis 2.27.1 tot (nie abonniert, Test pinnte die zwei Muster). Ein neuer Datenpunkt unter `info`, den der Nutzer schreibt, braucht sein eigenes Abonnement.
- **Synthetische Sensor-/Event-States** haben seit 2.28.0 **EINEN Namen** je Messwert, egal welcher Pfad ihn liefert: `canonicalSyntheticId` (capability-mapper) macht aus `sensorTemperature` → `temperature`, `carbonDioxide` → `co2`, `lackWaterEvent` → `lack_water_event`; `SYNTHETIC_STATE_META` kennt nur noch diese Schreibweise. Migration = kein Code: die alten Objekte (`sensor.sensor_temperature`, `events.lackwater`) sind keine synthetischen Ids mehr und fallen beim ersten Cloud-Rebuild als „stale" aus `cleanupCloudOwnedStates`. Die States (`SYNTHETIC_STATE_META`, App-API/Cloud-Events-Pfad) sind **Fremdbesitz** für die Cloud-Phase: `cleanupCloudOwnedStates` lässt sie stehen (sie tauchen in keiner Cloud-State-Def auf und wurden früher bei jedem Rebuild gelöscht + vom nächsten Poll neu angelegt). Ihre Objekte werden einmal je Lauf angelegt (`ensuredStates`); jeder Löschpfad wirft die Ids aus dem Cache.
- **Fehlerklassifizierung (`classifyError`):** strukturierte Felder zuerst (`statusCode` 401/403/429, mqtt-Reason-Codes 4/5), Textmarker nur als WÖRTER. Der frühere Teilstring-Abgleich auf „auth"/„401" traf den 100-Zeichen-Body-Ausschnitt einer Govee-Wartungsseite → Cloud-Retry dauerhaft gestoppt + „API-Schlüssel prüfen".
- **Gruppen-Fan-out** sendet an Cloud-only-Mitglieder unabhängig vom (bekannt flackernden) Cloud-Online-Kennzeichen; nur LAN-Lampen werden am Kennzeichen (LAN-Reply-TTL) übersprungen.
- **Capability-Fallback ohne stale-Guard (Issue #13):** bei zwei Quellen für User-Content darf der Fallback NIE auf „nur wenn Cache leer" gegated sein, sonst kommen neue App-Snapshots nie rein. Richtig: primary-empty → secondary ohne Guard; primary-**error** → Cache lassen (transient).
- **Per-Device Button > globaler Button:** Refresh gehört pro Gerät unter den Channel, nicht auf Adapter-Ebene (5 statt N×5 API-Calls, User klickt dort, wo das Resultat erscheint). Thermometer/Sensor/Heater bekommen den Button gar nicht.
- **SameModeGroup-Phantom:** Govee `/user/devices` liefert App-Gerätegruppen als Pseudo-Geräte; `BaseGroup` wird unterstützt, `SameModeGroup` wird an `mergeCloudDevices` geskippt (sonst steuerloses Phantom-Licht) + One-Shot-`delObject`-Cleanup für Altlasten.
- **Sensor-Temperatur ist immer °C:** App-API `lastData.tem` = °C-Hundertstel (`/100`); `settings.fahOpen` kippt nur die App-Anzeige (display-only), nicht den Wert. OpenAPI `sensorTemperature` ist oft leer → App-API ist der zuverlässige Pfad.

## Tests

One vitest suite per Modul (`src/**/*.test.ts`), jede mit einem „Drift"-Block gegen malformed / non-string / null API-Payloads (inkl. der ganzen `handlers/`-Schicht). Ehrliche Coverage über `coverage.include: ["src/**/*.ts"]`; ausgenommen ist nur noch `test-helpers.ts` (Test-Gerüst). Package + Integration unter `test/`. React-Komponente: `npm --prefix src-admin run test` (vitest + jsdom). Aktuelle Zahlen: `npx vitest run`.

**`main.ts` ist unit-getestet** (`src/main.test.ts`) — die frühere Coverage-Ausnahme „integration-covered" war falsch: der mocha-Integrationstest prüft genau eine Sache („der Adapter startet") und taucht im vitest-Report gar nicht auf, `main.ts` stand real bei 0 %. Der Harness stubbt `@iobroker/adapter-core` mit einer Adapter-Basisklasse samt In-Memory-Objekt-/State-/File-Store, sodass StateManager, DeviceManager, SkuCache und LocalSnapshotStore ECHT laufen; ersetzt werden nur die netzseitigen Kollaborateure über die `make*Client`-Fabrik-Seams in `main.ts` (`makeLanClient`, `makeMqttClient`, `makeOpenapiMqttClient`, `makeCloudClient`, `makeApiClient`, `makeRateLimiter`). Jeder Test bekommt über `beforeEach` ein eigenes Instanz-Datenverzeichnis — SKU-Cache und Credentials-Datei liegen dort, ein geteiltes Verzeichnis macht Tests reihenfolgenabhängig.

`httpsRequest` nimmt einen optionalen `transport` (Default `node:https` + Keep-alive-Agent); die Tests fahren damit den ECHTEN Produktivcode über `node:http` gegen einen lokalen Stub-Server. Vorher lag in der Testdatei eine ~80-zeilige Kopie der Implementierung — sie war bereits abgedriftet und hätte einen Fehler im Produktivcode nicht bemerkt.

**Drei Test-Nahtstellen aus dem Test-Audit 2.28.0:** der LAN-Client-Test ersetzt `node:dgram` durch eine Attrappe, die jede Sendung (`sends`) und einen einstellbaren Sendefehler (`sendError`) aufzeichnet — damit sind UDP-Sendeweg, Discovery-Schleife und Socket-Verdrahtung geprüft, nicht nur der Parser. Der SKU-Cache-Test stubbt `node:fs` mit `failNextOpen` (fehlgeschlagener Schreibvorgang, überlappende Saves, unbrauchbares Verzeichnis). Im HTTP-Client-Test muss ein Abbruch mitten im Body vom Stub-Server mit `content-length` und verzögertem Socket-Destroy simuliert werden — ohne den Header endet der Request regulär und `res.on("error")` ist nie der einzige Ausgang; eine entfernte Fehlerbehandlung bliebe unbemerkt.

## Konkurrenz-Lage

Schwester-Adapter `iobroker.govee` ist veraltet (nur LAN, keine MQTT, keine Sensoren/Appliances). Diese Implementation ist die einzige Govee-Lösung im Latest-Repo mit voller Multi-Channel + ptReal + Wizard. Aufnahme-PR ioBroker.repositories#5824 MERGED 2026-06-06.
