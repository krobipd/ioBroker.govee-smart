# Older Changes

## 0.1.2 (2026-04-06)

- Fix LAN discovery race condition: listen socket ready before first scan

## 0.1.1 (2026-04-05)

- Fix LAN-only devices missing control states (power, brightness, color, colorTemperature)
- Fix LAN status matching by source IP instead of broadcasting to all devices
- Request device status immediately after LAN discovery

## 0.1.0 (2026-04-05)

- Initial release
- LAN UDP discovery and control
- AWS IoT MQTT real-time status and control
- Cloud API v2 for capabilities, scenes, segments
- Automatic channel routing (LAN > MQTT > Cloud)
