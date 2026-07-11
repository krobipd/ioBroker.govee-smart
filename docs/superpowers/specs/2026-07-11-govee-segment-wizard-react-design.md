# Segment-Wizard als Custom-React-Admin-Komponente (Variante B)

- **Datum:** 2026-07-11
- **Adapter:** iobroker.govee-smart
- **Ziel-Version:** v2.21.0 (Minor — neues Feature + Datenpunkt-Entfernung)
- **Status:** Design freigegeben (krobi, 2026-07-11), Spec zur Review

## 1. Ziel & Kontext

Der Segment-Erkennungs-Wizard misst die echte Länge eines LED-Strips, indem er
Segment für Segment hell aufblitzt und den Nutzer „leuchtet / dunkel (Lücke) /
fertig" bestätigen lässt (für gekürzte Cut-Strips). Heute läuft er als
jsonConfig-`sendTo`-Tab: Buttons lösen onMessage-Roundtrips aus, der Status
kommt über einen `info.wizardStatus`-State + `staticText`. Funktional, aber
jeder Klick lädt das Panel neu, es gibt keine visuelle Rückmeldung welches
Segment gerade dran ist, und der Status hängt an einem UI-only-State.

**Dieses Feature** ersetzt den Tab-Inhalt durch eine **eigene React-Komponente**
mit einer **Live-Segment-Karte**: ein Grid, das sich beim Messen füllt und im
Review-Schritt korrigierbar ist. Nischen-Feature (nur Cut-Strip-Besitzer), aber
bewusst hochwertig gemacht.

Referenz-Adapter für das Custom-Component-Muster: **iobroker.public-holidays**
(`src-admin/` + Vite + Module Federation → `admin/custom/customComponents.js`,
jsonConfig `type:"custom"`). [[feedback_govee_pattern_first]]: zuerst gelesen.

## 2. Entscheidungen (aus dem Brainstorming)

- **Interaktion:** Geführt + Live-Grid. Der getestete Backend-Flow bleibt 1:1;
  das Grid ist das visuelle Upgrade. (Alternative „freies Antippen" verworfen —
  bräuchte Backend-Umbau + fummelige Lückenerkennung.)
- **Abschluss:** Review-/Korrektur-Schritt. Nach „Fertig" zeigt die Komponente
  die komplette Karte; einzelne Zellen sind per Klick umschaltbar, dann
  „Übernehmen". (Alternative „sofort übernehmen" verworfen — kein Netz bei
  Verklicken.)

## 3. Nicht-Ziele (YAGNI)

- Keine Änderung der Mess-Mechanik / des Flash-Protokolls im Backend.
- Kein Ersatz anderer Admin-Tabs (LAN/Cloud/Account bleiben jsonConfig).
- Keine Echtzeit-State-Subscription — reines `sendTo`-Request/Response reicht.
- Keine grafische Farbdarstellung der echten Segment-Farbe (Flash ist
  bright-white; Grid-Zellen zeigen Zustand, nicht Live-Farbe).

## 4. Architektur

- **Neues `src-admin/`** nach public-holidays-Vorbild: eigenes `package.json` +
  `node_modules`, `vite.config.ts` mit Module Federation, `tsconfig*.json`,
  `eslint.config.mjs`, `index.html`, `tasks.js`. Build-Output →
  `admin/custom/customComponents.js` (+ `admin/custom/assets`, `mf-manifest.json`,
  `i18n`).
- **jsonConfig:** der Tab „Segment-Erkennung" enthält **ein** Feld
  `{ "type": "custom", "url": "custom/customComponents.js", "i18n": true }`, das
  den ganzen Tab füllt. Die alten `sendTo`-Buttons, `staticText` und die
  `info.wizardStatus`-Anzeige entfallen.
- **Kommunikation:** `socket.sendTo(namespace, command, payload)` gegen die
  **bestehenden** onMessage-Handler (`message-router.ts`). Reines
  Request/Response pro Schritt.

## 5. Komponenten (React, isoliert)

| Datei | Zweck | Abhängigkeiten |
|---|---|---|
| `src-admin/src/App.tsx` | `GenericApp`-Wrapper (`@iobroker/adapter-react-v5`), reicht `socket` + `namespace` durch | adapter-react-v5 |
| `src-admin/src/SegmentWizard.tsx` | State-Automat der 3 Screens (select → measure → review), orchestriert die API-Calls | useWizardApi, SegmentGrid |
| `src-admin/src/SegmentGrid.tsx` | **reine** visuelle Karte: Zellen `confirmed / flashing / open / gap`; im Review klickbar (Toggle). Pure props | — |
| `src-admin/src/useWizardApi.ts` | dünner `sendTo`-Wrapper: `listDevices()`, `start(key)`, `yes()`, `no()`, `done()`, `abort()`, `apply(indices)` | socket |
| `src-admin/src/Components.tsx` | Module-Federation-Export (public-holidays-Muster) | — |
| `src-admin/src/index.tsx` | Entry | — |

Jede Einheit einzeln testbar; `SegmentGrid` hat keine Netz-/socket-Kenntnis.

## 6. Screens / Flow

1. **Select** — Geräte-Dropdown aus `getSegmentDevices`. Auswahl → „Messung starten".
2. **Measure** — Grid + Frage „Segment N — leuchtet es?" + Buttons
   `[Leuchtet]` `[Dunkel/Lücke]` `[Fertig – Strip zu Ende]` + `[Abbrechen]`.
   Grid-Zellen: bestätigt (gefüllt) / blitzt gerade (hervorgehoben) / offen.
3. **Review** — volle Karte, Ergebnis-Text („10 Segmente, 1 Lücke"), Zellen per
   Klick umschaltbar, `[Übernehmen]` `[Nochmal messen]` `[Abbrechen]`.

## 7. Datenfluss / API (bestehende Handler wiederverwenden)

`message-router.ts` routet bereits:
- `getSegmentDevices` → Geräteliste (segment-fähige Devices).
- `segmentWizard {action, device}` → `runWizardStep(action, device)` →
  `WizardResponse`. Actions: `start | yes | no | done | abort`.

**Grid-State:** `SegmentWizard.getSessionSnapshot()` existiert bereits und
liefert den Session-Zustand. Der Datenfluss nutzt ihn:
- `runWizardStep` wird erweitert, sodass die `WizardResponse` bei jedem Schritt
  den Snapshot mitführt: `{ phase, total, currentIndex, confirmed:number[] }`,
  bei `done` zusätzlich `{ segmentCount, hasGaps, manualList, gaps:number[] }`.
- Der Review-Schritt hält die (evtl. korrigierten) Indizes **lokal** im React-
  State. „Übernehmen" schickt einen **neuen** Action-Zweig
  `segmentWizard {action:"apply", device, indices:number[]}`, der die korrigierte
  Karte statt der gemessenen durch das bestehende `applyWizardResult` routet.

## 8. Backend-Änderungen (klein, additiv)

- `WizardResponse` um die Grid-Felder erweitern (Snapshot einfalten). Additiv —
  bestehende Felder unverändert.
- Neuer `apply`-Action-Zweig in `SegmentWizard.runStep` (+ `wizard-handler`):
  nimmt `indices:number[]`, baut daraus `segmentCount`/`hasGaps`/`manualList` und
  ruft `applyWizardResult`. Damit ist der Review-Edit dieselbe angewandte Quelle.
- `info.wizardStatus`-State **entfernen** + One-Shot-`delObject`-Cleanup beim
  Update (Vorbild: die etablierten Orphan-Cleanups, z. B. `info.appVersionDrift`).
- 5-Min-Idle-Timeout + Session-Lock im Backend bleiben unverändert.

## 9. Toolchain / Build / Release

- `package.json`: `build:admin` (`node tasks`) + Root-`build` ruft es mit
  (Reihenfolge an public-holidays angleichen); `files` nimmt `admin/custom/**`
  auf; `.gitignore` schließt `src-admin/node_modules` + `src-admin/build` +
  `src-admin/.__mf__temp` aus.
- CI (`test-and-release.yml`): den `src-admin`-Build-Schritt nach
  public-holidays-Vorbild ergänzen (npm ci + build:admin vor Package-Test).
- io-package.json: custom-Support-Deklaration (repochecker `W5053` vermeiden) —
  public-holidays als Referenz.
- Konsistenz-Audit: prüfen ob `src-admin`-Struktur neue Master-Regeln braucht;
  falls Drift → an public-holidays angleichen, nicht selbst Ausnahme eintragen
  ([[feedback_keine_eigenmaechtigen_ausnahmen]]).

## 10. Tests

- `SegmentGrid.test.tsx` (vitest + jsdom): Zellen-Zustände, Review-Toggle,
  keine socket-Kenntnis.
- `SegmentWizard.test.tsx`: Screen-Übergänge + API-Calls gegen einen
  `sendTo`-Mock (start→yes/no→done→apply); Abbruch-Pfad.
- Bestehende `segment-wizard.test.ts` (Backend) bleiben; +Tests für den neuen
  `apply`-Zweig + die erweiterte Response.
- Integration: Adapter-Start-Test bleibt (custom-Component ist admin-only, kein
  Runtime-Impact) — pre-release.py-Integration-Gate deckt das ab.

## 11. Rollout

- Eigener Minor **v2.21.0**. Changelog user-zentriert: „Der Segment-Erkennungs-
  Wizard hat eine neue visuelle Oberfläche: eine Live-Karte des Strips, die sich
  beim Messen füllt und vor dem Übernehmen korrigierbar ist." Datenpunkt-Hinweis
  (`info.wizardStatus` entfällt) nur falls user-relevant — es war ein interner
  UI-State, daher wahrscheinlich kein Bullet.
- Vor Release: `pre-release.py` (inkl. neuem Integration-Gate) + CI-Watch.

## 12. Risiken / offene Punkte

- **Bundle/Toolchain-Kosten** bewusst akzeptiert (Variante-B-Entscheidung).
- **adapter-react-v5-Version** an public-holidays angleichen (gebundelte Version
  prüfen, nicht `main` — [[feedback_version_specific_source_verification]]).
- **CI-Build-Reihenfolge** für `src-admin` exakt nach public-holidays; sonst
  fehlt `admin/custom/customComponents.js` im Paket.
- Der `apply`-Zweig muss dieselben Guards wie `done` haben (Session aktiv,
  Device noch da).

## 13. Referenzen

- Vorbild: `iobroker.public-holidays/src-admin/` + `admin/custom/` +
  io-package `type:"custom"`.
- Backend: `src/lib/segment-wizard.ts`, `src/lib/handlers/wizard-handler.ts`,
  `src/lib/message-router.ts` (Commands `getSegmentDevices` + `segmentWizard`).
- Aktuelles UI: `admin/jsonConfig.json` Tab „Segment-Erkennung" (wird ersetzt).
- CLAUDE.md Pattern 42 (Segment Detection Wizard).
