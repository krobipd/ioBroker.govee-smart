import type { LocalSnapshot, LocalSnapshotStore, SnapshotSegment } from "./local-snapshots";
import { deviceLabel, type GoveeDevice } from "./types";
import { readDeviceBaseline, restoreSegmentsGrouped } from "./device-baseline";

/**
 * Host interface — the adapter functions the SnapshotHandler needs without
 * depending directly on the adapter class.
 *
 * Same pattern as `WizardHost` in segment-wizard.ts. Benefit: testable with
 * mocks, the dependency flow is explicit.
 */
export interface SnapshotHandlerHost {
  /** Adapter logger. */
  log: ioBroker.Logger;
  /** Local snapshot persistence (file-based JSON store). */
  store: LocalSnapshotStore;
  /** Adapter namespace prefix (e.g. "govee-smart.0"). */
  namespace: string;
  /** Resolved object prefix for a device (e.g. "devices.h61be_525f"). */
  devicePrefix: (device: GoveeDevice) => string;
  /** State-read (volles ID `<namespace>.<prefix>.<channel>.<state>`). */
  getState: (id: string) => Promise<ioBroker.State | null | undefined>;
  /** Send-command via LAN→Cloud-Routing (DeviceManager.sendCommand). */
  sendCommand: (device: GoveeDevice, command: string, value: unknown) => Promise<void>;
  /** Targeted state-tree refresh after save/delete (snapshot_local dropdown). */
  refreshDeviceStates: (device: GoveeDevice) => void;
}

/**
 * Local snapshot manager — encapsulates save/restore/delete for the
 * snapshot_save / snapshot_local / snapshot_delete dropdown states.
 *
 * Previously 3 private methods (~105 lines) in `main.ts`. Now its own class
 * with a host interface — testable in isolation, main.ts gets smaller,
 * maintainability improved.
 */
export class SnapshotHandler {
  /**
   * @param host Adapter dependencies via the host interface (testable with mocks)
   */
  constructor(private readonly host: SnapshotHandlerHost) {}

  /**
   * Save current device state as a local snapshot.
   *
   * @param device Target device
   * @param name Snapshot name
   */
  async save(device: GoveeDevice, name: string): Promise<void> {
    // Read control + per-segment state in parallel (single round-trip).
    const base = await readDeviceBaseline(this.host, device, { color: "#000000", brightness: 100 });

    const snapshot: LocalSnapshot = {
      name,
      power: base.power === true,
      brightness: base.brightness ?? 0,
      colorRgb: base.colorRgb ?? "#000000",
      colorTemperature: base.colorTemperature ?? 0,
      segments: base.segments.length > 0 ? base.segments : undefined,
      savedAt: Date.now(),
    };

    await this.host.store.saveSnapshot(device.sku, device.deviceId, snapshot);
    this.host.log.info(`Local snapshot saved: "${name}" for ${deviceLabel(device)}`);
    // Targeted refresh — only this device's snapshot_local dropdown changed.
    this.host.refreshDeviceStates(device);
  }

  /**
   * Restore a local snapshot by index.
   *
   * @param device Target device
   * @param val Dropdown index value
   */
  async restore(device: GoveeDevice, val: ioBroker.StateValue): Promise<void> {
    const idx = parseInt(String(val), 10);
    if (idx < 1) {
      return;
    }
    const snaps = this.host.store.getSnapshots(device.sku, device.deviceId);
    const snap = snaps[idx - 1];
    if (!snap) {
      this.host.log.warn(`Local snapshot index ${idx} not found for ${deviceLabel(device)}`);
      return;
    }
    this.host.log.info(`Restoring local snapshot "${snap.name}" for ${deviceLabel(device)}`);

    // Send each state via LAN → Cloud routing
    await this.host.sendCommand(device, "power", snap.power);
    if (snap.power) {
      await this.host.sendCommand(device, "brightness", snap.brightness);
      if (snap.colorTemperature > 0) {
        await this.host.sendCommand(device, "colorTemperature", snap.colorTemperature);
      } else {
        await this.host.sendCommand(device, "colorRgb", snap.colorRgb);
      }
      // Restore per-segment states via ptReal. Group segments by identical
      // (color, brightness) values and send one segmentBatch per group —
      // a sequential per-segment loop would multiply forceColorMode's 150 ms
      // settle delay by N×2 (~9 s for a 30-segment strip).
      if (snap.segments && snap.segments.length > 0) {
        await this.restoreSegments(device, snap.segments);
      }
    }
  }

  /**
   * Restore per-segment color + brightness via the shared
   * {@link restoreSegmentsGrouped} helper — one segmentBatch per distinct
   * (color, brightness) tuple. Snapshot segments are array-positioned, so the
   * array index IS the segment index.
   *
   * @param device Target device
   * @param segments Per-segment color + brightness data
   */
  private async restoreSegments(device: GoveeDevice, segments: SnapshotSegment[]): Promise<void> {
    await restoreSegmentsGrouped(
      this.host.sendCommand,
      device,
      segments.map((s, idx) => ({ idx, color: s.color, brightness: s.brightness })),
    );
  }

  /**
   * Delete a local snapshot by name.
   *
   * @param device Target device
   * @param name Snapshot name to delete
   */
  async delete(device: GoveeDevice, name: string): Promise<void> {
    if (await this.host.store.deleteSnapshot(device.sku, device.deviceId, name)) {
      this.host.log.info(`Local snapshot deleted: "${name}" for ${deviceLabel(device)}`);
      // Targeted refresh — only this device's snapshot_local dropdown changed.
      this.host.refreshDeviceStates(device);
    } else {
      this.host.log.warn(`Local snapshot "${name}" not found for ${deviceLabel(device)}`);
    }
  }
}
