# CLAUDE.md — ioBroker.govee-smart

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Vollständige API-Recherche: Memory `research_govee.md`

## Projekt

**ioBroker Govee Smart Adapter** — Steuert Govee Smart-Home-Geräte. LAN first, MQTT für Echtzeit-Status, Cloud nur wo nötig.

- **Version:** 0.3.0 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.govee-smart
- **npm:** (noch nicht published)
- **Runtime-Deps:** `@iobroker/adapter-core`, `mqtt`, `node-forge`

## Kanal-Priorität: LAN → MQTT → Cloud

Jeder Kanal hat genau eine Rolle. Kein Overlap.

| Feature | LAN UDP (1.) | MQTT (2.) | Cloud REST (3.) |
|---------|-------------|-----------|----------------|
| Steuern (Power, Brightness, Color) | **primär** | Fallback | letzter Ausweg |
| Status anfragen | **primär** | Fallback | letzter Ausweg |
| Status Push (echtzeit) | — | **einzige Quelle** | — |
| Geräteliste + Capabilities | — | — | **einzige Quelle** |
| Szenen | — | — | **einzige Quelle** |
| Segmente | — | — | **einzige Quelle** |

**Nur Geräte mit lokaler API.** Siehe [Supported devices](https://app-h5.govee.com/user-manual/wlan-guide).

## Credential-Stufen (graceful degradation)

| Eingabe | Funktionsumfang |
|---------|----------------|
| Nichts | LAN-only: Discovery, Power, Brightness, Color, Status |
| + API Key | + Geräteliste mit Namen, Capabilities, Szenen, Segmente |
| + Email/Passwort | + Echtzeit Status-Push via MQTT |

Admin UI: Drei Sektionen mit Hinweis was man bekommt. Klar dokumentiert.

## Architektur

```
src/main.ts                   → Lifecycle, StateChange
src/lib/types.ts              → Interfaces (API, Config, Capabilities, Devices)
src/lib/govee-cloud-client.ts → Cloud REST API v2 (Devices, Capabilities, Szenen, Segmente)
src/lib/govee-mqtt-client.ts  → AWS IoT MQTT (Status-Push + Control Fallback)
src/lib/govee-lan-client.ts   → LAN UDP (Discovery + Control + Status)
src/lib/device-manager.ts     → LAN → MQTT → Cloud Routing, unsichtbar für User
src/lib/rate-limiter.ts       → Rate-Limits für Cloud REST Calls
src/lib/capability-mapper.ts  → Capability → ioBroker State Definition
src/lib/state-manager.ts      → State CRUD + Cleanup
```

## State Tree

Ordnername = immer `sku_shortid` (z.B. `h61be_1d6f`). Cloud-Name nur in `common.name`. Gruppen unter `groups/`.

```
govee-smart.0.
├── info.connection
├── devices.
│   └── h61be_1d6f.                  (SKU + letzte 4 Hex der Device-ID)
│       ├── info.name / .model / .serial / .online
│       ├── control.power / .brightness / .colorRgb / .colorTemperature / .scene
│       └── segments.count / .0.color / .0.brightness
└── groups.
    └── basegroup_1280.              (Govee-Gruppen)
```

## Szenen-Steuerung

State mit `states`-Property (Dropdown):
```
device.scene → type: string, write: true
               states: { "id1": "Sunset", "id2": "Rainbow", ... }
```
Szenen-Liste von Cloud, als states-Objekt. User wählt aus — kein ID-Tippen.

## Segment-Steuerung

Pro Segment eigene States, dynamisch aus Capabilities:
- Jedes Segment wie ein Mini-Licht (color + brightness)
- Anzahl aus Capability-Definition
- Steuerung über Cloud REST (einziger Kanal für Segmente)

## Cloud REST API v2

**Base URL:** `https://openapi.api.govee.com`
**Auth:** Header `Govee-API-Key: <key>`

### Rate Limits
- 10/min/Gerät, 10.000/Tag (allgemein)
- Appliances: **100/Tag** (!)
- Rate-Limiter schützt, Cloud nur als letzter Ausweg

## AWS IoT MQTT

### Auth-Flow
1. Login: `POST app2.govee.com/.../login` → token + accountId + topic
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

**1. LAN (immer aktiv)**
- Hinweis: "Geräte mit aktivierter LAN-Funktion werden automatisch gefunden"

**2. Cloud API (optional)**
- API Key (password, encrypted)
- Hinweis: "Ermöglicht Szenen, Segmente und Gerätenamen"

**3. Govee Account (optional)**
- Email (text)
- Passwort (password, encrypted)
- Hinweis: "Ermöglicht Echtzeit Status-Updates"

**4. Einstellungen**
- Poll Interval (number, default 60s — nur Cloud-Geräteliste-Refresh)
- Connection Check Button

**5. Donation**

## Design-Prinzipien

1. **LAN first** — schnellster Kanal, Kern des Adapters
2. **MQTT für Echtzeit** — Status-Push, Steuer-Fallback
3. **Cloud nur wo nötig** — Definitionen, Szenen, Segmente
4. **Graceful degradation** — ohne Credentials: LAN-only funktioniert
5. **Capability-driven** — States aus API generiert, nichts hardcodiert
6. **LAN-first States** — Basis-States immer aus LAN-Defaults, Cloud nur Extras
7. **Stabile Ordner** — `sku_shortid`, Cloud-Name nur in `common.name`
8. **Gruppen-Ordner** — BaseGroup unter `groups/`, Devices unter `devices/`
9. **Nahtlos** — User merkt nicht welcher Kanal
10. **Kein BLE** — ptReal/BLE-Passthrough nicht nutzen

## Tests (78)

```
test/testCapabilityMapper.ts → Capability Mapping (on_off, range, color, scenes, property, toggle, LAN defaults) (11 Tests)
test/testDeviceManager.ts    → Device Manager (LAN discovery, IP update, MQTT status, filtering, SKU collision) (6 Tests)
test/testRateLimiter.ts      → Rate Limiter (per-minute, per-day, queueing) (4 Tests)
test/testPackageFiles.ts     → @iobroker/testing (57 Tests)
```

Nicht getestet (bewusst): main.ts Lifecycle, MQTT/LAN-Clients (Netzwerk), Cloud-Client (HTTP).

## Versionshistorie

| Version | Highlights |
|---------|------------|
| 0.3.0 | Stabile sku_shortid Ordner, LAN-first States, MQTT Login v2 Fix, Gruppen-Ordner, Unit-Normalisierung |
| 0.2.1 | Fix SKU collision (short-ID suffix), deploy workflow build step |
| 0.2.0 | control/ channel, info.serial, stale cleanup |
| 0.1.x | Initial: LAN UDP, AWS IoT MQTT, Cloud API v2, Szenen, Segmente |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
