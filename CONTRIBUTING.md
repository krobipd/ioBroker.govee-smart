# Contributing to ioBroker.govee-smart

Danke fürs Beitragen! / Thanks for contributing!

GitHub Issues und Pull Requests sind der primäre Weg. Forum-Posts sind willkommen, aber strukturierte Beiträge (Bug-Reports mit Diagnostics, Geräte-Eintragungen, Code) gehören hierher.

GitHub issues and pull requests are the primary path. Forum posts are welcome, but structured contributions (bug reports with diagnostics, device entries, code) belong here.

---

## Add or improve a device entry

Die Geräte-Liste lebt in [`devices.json`](./devices.json) im Repo-Root. Jeder Eintrag entspricht einer Govee-SKU. Status-Stufen siehe [Wiki / Devices](https://github.com/krobipd/ioBroker.govee-smart/wiki/Devices).

The device list lives in [`devices.json`](./devices.json) at the repo root. One entry per Govee SKU. Status tiers are explained in the [Wiki / Devices](https://github.com/krobipd/ioBroker.govee-smart/wiki/Devices) page.

### Workflow

1. **Diagnostics exportieren / Export diagnostics**
   - Adapter installieren, dein Gerät erkennen lassen
   - Object-Browser öffnen, beim Gerät auf `info.diagnostics_export` klicken
   - Inhalt von `info.diagnostics_result` kopieren

2. **Issue oder PR / Issue or PR**
   - **Issue** (einfacher, empfohlen wenn du nicht mit GitHub arbeitest): über das [device-support Template](https://github.com/krobipd/ioBroker.govee-smart/issues/new?template=device-support.yml). Wir tragen den Eintrag selbst ein.
   - **Pull Request** (wenn du den Eintrag selbst beitragen willst): Fork, neuer Branch, Änderung an `devices.json`, PR mit Diagnostics-JSON in der Description.

3. **Schema-Check**
   - Lokal: `npm run validate-devices`
   - CI prüft das auch automatisch — du musst nichts extra tun

### Beispiel-Eintrag / Example entry

```json
"H7160": {
  "name": "Smart Space Heater",
  "type": "heater",
  "status": "reported",
  "since": "2.1.0",
  "tested": "2026-05-12 by your-handle",
  "notes": "Power und Mode funktionieren, Temperatur-Setting noch unklar",
  "quirks": {
    "brokenPlatformApi": true
  }
}
```

### Status-Schwellen / Status thresholds

- `seed` — extern importiert (z.B. govee2mqtt), kein Erfahrungsbericht. Default deaktiviert.
- `reported` — 1 verifizierter Erfahrungsbericht mit Diagnostics. Default aktiv.
- `verified` — mehrere unabhängige verifizierte Erfahrungsberichte. Default aktiv.

Promotion-Pfad: ⚪ → 🟢 → ✅. Linear, jede neue Bestätigung kann hochpromoten.

### Quirk-Felder / Quirk fields

| Feld | Wann verwenden |
|---|---|
| `colorTempRange: { min, max }` | API claims ein Range, real ist enger |
| `brokenPlatformApi: true` | Cloud-Capabilities sind Müll, Adapter fällt auf LAN-Defaults zurück |
| `preferAppApi: true` | OpenAPI v2 `/device/state` liefert leer (Sensoren wie H5179) |
| `skipLanDiscovery: true` | Gerät hat kein LAN — Heater, Humidifier etc. |
| `expectEvents: true` | Gerät pusht OpenAPI-MQTT Events (lackWater, iceFull, …) |
| `powerValueWorkaround: true` | Power kommt als 1/0 statt true/false |

Wenn dein Gerät einen Quirk braucht der hier fehlt: PR gegen `devices.schema.json` + `device-registry.ts` + Issue beschreibt den Bedarf.

If your device needs a quirk that's missing here: PR against `devices.schema.json` + `device-registry.ts` and an issue explaining the need.

---

## Bug reports

Issue mit:
- Adapter-Version (`govee-smart` instance config zeigt sie an)
- ioBroker-Version (`iobroker info` auf dem Server)
- Was du erwartet hast vs. was passiert ist
- Adapter-Log mit `loglevel=debug` falls relevant
- Wenn ein bestimmtes Gerät betroffen ist: Diagnostics-Export wie oben

Issue with:
- Adapter version
- ioBroker version
- Expected vs actual behavior
- Adapter log with `loglevel=debug` if relevant
- For device-specific bugs: diagnostics export as above

---

## Code contributions

PRs gegen `main` (für 1.x-Hotfixes) bzw. `v2-prep` (für v2-Arbeit) sind willkommen. Vor dem PR:

PRs against `main` (for 1.x hotfixes) or `v2-prep` (for v2 work) are welcome. Before opening:

```bash
npm run build
npm test
npm run lint
npm run validate-devices
```

Alle vier müssen grün sein. Tests sind Pflicht für jeden neuen Code-Pfad.

All four must pass. Tests are required for every new code path.

---

## Wiki

User-Doku im [Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki) ist bilingual (DE + EN). Die Geräte-Seite wird via `npm run gen-wiki` aus `devices.json` generiert — manuelle Edits an `Geraete.md` / `Devices.md` werden überschrieben.

User-facing docs in the [Wiki](https://github.com/krobipd/ioBroker.govee-smart/wiki) are bilingual. The devices page is generated via `npm run gen-wiki` from `devices.json` — manual edits to `Geraete.md` / `Devices.md` get overwritten.
