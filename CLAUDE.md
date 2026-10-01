# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis (Patterns, Coding-Regeln, Release/CI, Repochecker): `../CLAUDE.md` + `../CLAUDE_*.md`. **Hier steht nur govee-Spezifisches** als Regel mit Namen, Konstanten und Fallen. Belege, Messungen und Verlauf jeder Regel stehen in `.claude/dev-history.md` (lokal); der Wortlaut dieser Datei vor dem Regelsatz-Umbau im Eintrag „2026-10-01 — Aus CLAUDE.md verlegt“.

## Projekt

**ioBroker Govee Smart Adapter** — steuert Govee-WLAN-Geräte: Lichter (Strips, Lampen, Panels), Sensoren (Thermo-/Hygrometer, Luftqualität), Haushaltsgeräte (Heizer, Luftbefeuchter, Wasserkocher, Eiswürfelbereiter, Ventilator, Luftreiniger …). **LAN first** für Lichter, **App-API + OpenAPI-MQTT** für Sensoren/Haushaltsgeräte, **Cloud-REST** für Fähigkeiten und als Steuer-Rückfall.

- Version in `io-package.json`; Changelog in `README.md` + `io-package.json:common.news` (11 Sprachen, handgeschrieben); interne Historie `.claude/dev-history.md`.
- GitHub https://github.com/krobipd/ioBroker.govee-smart · npm `iobroker.govee-smart` · Runtime-Deps `@iobroker/adapter-core`, `mqtt`, `node-forge` · Wiki bilingual EN/DE (über `wiki.json` Teil der Release-Kette).
- Die APIs (LAN-Protokoll, AWS-IoT-MQTT, ptReal BLE-over-LAN, Scene-Speed, Segment-Erkennung, Snapshot-ptReal) sind größtenteils **undokumentiert**; Protokoll-Detail in `Ressourcen/govee-smart/`.

## LAN-first für Lichter

- Die LAN-Werte eines Lichts (`power`, `brightness`, `color_rgb`, `color_temperature`) überschreibt die Cloud NIE: `loadCloudStates` überspringt sie je Kennung (`device.lanIp && LAN_STATE_IDS`). Die Cloud-Instanzen heißen weiter `colorRgb`/`colorTemperatureK`.
- LAN-fähige Geräte bauen auf `getDefaultLanStates()`.
- Die Cloud liefert nur Fähigkeiten, Szenen, Snapshots, Schalter, Segmente und Sensor-Fähigkeiten.

## Kanal-Priorität je Operation

| Bereich                                                                                | Primär                                                                   | Rückfall                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Lichtsteuerung (power, brightness, color_rgb, color_temperature, Segmente, Gradient)   | LAN UDP                                                                  | Cloud REST, nur ohne lokale Schnittstelle¹           |
| Musikmodus, Szenen-Tempo                                                               | LAN UDP                                                                  | —                                                    |
| Szene/DIY/Snapshot aktivieren                                                          | LAN UDP (ptReal)                                                         | Cloud REST                                           |
| Generische Fähigkeit                                                                   | Cloud REST                                                               | —                                                    |
| Lichtstatus: Suche, devStatus, `info.online`, `info.ip`                                | LAN UDP                                                                  | —                                                    |
| Lichtstatus: Status-Push, Segment-Echo                                                 | AWS-IoT MQTT                                                             | —                                                    |
| Cloud-Aufbau (Geräteliste, Fähigkeiten, Szenen-Bibliothek, Snapshot-Pakete und -Liste) | Cloud REST                                                               | —                                                    |
| Gruppen-Mitglieder                                                                     | App-API                                                                  | —                                                    |
| Sensorwerte (Temperatur/Feuchte), Batterie                                             | App-API                                                                  | —                                                    |
| Haushaltsgerät-Werte (Modus/Stufe, Filter)                                             | eigener Status-Push, je Gerätefamilie dekodiert                          | `/device/state` beim Start · OpenAPI-MQTT-Ereignisse |
| Haushaltsgerät-Luftqualität                                                            | `/device/state` beim Start                                               | —                                                    |
| Haushaltsgerät-Ereignisse                                                              | OpenAPI-MQTT                                                             | —                                                    |
| Haushaltsgerät-Steuerung                                                               | Cloud REST                                                               | —                                                    |
| Haushaltsgerät `info.online`                                                           | App-API-Liste (2 min) · eigener Status-Push · `/device/state` beim Start | OpenAPI-MQTT                                         |

¹ Nur bei `lanIp === null`: 5–10 s je Aufruf, Govee-Budget 2/s je Gerät (Burst 6) und 12/s je Konto. Der Start warnt („LAN ✗“) mit Anleitung.

## Zugangsdaten-Stufen

Nichts → LAN (Suche, Ein/Aus, Helligkeit, Farbe, Status) · + API-Key → Geräteliste mit Namen, Fähigkeiten, Szenen, Snapshots, Segmente · + E-Mail/Passwort → Echtzeit-Push über AWS-IoT-MQTT. Die Stufen sind unabhängig wählbar.

- Der Konto-Login läuft nur mit beiden Feldern; die Regel steht EINMAL in `src/lib/account-credentials.ts` (`accountEmail` getrimmt, `hasAccountCredentials` prüft das Passwort getrimmt, verwendet wird es roh).
- Der 2-Minuten-Takt der App-API hängt an `apiKey || hasAccountCreds` (er läuft auf dem Konto-Token). Sensorwerte erreicht er nur für Geräte, die der Adapter schon kennt: `pollAppApi` legt keine an, Sensoren kommen allein über die Cloud-Liste oder ihren Cache.

## Architektur

`main.ts` = Lebenszyklus + Verdrahtung; die Arbeit liegt in `src/lib/`.

- **`src/lib/handlers/`** — ein Modul je Zuständigkeit: `account-handler`, `cloud-creds-handler`, `cloud-retry-handler`, `cloud-state-loader`, `app-version`, `connection-state`, `device-reaper`, `device-events`, `diagnostics-handler`, `dropdown-reset-helpers`, `group-fanout-handler`, `legacy-cleanup`, `music-command`, `online-sync`, `snapshot-handler-glue`, `state-change-router`, `wizard-handler`. Handler rufen einander per Import, nie über eine Host-Methode von `main.ts`. Jeder deklariert seinen Vertrag (`XxxAdapter`); `main.ts` erfüllt alle EINMAL über `buildHost()` (`AdapterHost` = Schnittmenge, Getter/Setter auf private Felder) und reicht nur dieses Objekt weiter, nie `this`.
- **`src/lib/device-manager/`** — `cloud-merge`, `cache`, `library-loader`, `reconciler`, die reinen `lookups.ts` + `mapping.ts`. Keine Re-Exports über `device-manager.ts`.
- **Gerätekatalog je Instanz:** `DeviceRegistry` entsteht in `onReady` mit dem `experimentalQuirks`-Schalter DIESER Instanz und wird an StateManager, DeviceManager, CommandRouter, DiagnosticsCollector, `capability-mapper` und `device-events` gereicht — kein modulweiter Wert (Kompaktmodus teilt den Prozess).
- **Fünf API-Clients:** `govee-cloud-client` (REST v2, API-Key) · `govee-mqtt-client` (AWS-IoT, Konto) · `govee-openapi-mqtt-client` (Cloud-Ereignisse, API-Key) · `govee-lan-client` (UDP) · `govee-api-client` (App-API `app2.govee.com`). Beide MQTT-Clients erben Reconnect/Backoff von `reconnecting-mqtt-client`.
- **Importfreie Module, die `src-admin/` und `tools/` mitlesen:** `err-message.ts`, `auth-status.ts` (der `mqttAuth`-Vertrag), `device-catalog.ts` (Katalogwörter). `src-admin/vite.config.ts` braucht deshalb `dts: false` (sonst TS6059 und eine `.d.ts` neben der Quelle).
- `cloud-creds-handler` legt die MQTT-Zugangsdaten als verschlüsselte Datei ins Instanz-Datenverzeichnis, nicht in ein Objekt.

`src-admin/` ist eine Module-Federation-React-Komponente (Vite) → `admin/custom/` (git-getrackt). Den Bau fährt der Release-Vorlauf (Gate D05 `npm run build:admin`), die Artefakte gehen in den Release-Commit; von Hand nur `npm run publish:manual`. Eigene i18n mit `gsw_`-Schlüsseln (11 Sprachen); zwei Mounts: `ConnectionConfig` (Reiter Konfiguration) und `ExpertConfig` (Reiter Experte, Umschalter Assistent ODER Diagnose). `index.html` ist nur der Pflicht-Einstieg von Vite und lädt nichts.

## State Tree

- **Geräte-Id = `<sku>-<letzte 4>`** (`src/lib/device-id.ts`, wie yamaha/homeconnect); bei Kollision bekommt das zweite Gerät seine ganze Kennung, dann einen Zähler; `info` ist reserviert. Einmal vergeben, mit `native.idScheme = 3` markiert (`createInfoStates` schreibt die Marke), nie neu abgeleitet.
- **`DeviceIdRegistry` (`stateManager.deviceIds`) nennt jeden Baum** — `devicePrefix`, Mitgliederlisten, die Schutzliste des Aufräumers (Konstruktor von `DeviceManager`) und lokale Snapshots (Konstruktor von `LocalSnapshotStore`) bekommen sie als Pflicht-Parameter. SKU-Cache und Snapshot-Speicher schlüsseln nach der VOLLEN Kennung (`cacheKey`); `treeKey` findet nur noch Altlasten der 2.x-Namen.
- **`migrateDeviceIds`** (`device-id-migration.ts`) zieht unmarkierte Bäume einmal um, direkt nach `new StateManager`: Journal `native.movingTo`, `copyDeviceTree` (`device-move.ts`: Werte mit ack/ts/lc/q, `aliasId` = alte Id für Aufzeichnungen, Alias-Ziele), Löschen über den Flotten-Master `enum-carry.ts` (`moveAllWithEnums`) Id für Id, tiefste zuerst, Wurzel mit Journal zuletzt, nie rekursiv. Reste füllen nur (`fillOnly`). Ein gescheiterter Umzug bleibt die Sitzung unter alter Id (`keepUnmoved`); kann der Umzug die Geräteobjekte nicht lesen, startet der Adapter nicht. Jeder Start liest nur die Geräte-View.
- Cloud-Name nur in `common.name`; der Ordner bleibt beim Umbenennen in der App.
- Geräte unter `devices.`, Gruppen unter `groups.`. Jedes Gerät hat `info` und `diag`; `control`, `scenes`, `music`, `snapshots`, `segments` folgen aus den Fähigkeiten; Sensoren und Haushaltsgeräte tragen `sensor` und `events`. Gruppen nur `control`, `scenes`, `music`, `info`. Jeder Zustand hat ein `def` und wird beim Anlegen gesetzt.

## Online-Kennzeichnung, Summen, Start

- Das Symbol am Geräteknoten kommt aus `common.statusStates` → `<gerät>.info.online`, nie aus `info.connection`. Beim Abschalten tragen es die vier Flottenteile (`Entwicklung/CLAUDE_CODING.md`): kein `stopInstance`, `clearStopInstanceFlag()` zuerst in `onReady`, `onUnload` mit `.finally(callback)`, `markAllOffline()` vor dem ersten Scan.
- **Summen** `info.devicesTotal`/`devicesOnline`/`devicesAllOnline`: angelegt in `ensureDeviceRollupStates` (vor `markAllOffline`), geschrieben auf der 20-s-Runde aus `resolvedOnline` + `onlineMarkerCache` ohne Rücklesen. Nur `devices.*` zählt; `devicesAllOnline` verlangt `total > 0`; `devicesTotal` bleibt beim Abschalten stehen; `clearDeviceRollup()` legt nichts an.
- **Start in Phasen:** `prepareInstance`, dann `buildRuntime` · `wireRuntime` · `startLan` · `openAccount` · `connectAccount` · `startCloud` · `settleCloudStart` · `drainStateCreation` · `readStartState` · `runStartMigrations` · `finishStart`. EINE Prüfung `!(await phase()) || this.unloading` in der Schleife; Übergaben nur über `StartContext`, nie über neue Klassenfelder. Ein Id-Umzug, der nicht lesen kann, beendet den Start mit EINER Fehlerzeile.
- Die 20-s-Runde (`onlineSync.runOnlineSyncRound`) fängt im eigenen Körper, tut nach `onUnload` nichts und trägt auch `info.connection` (das Altern eines Beweises meldet sonst niemand).
- Eine Nachricht vor dem fertigen Nachrichten-Router bekommt `{ error: "Adapter is starting" }`.
- `info.name`/`info.model`/`info.serial` tragen die gleichnamigen Katalogrollen.

## Erreichbarkeit — Beweis oder nichts

`resolveDeviceReachability(device, now)` (`device-manager/lookups.ts`) ist die EINE Antwort für jede Geräteart; jeder Konsument fragt sie (Objektbaum, Geräteliste, Assistenten-Sperre, `groups.info.membersUnreachable`, Summen), nie `state.online` direkt. Stufen in dieser Reihenfolge:

1. **LAN-getrieben** (`isLanDriven`) → nur die LAN-Antwortfrische (`LAN_REPLY_FRESHNESS_MS` 90 s).
2. **Gateway tot** (`state.gatewayOnline === false`) → nicht erreichbar.
3. **Govee hat ausdrücklich gemeldet, frisch** (`cloudReportedOnline` + `cloudReportedOnlineAt` < `CLOUD_ONLINE_EVIDENCE_TTL_MS` 30 min) → sein Wort, beide Richtungen.
4. **Govee hat etwas geliefert** (`cloudLivenessAt`, gleiche Frist) → nur nach oben, verliert gegen jede Meldung.
5. Sonst nicht erreichbar.

- `isLanDriven` hängt an `lastLanSeenAt` (persistiert, gültig `LAN_CAPABLE_MEMORY_MS` 7 Tage), nicht an `lanIp` (wird je Start neu gesucht, `cache.ts` verwirft sie).
- **Konto-Push:** Pakettyp `cmd:"online"`, Auskunft in `state.connected` (Text) oder `state.result` (Zahl). `result` in `status`/`ptReal` ist ein Ergebniscode — die Feldform entscheidet (`readReportedReachability`), nie `pactType`; ein unbekannter Wert ist kein Beweis. Das `online`-Paket ist ein Ereignis: nicht über `applyOnlineCap`, sofort, ohne `devicePushAt`.
- **Eigene Stimme des Geräts:** ein `status`-Paket stempelt `devicePushAt` NUR mit der Zeit aus der `transaction`-Kennung (`readDevicePushAt`, `x_<13 Stellen ms><Zähler>`); ohne lesbaren Stempel kein Schild, `connected:"false"` stempelt nicht, ein zu alter Stempel beweist nichts. Solange er frisch ist (`isDevicePushFresh`), überschreibt ein abgefragtes `online:false` (Kontoliste, `/device/state`, OpenAPI-Ereignis — alle über `applyOnlineCap`) die Meldung nicht. Ein Abruf schildet nie gegen die Liste (falsches Grün ist schlimmer als falsches Grau).
- **Die Kontoliste meldet WLAN-Lichtern und Haushaltsgeräten konstant `false`** und bleibt trotzdem letzter Schreiber; was sie entkräftet, ist die **Statusanfrage** `GoveeMqttClient.requestStatus(topic, now, cmdVersion)` (`cmd:"status"`, `type 0`, `v_<ms>000`, QoS 0, auf `device.iotTopic`); die Antwort ist ein normales `status`-Paket. `DeviceManager.requestStaleStatuses()` fragt nach jedem Listenabruf und Broker-Connect jedes Nicht-LAN-Nicht-Gruppen-Gerät mit Topic, dessen `devicePushAt` älter als `STATUS_REQUEST_INTERVAL_MS` (10 min) ist, gestaffelt 1/s, nur bei verbundenem Broker.
- **Erneuerer je Stufe:** mit Konto Push, 2-Minuten-Abruf und Statusanfrage (auch für Lichter ohne LAN, `hasDeviceNeedingAppApi`; `pollAppApi` braucht das Bearer-Token). Nur API-Key: `DeviceManager.refreshExpiringReachability()` — `/device/state` für Beweise älter `CLOUD_REACHABILITY_REFRESH_MS` (20 min), hinter Befehl und Zustands-Abruf, höchstens ein Aufruf je Gerät und 5 min, am 2-Minuten-Takt vor `pollAppApi`. Geräte mit `applianceBudget` sind davon ausgenommen.
- **Gateway-Geräte:** das Gateway (`gatewayInfo.device`, `resolveGatewayReachability()`) ist nur Obergrenze; positiver Beweis bleibt der eigene frische Messwert (`isSensorDataFresh`).
- `proven` (zweiter Rückgabewert): nur eine gehörte Erreichbarkeit wird ins Gerät zurückgeschrieben. `info.connection` heißt „arbeitet der Adapter“, `groups.info.online` „Cloud verbunden“.
- **Cloud-Erreichbarkeit:** `cloudWasConnected` (Key angenommen / Liste geladen) schreiben nur Funktionen in `cloud-retry-handler` (`setCloudConnected`, `markCloudListAccepted`, `markCachedListAccepted`). Angezeigt wird `cloudReachable` (`cloud-outage.ts`) = `cloudWasConnected` und kein bestätigter Ausfall — in `info.cloudConnected`, `groups.info.online`, dem Log-Kanal „Cloud REST“ und im `info.connection`-Anteil LAN-loser Lampen, nur bei Änderung. Ein Cache-Start setzt den Merker, die Datenpunkte erst mit dem ersten angenommenen Aufruf (`setContactHook` → `onCloudContact`).
- **Ausfall:** ein Aufruf ohne funktionierenden Govee-Server (NETWORK/TIMEOUT, 5xx, TLS) meldet `unreachable`; 429, 401/403 und andere 4xx nie. `CloudOutage` bestätigt beim zweiten solchen Aufruf mindestens `CLOUD_UNREACHABLE_CONFIRM_MS` (60 s) nach dem ersten: EINE Warnung, die nächste angenommene Antwort EINE Info. Der Zweig löst nichts aus (kein Neuladen, kein Löschen, keine Befehlssperre) und fasst den Retry-Loop nicht an.
- **Löschen braucht Wissen:** `cleanupDevices` entfernt Geräte außerhalb von `getDevices()` nur bei `hasKnownPopulation()` (nur die drei Kontolisten mit `ok`; Cache und LAN zählen nicht). Jede ok-Liste schützt ihre Bäume selbst (`ReconcileSource.trees`); nennt eine Liste Geräte, die der Karte fehlen, liest `reloadForAccountGap()` die Cloud-Liste EINMAL, der Aufräumer wartet.

## Diagnose-Bericht

Ferndiagnose-Werkzeug; Download, nie Ablage.

- `handleDiagnosticsExport` antwortet `{ fileName, content }`, die Karte lädt herunter. Dateiname `govee-smart_<SKU>_<kurz-id>_v<version>_<datum>_<zeit>.json`. `diag.lastExport` = Zeitpunkt (ISO, UTC, `role: "date"`). App-Gruppen haben keinen `diag`-Kanal (nur per `sendTo`).
- **Pseudonymisierung** (`anonymiser.ts`): stabile Marken statt Schwärzung; Reihenfolge zwingend **schwärzen → pseudonymisieren → kappen** (auch je MQTT-Umschlag im Puffer).
  - Ohne Muster nach Schlüssel: `wifiName`/`ssid` → `wifi-N`, `matterId` → `matter-N` (`SHAPELESS_KEYS`); `deviceId` als Zahl → `app-id-N`, als Ziffernkette (Gruppen, `groupId`) → `id-…<4>`, `groupId: 0` bleibt; `sharedSettings` geschwärzt; dieselben Schlüssel auch in JSON-Text (roh und eine Ebene maskiert).
  - Gruppen-Ids in Text über `setDeviceIdsProvider` (ab 5 Ziffern, nie in längeren Zahlen); Konto-/Geräte-Topics (`GA/`/`GD/` + ≥ 12 Hex) → `GA/topic-N`; `lanInfo.addr` (IPv4 als Little-Endian-Zahl) dekodiert markiert; IPv6 nur bei acht vollen Gruppen oder `::`, lokal sind `::1`, `fe80::/10`, `fc00::/7`, `::ffff:a.b.c.d` folgt IPv4; Gerätenamen nur als ganze Wörter, längster zuerst, nie in Schlüsseln. Jede Marke ist beim zweiten Durchgang stabil (`minted`); Beweis ist der Kanarien-Test in `diagnostics.test.ts`.
- Inhalt: ioBroker-Umfeld, Objektbaum strikt EINES Präfixes, Gesamtlage, `commandResults`, `heldCommands`, Segment-Herkunft (`resolveSegmentCountWithSource`); die Kontoliste roh (`AppDeviceEntry.raw`, `rawAppEntry` parst jeden JSON-String darin); jede Antwort EINMAL (`/device/state` nur über den Response-Hook).
- Der Erreichbarkeits-Abschnitt entscheidet nichts selbst: `decidedBy` + `lastEvidenceAt` aus `resolveDeviceReachability`, `silentSources`/`refreshedBy` aus derselben Fallunterscheidung, mit den nötigen Zugangsdaten je Erneuerer.
- Puffer sind byte-begrenzt (`diagnostics.ts`): 512 KB API-Historie je Gerät, 4 KB je MQTT-Umschlag, 16 KB je LAN-Payload.
- **Eine Geräteliste für Assistent und Diagnose** (`diagnostics {action:"list"}`, je Gerät `online` + `segments`); die Karte filtert, nichts wird über den Umschalter zwischengespeichert; ein Fehlschlag wirft (`DeviceListError`), nie eine leere Liste.

## Cloud REST API v2

Basis `https://openapi.api.govee.com`, Kopf `Govee-API-Key`.

- **Zwei Hüllen:** `/user/devices` → `{code, message, data}`; `/device/state`, `/device/scenes`, `/device/diy-scenes` → `{requestId, msg, code, payload}`.
- Eine Ablehnung im Umschlag (`code` ≠ 200/0, Grund in `msg`) wirft an allen drei Geräte-Endpunkten (`throwIfRejected`) und an der Liste (Grund aus `msg` ODER `message`). Eine wirklich leere Liste ist ein gültiges Konto; nur wenn anderes Geräte zeigt, wird sie einmal je leerer Folge als `transient` neu versucht. Eine Ablehnung kann im Umschlag `200` melden, während `capability.state.status` `"failure"` sagt.
- App-Gruppen werden nie nach ihrem Zustand gefragt (Govee: `400 devices not exist`).
- **Ratenlimits je Aktor** (`CLOUD_LIMITS`, `rate-limiter.ts`): Liste 20/min je Konto · `state`/`scenes`/`diy-scenes` 20/min je Gerät · `control` Token-Bucket 2/s Burst 6 je Gerät und 12/s Burst 80 je Konto · App-API 8/min global. Jeder Aufruf trägt seine Lane (`account-list` · `device-read` · `device-control` · `appapi`); ein freier Eimer startet sofort. Tageszähler 9.000 global und 90 je Haushaltsgerät (`applianceBudget`, gebucht beim Ausführen); ein erschöpftes Budget lehnt ab statt einzureihen; nach `stop()` reiht der Limiter nichts mehr ein. Govees Ratenlimit-Köpfe landen im Bericht (`apiHistory[].rateLimit`, `runtimeState.cloudRateLimit`).
- Ein vorgemerkter Befehl („device offline“) behält beim erneut abgelehnten Zustellversuch seine Zeit.
- Einheiten: `unit.percent` → `%`, `unit.kelvin` → `K`, `unit.celsius` → `°C`.
- HTTP 200 mit leerem Körper ist `null`, kein Fehler (`httpsRequest`); nur nicht leeres Nicht-JSON ist ein Parse-Fehler.
- **Cloud-Retry** (`cloud-retry.ts`, `CloudLoadResult`): `auth-failed` stoppt, `rate-limited` wartet `Retry-After` (mit Boden), `transient` 5 min; Cloud-Start per `Promise.race` mit 60 s.

## Haushaltsgeräte-Steuerung: STRUCT

- **`work_mode` → `{workMode, modeValue}`:** `sendWorkModeCommand` liest den Geschwister-Datenpunkt; `resolveWorkModeStruct` nimmt bei einer Stufen-Eingabe den Modus aus der besitzenden Gruppe (Dropdown) sonst aus `control.work_mode`, schickt ohne Stufen `defaultValue` und klemmt in einen `range`.
- **`modeValue` ist ein Baum:** `classifyModeLevels` — eine Gruppe nur mit `defaultValue` ist keine Stufe; Dropdown nur, wenn jede Stufe einen Namen hat und kein Wert zweimal vorkommt, sonst eine Zahl samt `range`; keine Stufe → kein Datenpunkt. Gelesen in derselben Form (`modeLevelKind` in `mapCloudStateValues`).
- **`temperature_setting` → `{temperature, unit}`:** `sendTargetTemperatureCommand` klemmt in den gemeldeten Bereich und bestätigt den geklemmten Wert. `unit` ist ein STRUCT-Feld mit `defaultValue` (`"Celsius"`), nie die Anzeige-Einheit. Ein deklariertes `autoStop` ist `control.auto_stop` und geht im selben STRUCT mit.
- **Ein Dropdown sendet Govees deklarierten Wert** (`declaredOptionValue`/`pickOption`). Ein Wert, den der Transport verändert, wird so bestätigt, wie er rausging (`lanColorTemperatureK` 2000–9000 K, Zieltemperatur, Nachzustellung mit dem gesendeten Wert).
- **Farbtemperatur-Bereich:** LAN-Licht aus seiner Cloud-Fähigkeit (`declaredColorTempRange`, dann der Quirk; `applyOwnColorTempRange`), Gruppe als Schnittmenge (`sharedColorTempRange`, ohne Überlappung kein Regler); ohne gemeldeten Bereich keine erfundenen Grenzen.
- **OpenAPI-MQTT-Ereignisse** tragen `state` als Array; der Client normalisiert auf `state: {value}`. Ein Wert zählt nur, wenn er deklariert ist (`EVENT_VALUES`: `bodyAppearedEvent` 1 = anwesend, 2 = abwesend; sonst 1 = wahr). Ohne Aufhebungswert hält der Datenpunkt das letzte Ereignis.
- **Zustands-Abruf beim Start:** EIN Aufruf nach der Entleerung von `stateCreationQueue` (beide Startpfade, Test gepinnt), auf der Status-Stufe des Limiters (Priorität 1). `/device/state` liefert beide STRUCT-Hälften; die Form entscheidet die deklarierte Fähigkeit (die Antwort trägt keine `parameters`).

## Haushaltsgeräte-Zustand aus dem eigenen Push

- Jedes `status`-Paket trägt in `op.command` 20-Byte-BLE-Frames (`aa <fn> <sub> <payload…> <xor>`); geprüft an EINER Stelle (`decodeBleFrame`, `ble-frame.ts`, genau 20 Bytes, XOR über 0–18). `decodeApplianceFrames` (`appliance-frames.ts`) dekodiert je SKU (`DECODERS`) in synthetische Fähigkeiten über `onCloudCapabilities` → `applyCloudCapabilities`.
- Dekodiert: **H1741** `aa 42 <b>` = Akku % (Bits 0–6, Bit 7 ausmaskiert) → `sensor.battery`. **H7127** `aa 05 00 m` = Modus, `aa 05 01 n` = letzte manuelle Stufe, `aa 19 00 ff ff ?? 00 FF` = Filter % (Byte 7); Byte 5 nicht dekodiert.
- Jeder Wert wird gegen die deklarierten Fähigkeiten geprüft (Modus ∈ Modi, Stufe ∈ Gruppe, Filter ≤ 100), sonst verworfen. Neue Familie nur aus einer Aufzeichnung mit zwei Werten und unabhängiger Referenz.
- Ein Push für ein Gerät, dessen Baum noch entsteht, wird je Gerät festgehalten (neuester gewinnt) und von `releaseHeldPushes()` nach `statesReady` und nach dem Startwert-Abruf angewendet, nie verworfen.

## App-API (`app2.govee.com`, intern)

- Liefert Sensorwerte (`POST /device/rest/devices/v1/list` → `deviceExt.lastDeviceData`, alle 2 min), Gruppen-Mitglieder (`GET /bff-app/v1/exec-plat/home`, Bearer) und Bibliotheken (`GET /appsku/v1/light-effect-libraries?sku=<SKU>`, öffentlich, nur AppVersion + User-Agent).
- Pfade EINMAL in `APP_API_PATHS`; eine Token-Ablehnung im Körper (`{"status":401,…}`) wirft an jedem Token-Endpunkt (`throwIfBodyRejected`), ein AUTH-Fehler fordert ein neues Token an (`bearerRefresher`).
- Gruppen-Mitglieder werden beim Start, nach jedem erfolgreichen Sync, nach einem wiederhergestellten Cloud-Start und mit jedem Token aufgelöst, solange eine App-Gruppe bekannt ist und keine Gruppenliste geantwortet hat.

## AWS IoT MQTT (Konto-Broker)

Auth-Flow und Topics: `Ressourcen/govee-smart/mqtt-aws-iot.md`. Befehle gehen NIE über den Konto-Broker; der einzige Publish ist `requestStatus` (`cmdVersion` aus dem Quirk `statusCmdVersion`, Vorgabe 2, mit `accountTopic`).

- **Login-Schutz:** `MQTT_MAX_AUTH_FAILURES` (3) — jeder Versuch, der Govee erreicht und abgelehnt wird, zählt (`category ≠ NETWORK ≠ TIMEOUT`); zurückgesetzt nur bei erfolgreichem Subscribe. `refreshBearerSilently` bucht über dieselbe `recordFailure`, die Antwort liest EINE Funktion (`classifyLoginResponse`). 454/455 pausieren bis zum Code (454 = neuer Client), Code-Anforderung mit 30-s-Drossel.
- **Login-Fenster je Konto** (`LoginWindow`, `loginWindowFor`): Live-Client und jede Probe zählen; höchstens `MQTT_MAX_LOGINS_PER_WINDOW` (3) je `MQTT_LOGIN_WINDOW_MS` (1 h), gezählt erst nach Govees Antwort. Volles Fenster: Warnung und EIN Neuversuch am Fensterende; die Probe sendet nichts und meldet `loginWindowFull` mit `retryAt`.
- **Zugangsdaten wiederverwenden:** Bearer + P12 überleben Neustarts (`tryPersistedReuse`) und jedes frische Bündel bleibt im Speicher (`rememberCredentials`); es fällt nur bei einer Ablehnung weg (CONNACK „not authorized“ oder drei Reuse-Versuche ohne CONNACK). Die Datei ist an das Konto gebunden (`accountKey`). Auffrischung bei Fehlschlag nach 5 min, ein App-API-401 stößt sie an (`requestBearerRefresh`).
- Server-Dauern gehen nur gekappt in Timer (`tokenTtlSeconds` 10 min…7 Tage, Retry-After ≤ 1 h; `setTimeout` wirft über 2³¹−1 ms). Konto-Id und Topic nur maskiert im Log. MQTT startet vor der Cloud.

## LAN UDP

Suche `239.255.255.250:4001` · Antworten an `:4002` · Befehle an Geräte-IP `:4003` (protokollfest). Nur Lichter mit eingeschalteter LAN-Funktion in der App.

- Multicast-Egress und Empfangs-Socket binden an `native.bind`; `native.port: 4002` ist im Formular `disabled` mit `min = max = 4002`, der Code bindet `LISTEN_PORT` (Flotten-Standard Listen-Port, `fleet.json` → `listenPorts`). Der alte Schlüssel `networkInterface` zieht über `NATIVE_KEY_MIGRATIONS` (`main.ts`) und den Flotten-Master `native-key-migration.ts` um.
- Der Empfangs-Socket 4002 ohne `reuseAddr` (sonst bekommt nur einer von zwei Prozessen die Antworten); belegt ihn ein anderer, warnt der Client und meldet `lan-port`. `info.connection` ohne Geräte folgt `lanClient.isListening()`. Der Such-Socket 4001 behält `reuseAddr`.
- **Suchziele:** Multicast, die Broadcast-Adresse der gewählten Karte (bei `0.0.0.0` jeder Nicht-Loopback-IPv4-Karte, `interfaceBroadcasts`) und jede bekannte Licht-Adresse; kein `255.255.255.255`, kein eigenes Adressfeld. Die Antwortadresse ist die UDP-Quelle; ein Paket ohne Datenobjekt ist keine Meldung; ein Fehler im Verbraucher heißt „handler failed“.
- **Statusabfrage:** ohne Broker bei jedem Scan; mit Broker nur, wenn Antwort (`lastLanStatusAt`) und Anfrage (`lastLanStatusAskedAt`) älter als `LAN_STATUS_REFRESH_MS` (60 s) sind. Der Router fragt `LAN_STATUS_AFTER_COMMAND_MS` (2 s) nach dem letzten LAN-Befehl je Licht einmal nach.
- Ein Sendeweg (`sendCommand`; `sendPtReal` ruft ihn): ein Fehlschlag warnt je IP einmal je neuer Meldung (`failedSends`), Wiederholungen gehen auf debug.

## Szenen

- Szenen kommen von `POST /device/scenes` (`{payload: {capabilities: [{type, instance, parameters: {options}}]}}`), nicht aus den Gerätefähigkeiten. `lightScene` → Szenen-Dropdown, `snapshot` → Snapshot-Dropdown; Auswahl nach Position (`device.scenes[idx-1].value`).
- **ptReal:** eine Szene mit `sceneCode` aus der Bibliothek geht per BLE-over-LAN; Namensabgleich mit Suffix-Kappung (-A/-B); ohne Code Cloud. `fetchSceneLibrary()` nimmt alle `lightEffects` je Szene (Varianten als Suffix „Aurora-A“); der Code ist `libraryCode` (eigener vor dem der Szene, nur > 0), der Parameter `libraryParam` (nur Text).
- **Tempo:** `speedInfo.moveIn[]`, Byte an `pageLength - 5`, `applySceneSpeed()` vor dem Senden. `scenes.scene_speed` bleibt stehen, solange die Bibliothek für das Licht nicht bestätigt ist (`libraryDecidesPending`).
- **Snapshot-Pakete** aus `/bff-app/v1/devices/snapshots` nach NAMEN (`{name, cmds}`); eine geänderte Namensliste holt neu (`snapshotPacketsMatch`), ein Cache der alten Positionsform wird verworfen (`snapshotPacketsFromCache`).
- **Lokale Snapshots** (`local-snapshots.ts`): Zustand per LAN inkl. Segment-Farbe/-Helligkeit, Wiederherstellung über einzelne LAN-Befehle. Ablage im Geräteobjekt `native.localSnapshots` als JSON-Text `{"snapshots":[…]}` (Text, weil `extendObject` Arrays elementweise verschmilzt); der Store schreibt nie `common` und nie auf ein fehlendes Geräteobjekt.
- **Dropdown-Reset:** ein Moduswechsel (Szene, DIY, Snapshot, Musik, Farbe, Aus) setzt die anderen Modus-Dropdowns auf „---“ (`resetAfterWrite`, für Gerät und Gruppe). Der `---`-Eintrag ist `"0"` (der Prüfbot verlangt ein `def`, das als JSON parst).

## Segmente, Assistent, manuelle Segmente

- **Senden:** `segmentColor:N`/`segmentBrightness:N` per LAN ptReal (`33 05 15`), Cloud als Rückfall; der Stapelbefehl als Bitmaske in einem Paket. `segments.command`: `1-5:#ff0000:20`, `all:#00ff00`, `0,3,7::50`.
- **Segmentzahl:** `resolveSegmentCount(device, registry)` ist die physische Länge — Quirk `segmentCount` (harter Override) → `device.segmentCount` (gelernt: Cache, AA-A5-Push, Assistent) → Minimum über die positiven `segment_color_setting`-Fähigkeiten → 0. Jede Quelle läuft durch `plausibleSegmentCount` (1..56; derselbe Maßstab sperrt den Push nur bei einem gültigen Quirk). Die Baumgröße ist `effectiveSegmentCount` (plus einer längeren manuellen Liste); `DeviceManager.syncSegmentCount` liefert sie und schreibt nichts; `StateManager.createSegmentStates` baut. Niemand liest `device.segmentCount` allein.
- **AA-A5-Push ist für die Anzahl maßgeblich — hoch sofort, runter nur mit Wissen:** `parseMqttSegmentData` liest bis 19 Pakete, erkennt die Drei-Slot-Form, schneidet leere Slots, Helligkeit > 100 und einen geratenen Schlussslot (`trailGuess`). Gesenkt wird nur bei `complete` (lückenlose A5-Folge in EINEM Statusbericht) ohne `trailGuess` oder wenn `segmentCountFromSnapshotFrames` dieselbe Zahl belegt; verglichen mit `resolveSegmentCount`. `onSegmentCountChanged` → `createSegmentStates` → `cleanupExcessSegments`, sofort im Cache.
- Echos über der Segmentzahl werden verworfen (`if (cap === 0 || idx >= cap) continue;`). Der Segment-Push gilt nur im Farb-/Verlaufsmodus.
- **Manuelle Segmente** (`manual_mode` + `manual_list`): `parseSegmentList()` (`"0-9"`, `"0-8,10-14"`), Obergrenze `SEGMENT_HARD_MAX` (55, `segment-list.ts` — der EINE Wert). `all` und der Push-Filter halten sich daran.
- **Assistent** (React): misst bis zum Protokoll-Limit oder Abbruch, Sitzung im Speicher, Baseline, 5-min-Leerlauf, globale Sperre. Antworten sind knapp (`snapshot` + Flags `active`/`done`/`aborted`/`applied`/`error`), die Karte trägt die Texte. Aktionen `start` · `yes` · `no` · `apply(indices)` · `abort`; `finish()` am Limit und `apply()` verdichten über dieselbe `consolidate` (Länge = höchstes leuchtendes Segment + 1). Start und Neu-messen öffnen über `beginMeasure`; eine verschwundene Karte schickt EINMAL `abort`.

## Gerätekatalog & Quirks

`devices.json` (Schema `devices.schema.json`, `npm run validate-devices`) — je SKU `name`/`type`/`status`/`since` + optionale `quirks`; `device-registry.ts` lädt.

- **Die Katalogwörter stehen EINMAL im Code** (`device-catalog.ts`: `DEVICE_TYPES`, `DEVICE_STATUSES`, `CONFIGURABLE_OVERRIDE_COMMANDS`, `TRANSPORT_TARGETS`, `DeviceQuirks`) und einmal im Schema; `device-catalog.test.ts` hält beide gleich. `validate-devices` liest seine Regeln aus dem Schema (`tools/devices-validation.ts`) und bricht ab, wenn ein Schema-Pfad fehlt. Die Wiki-Reihenfolge ist `DEVICE_TYPES`, die Titel verlangt der Compiler.
- **Aufnahme:** jedes Govee-WLAN-Produkt; ein Gerät hinter einem Govee-Gateway zählt, das Gateway ist das WLAN-Gerät (`gateway`, `composter`). Die Laufzeit liest den Katalogtyp nie (nur `quirks`/`status`/`tier`). Katalognamen sind Englisch.
- **Status:** `seed` (importiert, ungetestet; das Gerät erscheint trotzdem, seine Quirks greifen nur mit dem Schalter `experimentalQuirks`) · `reported` · `verified`. Wiki-Geräteseite per `npm run gen-wiki` (`tools/gen-wiki-render.ts`), Fußzeile ohne Datum (Gate A13 vergleicht).
- **Quirks:** `colorTempRange` (→ `applyColorTempQuirk`) · `brokenPlatformApi` (→ `buildCloudStateDefs` nimmt die LAN-Vorgaben) · `transportOverrides` (→ `resolveTransport`; nur die genannten Befehle, Einzelsegment-Befehle nie) · `segmentCount` (→ `resolveSegmentCount`) · `statusCmdVersion` (→ `requestStaleStatuses`; falsche Version = Schweigen) · `platformTempUnit: "F"` (→ `loadCloudStates` rechnet `sensorTemperature` in °C) · `ignoredCloudCapabilities` (→ kein Datenpunkt, kein Wert).
- **Neues Quirk:** `DeviceQuirks` + Feldliste in `device-catalog.test.ts` → Schema (`additionalProperties:false`; was das Schema nicht ausdrückt, in `tools/devices-validation.ts`) → Konsumstelle → Eintrag mit `since` → Tests.
- Nicht in den Katalog: `manualMode`/`manualSegments` (Laufzeit), Nutzer-Vorgaben (jsonConfig).

## Admin UI

- Reiter **Konfiguration** (Verbindungs-Karte, Netzwerk, Experimentell-Schalter, Spende) und **Experte** (Umschalter Segment-Erkennung ODER Diagnose), je ein Module-Federation-Mount.
- **Verbindungs-Karte:** das Backend antwortet mit Daten (`auth-status.ts`: `status`, Govees `reason` bei `loginFailed`/`codeRejected`, `retryAt` bei `loginWindowFull`); die Karte spricht jeden Fall in der Admin-Sprache und zeigt die Uhrzeit des Betrachters. Ohne bekannten Status oder bei abgewiesenem `sendTo` `gsw_conn_err` mit Grund, nie ein roher Schlüssel.
- **Geräte-Symbole** (`device-icons.ts`, `common.icon`): Inline-`data:`-URIs mit `fill="currentColor"`, nur `path`/`circle` (Flottenregel, Test). `admin/govee-smart.svg` hat feste Farben.
- **Reiter-Merker:** `ExpertPanel` löscht `localStorage["App.govee-smart"]` (`forgetLastTab`, beim Mount und Unmount); bei serverseitigen GUI-Einstellungen ist der Speicher ein nacktes Objekt (`window._localStorage`), deshalb wird der Schlüssel direkt entfernt.
- `admin/i18n/*.json` (11 Sprachen). Die Namen/Beschreibungen der neun `instanceObjects` kommen aus Schlüsseln, die `fleet.json` → `manifestI18n` zuordnet und `ensureManifestObjects()` (`main.ts`) schreibt; beim Umbenennen eines Manifest-Datenpunkts zieht die Zuordnung mit.

## Design-Regeln

1. **Fehler-Dedup:** `classifyError()` + `lastErrorCategory`: warn bei neuer Kategorie, dann debug, Wiederherstellung einmal info. Der Fehlertext ist EIN Helfer (`errMessage`, Flotten-Master, ganzer Rumpf im `try`).
2. **Bereitschaftszeile** (`checkAllReady`, Notschalter 60 s) ohne Gerätezahlen; jedes `✗` mit Grund.
3. **SKU-Cache** (`sku-cache.ts`): nach dem ersten Start keine Cloud-Aufrufe nötig. `save()` schreibt atomar (Temp + Flush + Rename, je Datei serialisiert) und überspringt gleiche Inhalte; `pruneStale(14)`; `RUNTIME_ONLY_KEYS` ist die EINE Liste der Laufzeitfelder, beide Zweige von `applyCachedEntry` stellen über `cachedToGoveeDevice` her. Szenen/Bibliotheken je Licht sind ein Hintergrundauftrag (`startSceneLoad`): `scenesChecked` erst mit der Antwort, ein verworfener oder werfender Auftrag speichert mit `false`, nach `unloading` baut keiner mehr. Ohne Token fragen die Token-Endpunkte nicht (`noteSkipped`), `onBearerToken()` lädt nach (`enableBearerFollowUps()` bei `statesReady`). Bibliotheken je SKU einmal je Lauf (`sharedFetches`); eine leere Antwort gilt `LIBRARY_RECHECK_MS` (7 Tage, `librariesCheckedAt`); der Aktualisieren-Knopf ignoriert den Merker. Die Bibliotheken-Abfrage läuft nur für Lichter.
4. **Ein Befehl, der nicht rausging, wird nicht bestätigt:** jeder Sendeweg wirft ohne Kanal (`describeSkip` nennt den Grund), jede abbrechende Hilfe meldet `boolean`; der Router bestätigt nur im Erfolgszweig, mit EINER Warnung „Command failed …“; der Bericht führt `ok:false`. Ein mit „device offline“ abgelehnter Befehl wird vorgemerkt (`onDeviceOffline`, `PENDING_INTENT_TTL_MS` 5 min) und beim nächsten Lebenszeichen EINMAL zugestellt, gespiegelt mit dem gesendeten Wert.
5. **Wiederholende Schreibpfade nehmen `setStateChanged`** (20-s-Runde, `updateDeviceState`, Gruppen-Erreichbarkeit, `applyCloudCapabilities`).
6. **Dropdowns sind `type: "mixed"`, `role: "state"`** mit eindeutiger Karte (`buildUniqueLabelMap`); `resolveDropdownInput` löst Zahl/Text groß-klein-egal auf und steigt bei `type: "number"` aus. Eine geschrumpfte Karte wird ganz geschrieben (`repairCommonStatesIfBuggy`, per `setForeignObject`), nie durch den frühen `---`-Bau.
7. **Nur Geändertes wird geschrieben:** Objekte über `extendIfChanged` (`object-write.ts`), Nur-lesen-Zustände über `StateManager.writeReadOnly`, das Geräteobjekt über `deviceObjectSignature` (nur im Speicher); `forgetPrefix` vergisst einen entfernten Baum. Kein `preserve`.
8. **Die Definitionen eines Geräts entstehen IM Aufbau** (`onCloudDataReady` → `runDeviceBuild`).
9. **Lesbare Werte:** ein Wert geht nur in ein Dropdown, wenn die Liste aus der deklarierten Fähigkeit ihn trägt (`mapCloudStateValues`; der Musikmodus wird über `getMusicModeOptions` in seine Position übersetzt). Govees Einstellungswörter beschriftet `optionLabel` (`value-labels.ts`) in der Systemsprache, Govees Wort bleibt gültige Eingabe (`optionLabelsFor`); Govees Inhalt (Szenen-, Effekt-, Musiknamen) steht in `test/readable-values.json`. `info.type` = Govees Typ ohne Präfix, ein fremder Typ wird `unknown`.
10. **Jede angenommene Cloud-Liste hat EINEN Nachlauf** (`markCloudListAccepted`); Wiederherstellung und Sync lesen Zustände erst, wenn die Bäume der neuen Geräte stehen (`treesBuilt`), der Sync nur die neuen.
11. **Einmal-Aufräumer laufen einmal je Lauf** (`firstThisRun`) und bleiben im Code, solange eine Anlage über mehrere Versionen springen kann.
12. **Logging:** Knöpfe melden ihr Ergebnis auf info, automatische Korrekturen bleiben auf debug.

## Fallstricke

- **Synthetische Sensor-/Ereignis-Zustände** haben EINEN Namen je Messwert (`canonicalSyntheticId`: `sensorTemperature` → `temperature`, `carbonDioxide`/`…Concentration` → `co2`, `lackWaterEvent` → `lack_water_event`); `SYNTHETIC_STATE_META` (`capability-mapper.ts`) ist die eine Tabelle für Name, Erklärung, Rolle, Einheit und Kanal. Ein Wert trägt seinen Kanal (`CloudStateValue.channel`), weil Soll- und Messwert dieselbe Id haben können. Die Cloud-Phase lässt sie stehen (`cleanupCloudOwnedStates`).
- **Jede `mode`-Instanz mit Optionsliste bekommt einen Datenpunkt**; `presetScene` heißt `scene`, jede andere `sanitizeId(instance)`, Namen aus `capabilityName()`, nie `humanize()` in `common.name`.
- **Namen mit laufender Nummer:** `tNameWith(key, n)`; nur EIN `%s` und nur, wenn der englische Text ihn trägt.
- **Abonnements:** `devices.*`, `groups.*` und ausdrücklich `info.manualSyncDevices`; ein neuer Nutzer-Datenpunkt unter `info` braucht ein eigenes Abonnement. Der Sync-Knopf meldet ohne API-Key, dass er ihn braucht.
- **Pure-LAN-Aufräumer** (Reste von `scenes`/`music`/`snapshots` an Lichtern ohne Fähigkeiten) nur ohne API-Key und ohne Cloud-Client, in `runDeviceBuild`.
- **Klassifizierung** (`classifyError`): strukturierte Felder zuerst (`category`, `code` inkl. `ETIMEDOUT`, `statusCode` 401/403/429, MQTT-Codes 4/5); Textmarker nur als ganze Wörter.
- **Gruppen-Fan-out** sendet an Cloud-Mitglieder unabhängig vom Online-Kennzeichen, überspringt nur LAN-Lampen ohne frische Antwort. Gruppen-Musik bietet nur Modi, die jedes musikfähige Mitglied deklariert (`memberMusicModes`, Namen über `musicNameKey`).
- **Rückfall bei Nutzer-Inhalten:** primär leer → sekundär ohne Cache-Sperre; primär Fehler → Cache behalten.
- **Aktualisieren-Knopf je Gerät**, nicht global; Sensoren und Heizer bekommen ihn nicht.
- **Pseudo-Gruppen** (`PSEUDO_GROUP_SKUS`: `SameModeGroup`, `DreamViewScenic`) werden bei `mergeCloudDevices` und beim Cache-Laden übersprungen; `BaseGroup` (`APP_GROUP_SKU`, `isAppGroup`) wird unterstützt; Altlasten räumt `cleanupPseudoGroupOrphansOnce`.
- **Sensortemperatur ist °C:** App-API `lastData.tem` = Hundertstel °C, `settings.fahOpen` nur Anzeige; ein Konto-Messwert trägt seine Messzeit (`lastData.lastTime` → `ts`).
- **Govees Erinnerung ist kein Zustand:** meldet Govee `online: false`, wendet `loadCloudStates` nur das `online` an (`cloudReportsOffline`).
- **Govees `""` ist keine Aussage** (auch `colorTemperatureK: 0`): `mapCloudStateValue` gibt `null`.
- **Szenen-Dropdowns sind nach Position kodiert;** `dynamic_scene` liefert aus der Zustandsantwort keinen Wert.

## Tests

- Je Modul eine vitest-Suite (`src/**/*.test.ts`) mit „Drift“-Block gegen kaputte Nutzlasten. Abdeckung über `src/**/*.ts` ohne Ausnahme; das Test-Gerüst ist `test/test-helpers.ts` (gemeinsamer `mockLog`). React: `npm run test:admin` (`check:admin` + Komponenten-Suite), in der CI der Job `admin-component`.
- `main.ts` ist unit-getestet (`src/main.test.ts`): `@iobroker/adapter-core` mit In-Memory-Speichern, StateManager/DeviceManager/SkuCache/LocalSnapshotStore laufen echt, ersetzt werden nur die `make*Client`-Fabriken; jeder Test ein eigenes Datenverzeichnis. Die Attrappe von `getForeignObjectsAsync` filtert wie der Controller (ohne Typ nur `state`).
- `httpsRequest` nimmt einen `transport`; die Tests fahren den echten Code über `node:http`. LAN-Test mit `node:dgram`-Attrappe (`sends`, `sendError`), SKU-Cache mit `failNextOpen`, HTTP-Abbruch mitten im Körper mit `content-length`.
- **Echte Antworten statt erfundener Formen:** wo eine Aufzeichnung existiert, läuft der Test damit. Die Inventar-Fixture (`test/fixtures/inventory/govee-cloud.json`) kennt Geräte MIT `_source` (ganzer aufgezeichneter Eintrag) und OHNE (Teilsatz echter Blöcke, zu ersetzen, sobald ein Export da ist); der Fixture-Server (`test/inventory.js`) antwortet in Govees Hüllen und meldet sich mit Konto-Zugangsdaten an. `movieMode` ist bewusst nicht gebaut.
- `test:inventory` fährt `build/` — vorher `npm run build`; die Upgrade-Suite lokal nur mit `INVENTORY_PREVIOUS`. Abnahme sind zwei Läufe mit byte-gleichem `objects.inventory.json`.

## Konkurrenz

`iobroker.govee` ist veraltet (nur LAN). govee-smart ist im Latest-Repo die einzige Govee-Lösung mit Multi-Kanal, ptReal und Assistent.
