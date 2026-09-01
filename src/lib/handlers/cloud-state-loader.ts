import { LAN_STATE_IDS, mapCloudStateValue, planCloudCapabilityWrites } from "../capability-mapper";
import type { DeviceManager } from "../device-manager";
import type { GoveeCloudClient } from "../govee-cloud-client";
import type { RateLimiter } from "../rate-limiter";
import type { StateManager } from "../state-manager";
import { deviceLabel, logRejected, type CloudStateCapability, type GoveeDevice } from "../types";

/**
 * Adapter surface required by the cloud-state-loader helpers. Loose
 * `setState` for utils.Adapter structural matching.
 */
export interface CloudStateLoaderAdapter {
  readonly log: ioBroker.Logger;
  readonly cloudClient: GoveeCloudClient | null;
  readonly deviceManager: DeviceManager | null;
  readonly stateManager: StateManager | null;
  readonly rateLimiter: RateLimiter | null;
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
}

/**
 * Load current state for Cloud devices and populate state values.
 * Called after the initial Cloud device list load, on Cloud recovery,
 * and (scoped via `only`) by the per-device refresh_cloud button.
 *
 * LAN-first: never overwrite LAN states with Cloud values. For
 * LAN-capable devices, the LAN state IDs are filtered out — Cloud only
 * fills the gaps the LAN client doesn't cover.
 *
 * Every /device/state call runs through the RateLimiter (background
 * priority, same as scene loads): a fleet-sized burst would otherwise
 * blow the per-minute safety budget and bypass the daily accounting —
 * including the 100/day appliance budget. On an exhausted budget the
 * calls queue and the values land when budget frees up.
 *
 * @param adapter Adapter surface
 * @param only    When set, load only this device (per-device refresh)
 */
export async function loadCloudStates(adapter: CloudStateLoaderAdapter, only?: GoveeDevice): Promise<void> {
  if (!adapter.cloudClient || !adapter.deviceManager || !adapter.stateManager) {
    return;
  }

  const targets = adapter.deviceManager
    .getDevices()
    .filter(d => d.channels.cloud && d.capabilities.length > 0 && (!only || d === only));

  for (const device of targets) {
    const loadOne = async (): Promise<void> => {
      if (!adapter.cloudClient || !adapter.stateManager) {
        return;
      }
      try {
        const caps = await adapter.cloudClient.getDeviceState(device.sku, device.deviceId);
        const prefix = adapter.stateManager.devicePrefix(device);

        const writes: Promise<unknown>[] = [];
        for (const cap of caps) {
          const mapped = mapCloudStateValue(cap);
          if (!mapped) {
            continue;
          }
          if (device.lanIp && LAN_STATE_IDS.has(mapped.stateId)) {
            continue;
          }
          const statePath = adapter.stateManager.resolveStatePath(prefix, mapped.stateId);
          // Fire-and-forget — States are created before loadCloudStates runs;
          // a rejection here means the state was deleted out-of-band and
          // can be safely ignored.
          writes.push(
            adapter
              .setState(statePath, { val: mapped.value, ack: true })
              .catch(logRejected(adapter.log, `write ${statePath}`)),
          );
        }
        await Promise.all(writes);
        adapter.log.debug(`Cloud state loaded for ${deviceLabel(device)}`);
      } catch (e) {
        // v2.9.1 — record failure with HTTP status (and HttpError.responseBody
        // when available) so the diag JSON shows why state-load failed instead
        // of just "could not load". Previously this catch was silent — Class
        // C2 of the v2.9.1 diag-coverage audit.
        if (adapter.deviceManager) {
          const status =
            e && typeof e === "object" && "statusCode" in e ? (e as { statusCode?: number }).statusCode : undefined;
          adapter.deviceManager
            .getDiagnostics()
            .recordApiFailure(device.deviceId, "/router/api/v1/device/state", e, status);
        }
        adapter.log.debug(`Could not load Cloud state for ${deviceLabel(device)}`);
      }
    };
    if (adapter.rateLimiter) {
      await adapter.rateLimiter.tryExecute(loadOne, 2);
    } else {
      await loadOne();
    }
  }

  if (targets.length > 0) {
    adapter.log.debug(`Cloud state load dispatched for ${targets.length} device(s) (rate-limited)`);
  }
}

/**
 * Apply a list of synthesized Cloud-state capabilities to a single device —
 * the App-API poll and OpenAPI-MQTT events both use this path so their
 * values flow through the same `mapCloudStateValue` pipeline that polled
 * Cloud states use.
 *
 * App-API and OpenAPI-MQTT deliver state IDs (battery, temperature,
 * humidity, lackWater, …) that the Cloud-capability pipeline doesn't
 * declare for sensor/appliance SKUs — the state objects therefore don't
 * exist yet on first write. ensureSyntheticStateObject creates them
 * lazily with the right channel + role + unit.
 *
 */
export async function applyCloudCapabilities(
  adapter: CloudStateLoaderAdapter,
  device: GoveeDevice,
  caps: CloudStateCapability[],
): Promise<void> {
  if (!adapter.stateManager) {
    return;
  }
  const prefix = adapter.stateManager.devicePrefix(device);
  const planned = planCloudCapabilityWrites(caps, Boolean(device.lanIp), LAN_STATE_IDS);
  for (const mapped of planned) {
    await adapter.stateManager.ensureSyntheticStateObject(prefix, mapped.stateId);
    // v2.9.1 — mirror appliance/sensor values into device.state so the diag-
    // export `state` field is honest about non-Light runtime state. Without
    // this, `state` only ever held Light fields (power/brightness/color/
    // colorTemperature/scene) because handleLanStatus/handleMqttStatus were
    // the only writers — App-API + OpenAPI-MQTT routed straight to setState
    // without touching the in-memory device. Diag-export then showed an
    // empty `state: {online: ?}` for sensors / appliances even though the
    // real values lived in the state tree.
    if (mapped.value !== null && mapped.value !== undefined) {
      (device.state as Record<string, unknown>)[mapped.stateId] = mapped.value;
    }
  }
  const writes = planned.map(mapped => {
    const statePath = adapter.stateManager!.resolveStatePath(prefix, mapped.stateId);
    return adapter
      .setState(statePath, { val: mapped.value, ack: true })
      .catch(logRejected(adapter.log, `write ${statePath}`));
  });
  await Promise.all(writes);

  // Remove a phantom `sensor_humidity` datapoint on a temp-only thermometer:
  // Govee reports `hum:0` for devices without a humidity sensor (e.g. H5109),
  // which older versions turned into a permanent `sensor_humidity=0` state
  // (#31 inspee). A device that declares sensorTemperature but not
  // sensorHumidity has no humidity sensor — drop the orphan once. A real
  // hygrometer (sensorHumidity capability) is never touched.
  const hasTempCap = device.capabilities.some(c => c.instance === "sensorTemperature");
  const hasHumidityCap = device.capabilities.some(c => c.instance === "sensorHumidity");
  if (hasTempCap && !hasHumidityCap) {
    await adapter.stateManager.removeSyntheticStateOnce(prefix, "sensor_humidity");
  }
}
