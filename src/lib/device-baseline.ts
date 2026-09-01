import type { GoveeDevice } from "./types";

/** A device's captured control + per-segment state. */
export interface DeviceBaseline {
  /** Power state, or undefined when the control.power state was unreadable. */
  power?: boolean;
  /** Brightness 0-100, or undefined when unreadable. */
  brightness?: number;
  /** Color as "#RRGGBB", or undefined when unreadable. */
  colorRgb?: string;
  /** Color temperature in Kelvin, or undefined when unreadable. */
  colorTemperature?: number;
  /** Per-segment color + brightness for indices 0..segmentCount-1. */
  segments: { color: string; brightness: number }[];
}

/** Minimal host surface needed to read a device's state tree. */
export interface BaselineReadSurface {
  /** Adapter namespace (e.g. "govee-smart.0"). */
  readonly namespace: string;
  /** Resolve a device's state-tree prefix below the namespace. */
  devicePrefix: (device: GoveeDevice) => string;
  /** Read a state value by full id. */
  getState: (id: string) => Promise<{ val: unknown } | null | undefined>;
}

/**
 * Read a device's current control states (power / brightness / colorRgb /
 * colorTemperature) plus its per-segment color + brightness in parallel — one
 * round-trip's worth of latency instead of segmentCount × 2 sequential reads.
 * Shared by snapshot-handler.save and segment-wizard.captureBaseline; each
 * caller maps the returned {@link DeviceBaseline} onto its own shape.
 *
 * @param surface Host surface (namespace + devicePrefix + getState)
 * @param device Target device
 * @param segDefault Fallback for an unreadable segment state
 * @param segDefault.color Fallback color hex for an unreadable segment
 * @param segDefault.brightness Fallback brightness 0-100 for an unreadable segment
 */
export async function readDeviceBaseline(
  surface: BaselineReadSurface,
  device: GoveeDevice,
  segDefault: { color: string; brightness: number },
): Promise<DeviceBaseline> {
  const prefix = surface.devicePrefix(device);
  const ns = surface.namespace;
  const segCount = device.segmentCount ?? 0;
  const segIds: string[] = [];
  for (let i = 0; i < segCount; i++) {
    segIds.push(`${ns}.${prefix}.segments.${i}.color`, `${ns}.${prefix}.segments.${i}.brightness`);
  }
  const [power, brightness, colorRgb, colorTemperature, ...segValues] = await Promise.all([
    surface.getState(`${ns}.${prefix}.control.power`).then(s => s?.val),
    surface.getState(`${ns}.${prefix}.control.brightness`).then(s => s?.val),
    surface.getState(`${ns}.${prefix}.control.color_rgb`).then(s => s?.val),
    surface.getState(`${ns}.${prefix}.control.color_temperature`).then(s => s?.val),
    ...segIds.map(id => surface.getState(id).then(s => s?.val)),
  ]);
  const segments: DeviceBaseline["segments"] = [];
  for (let i = 0; i < segCount; i++) {
    const c = segValues[i * 2];
    const b = segValues[i * 2 + 1];
    segments.push({
      color: typeof c === "string" ? c : segDefault.color,
      brightness: typeof b === "number" ? b : segDefault.brightness,
    });
  }
  return {
    power: typeof power === "boolean" ? power : undefined,
    brightness: typeof brightness === "number" ? brightness : undefined,
    colorRgb: typeof colorRgb === "string" ? colorRgb : undefined,
    colorTemperature: typeof colorTemperature === "number" ? colorTemperature : undefined,
    segments,
  };
}

/**
 * Replay a captured per-segment gradient onto a device — one `segmentBatch`
 * per distinct (colour, brightness) tuple, so a 3-zone gradient restores in 3
 * batches instead of segmentCount sequential writes (each batch pays
 * forceColorMode's settle delay once). Malformed colours fall back to black,
 * missing brightness to 100 — matching the capture-side defaults.
 *
 * Shared by SnapshotHandler.restoreSegments (local-snapshot restore) and
 * SegmentWizard.restoreBaseline (wizard end/abort) — the grouping logic lived
 * as two drifting copies before.
 *
 * @param sendCommand Command dispatcher (DeviceManager.sendCommand via host)
 * @param device Target device
 * @param segments Per-segment colour + brightness with explicit indices
 */
export async function restoreSegmentsGrouped(
  sendCommand: (device: GoveeDevice, command: string, value: unknown) => Promise<void>,
  device: GoveeDevice,
  segments: { idx: number; color: string; brightness: number }[],
): Promise<void> {
  const groups = new Map<string, { segments: number[]; color: number; brightness: number }>();
  for (const seg of segments) {
    const hex = typeof seg.color === "string" && /^#?[0-9a-fA-F]{6}$/.test(seg.color) ? seg.color : "#000000";
    const color = parseInt(hex.replace("#", ""), 16);
    const brightness = typeof seg.brightness === "number" ? seg.brightness : 100;
    const key = `${color}:${brightness}`;
    const existing = groups.get(key);
    if (existing) {
      existing.segments.push(seg.idx);
    } else {
      groups.set(key, { segments: [seg.idx], color, brightness });
    }
  }
  for (const group of groups.values()) {
    await sendCommand(device, "segmentBatch", group);
  }
}
