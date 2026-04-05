# CLAUDE.md — ioBroker.govee

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.
> Vollständige API-Recherche: Memory `research_govee.md`

## Projekt

**ioBroker Govee Adapter** — Steuert Govee Smart-Home-Geräte. LAN first, MQTT für Echtzeit-Status, Cloud nur wo nötig.

- **Version:** 0.1.0 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.govee
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

**Nur Geräte mit lokaler API.** Primär Lights (H6xxx/H7xxx).

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

```
govee.0.
├── info.connection
└── devices.
    ├── h6160_1f80c532.
    │   ├── info.name                  ─ "Wohnzimmer LED Strip"
    │   ├── info.model                 ─ "H6160"
    │   ├── info.online                ─ true
    │   ├── power                      ─ true (write)
    │   ├── brightness                 ─ 80 (write, 0-100)
    │   ├── colorRgb                   ─ "#FF6600" (write)
    │   ├── colorTemperature           ─ 4000 (write, 2000-9000)
    │   ├── scene                      ─ "Sunset" (write, select mit states-Property)
    │   └── segments.
    │       ├── count                  ─ 15 (read-only)
    │       ├── 0.
    │       │   ├── color              ─ "#FF0000" (write)
    │       │   └── brightness         ─ 80 (write)
    │       └── 1.
    │           ├── color              ─ "#00FF00" (write)
    │           └── brightness         ─ 100 (write)
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
6. **Nahtlos** — User merkt nicht welcher Kanal
7. **Kein BLE** — ptReal/BLE-Passthrough nicht nutzen

## Tests (66)

```
test/testCapabilityMapper.ts → Capability Mapping (on_off, range, color, scenes, property, toggle) (9 Tests)
test/testDeviceManager.ts    → Device Manager (LAN discovery, IP update, MQTT status, filtering) (5 Tests)
test/testRateLimiter.ts      → Rate Limiter (per-minute, per-day, queueing) (4 Tests)
test/testPackageFiles.ts     → @iobroker/testing (48 Tests)
```

Nicht getestet (bewusst): main.ts Lifecycle, MQTT/LAN-Clients (Netzwerk), Cloud-Client (HTTP).

## Versionshistorie

| Version | Highlights |
|---------|------------|
| 0.1.0 | Initial: LAN UDP, AWS IoT MQTT, Cloud API v2, Szenen, Segmente, 66 Tests |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
