import type * as utils from "@iobroker/adapter-core";
import { buildLanStateDefs, LAN_STATE_IDS, SENSOR_ROLE_UNIT, type StateDefinition } from "./capability-mapper";
import { GROUP_ICON, iconForGoveeType, shortenGoveeType } from "./device-icons";
import { resolveSegmentCount } from "./device-manager";
import { GOVEE_DEVICE_TYPE } from "./govee-constants";
import type { I18nKey } from "./i18n";
import { tDesc, tName } from "./i18n";
import type { DeviceState, GoveeDevice } from "./types";
import { mapKey, treeKey } from "./device-key";

/**
 * Channels whose state-set is fully described by capability-driven stateDefs.
 * Only these get the stale-state cleanup pass — `info` is intentionally absent
 * because it mixes capability-driven states (diagnostics_export/result) with
 * adapter-managed ones (online, model, serial, ip, members) that come from
 * ensureState instead of stateDefs. Cleaning `info` by stateDef-set would
 * delete the adapter-managed ones.
 */
const MANAGED_CHANNELS = ["control", "scenes", "music", "snapshots", "sensor", "events"];
/**
 * Display names used when the channel object is (re-)created. `info` is
 * listed here even though it's not in MANAGED_CHANNELS — capability-mapper
 * emits states with `channel: "info"`, and without this entry the create
 * path would overwrite the original "Device Information" name with the
 * literal "info".
 */
const CHANNEL_NAMES: Record<string, string> = {
  control: "Controls",
  scenes: "Scenes",
  music: "Music",
  snapshots: "Snapshots",
  sensor: "Sensor Data",
  events: "Events",
  info: "Device Information",
  diag: "Diagnostics",
};

/**
 * Synthetic capabilities written by the App-API poll and OpenAPI-MQTT
 * handler arrive as `(stateId, value)` pairs without a channel hint —
 * `mapCloudStateValue` returns only what the Govee response carries.
 *
 * For lights the LAN/Cloud-state pipeline pre-populates `stateChannelMap`
 * via `createDeviceStates`, so `resolveStatePath` finds the channel.
 * For thermometer/appliance state IDs that are *only* delivered via the
 * App-API path (battery, temperature, humidity, CO₂, lackWater, …) the map
 * is empty and the lookup would default to "control" — visibly wrong:
 * `info: control.battery has no existing object`.
 *
 * This routing table assigns those IDs to their semantic channel without
 * needing a separate `createDeviceStates` pass for sensor-only devices.
 * Keep IDs lowercase; resolveStatePath calls this on the raw stateId.
 */
// Two spellings per ID below — the "raw" form (e.g. `temperature`) for instances
// named exactly that, and the sanitizeId output (e.g. `sensor_temperature`) for
// camelCase instances that capability-mapper's sanitizeId converted to
// snake_case. Without the alias the sanitized variant would fall back to the
// safe default "control" and its state would be unreachable.

/**
 * Per-stateId metadata for synthetic states (App-API/OpenAPI-MQTT pipe). The
 * `channel` is the single source of truth for {@link inferChannelFromStateId},
 * so the routing and the state definition never drift apart.
 */
interface SyntheticStateMeta {
  type: "boolean" | "number";
  role: string;
  unit?: string;
  nameKey: I18nKey;
  /** Semantic channel — sensor readings vs. device events. */
  channel: "sensor" | "events";
}
/**
 * Numeric-sensor meta with role + unit pulled from the shared
 * {@link SENSOR_ROLE_UNIT}, so the App-API/MQTT path can't drift from the
 * Cloud-capability path. Booleans/events stay inline — they're heterogeneous.
 *
 * @param kind Sensor kind keying into {@link SENSOR_ROLE_UNIT}
 * @param nameKey i18n key for the state's display name
 */
const numSensor = (kind: keyof typeof SENSOR_ROLE_UNIT, nameKey: I18nKey): SyntheticStateMeta => ({
  type: "number",
  role: SENSOR_ROLE_UNIT[kind].role,
  unit: SENSOR_ROLE_UNIT[kind].unit,
  nameKey,
  channel: "sensor",
});
const SYNTHETIC_STATE_META: Record<string, SyntheticStateMeta> = {
  temperature: numSensor("temperature", "temperature"),
  humidity: numSensor("humidity", "humidity"),
  battery: numSensor("battery", "battery"),
  co2: numSensor("co2", "co2"),
  carbondioxide: numSensor("co2", "co2"),
  online: { type: "boolean", role: "indicator.connected", nameKey: "online", channel: "sensor" },
  lackwater: { type: "boolean", role: "indicator.maintenance", nameKey: "lackOfWater", channel: "events" },
  lackwaterevent: { type: "boolean", role: "indicator.maintenance", nameKey: "lackOfWater", channel: "events" },
  icefull: { type: "boolean", role: "indicator.maintenance", nameKey: "iceBucketFull", channel: "events" },
  icefullevent: { type: "boolean", role: "indicator.maintenance", nameKey: "iceBucketFull", channel: "events" },
  bodyappeared: { type: "boolean", role: "sensor.motion", nameKey: "bodyDetected", channel: "events" },
  dirtdetected: { type: "boolean", role: "indicator.maintenance", nameKey: "dirtDetected", channel: "events" },
  sensor_temperature: numSensor("temperature", "temperature"),
  sensor_humidity: numSensor("humidity", "humidity"),
  sensor_battery: numSensor("battery", "battery"),
  lack_water: { type: "boolean", role: "indicator.maintenance", nameKey: "lackOfWater", channel: "events" },
  lack_water_event: { type: "boolean", role: "indicator.maintenance", nameKey: "lackOfWater", channel: "events" },
  ice_full: { type: "boolean", role: "indicator.maintenance", nameKey: "iceBucketFull", channel: "events" },
  ice_full_event: { type: "boolean", role: "indicator.maintenance", nameKey: "iceBucketFull", channel: "events" },
  body_appeared: { type: "boolean", role: "sensor.motion", nameKey: "bodyDetected", channel: "events" },
  dirt_detected: { type: "boolean", role: "indicator.maintenance", nameKey: "dirtDetected", channel: "events" },
};

/**
 * Best-effort channel routing for a synthetic state ID with no stateChannelMap
 * entry yet (App-API caps before createDeviceStates). Reads the channel straight
 * from {@link SYNTHETIC_STATE_META}; an unknown ID falls back to the safe default
 * "control". Keep IDs lowercase — resolveStatePath calls this on the raw stateId.
 *
 * @param stateId The raw state ID (e.g. "battery", "lackWater")
 */
function inferChannelFromStateId(stateId: string): string {
  return SYNTHETIC_STATE_META[stateId.toLowerCase()]?.channel ?? "control";
}

/** Manages ioBroker state creation and updates for Govee devices */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  /** Maps deviceKey (sku_deviceId) → current object prefix */
  private readonly prefixMap = new Map<string, string>();
  /** Maps "prefix.stateId" → channel name (populated during createDeviceStates) */
  private readonly stateChannelMap = new Map<string, string>();
  /**
   * Cache of state IDs already created via {@link ensureState} — skips the
   * `extendObject` round-trip on the hot path. Refreshed on
   * {@link removeDevice}/{@link forgetPrefix} so a re-pair doesn't reuse stale
   * cache entries.
   */
  private readonly ensuredStates = new Set<string>();
  /**
   * "prefix.stateId" keys already handled by {@link removeSyntheticStateOnce} —
   * bounds the phantom-state cleanup to one existence-check per adapter run.
   */
  private readonly cleanedSyntheticStates = new Set<string>();

  /** @param adapter The ioBroker adapter instance */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Force-replace `common.states` on a persisted state object if any existing
   * value is non-string (= translation object from older releases).
   *
   * `extendObject` deep-merges and CANNOT replace an object-value with a
   * string. Only a full `setObjectAsync` replaces. Same fix-pattern as
   * hassemu v1.27.2 (URL-dropdown) and v1.28.4 (mode-dropdown). Admin
   * renders states-values as React children — a translation object triggers
   * React Error #31 → fatal "Error in GUI" on dropdown open (write:true) or
   * any render path (write:false like diag.tier).
   *
   * @param id    Full state path.
   * @param fresh Plain-string `common.states` map to write.
   */
  private async repairCommonStatesIfBuggy(id: string, fresh: Record<string, string>): Promise<void> {
    const existing = await this.adapter.getObjectAsync(id).catch(() => null);
    if (!existing) {
      return;
    }
    const states = existing.common?.states;
    if (!states || typeof states !== "object") {
      return;
    }
    const buggy = Object.values(states as Record<string, unknown>).some(v => typeof v !== "string");
    if (!buggy) {
      return;
    }
    await this.adapter.extendObject(id, { common: { states: fresh } }).catch(() => undefined);
  }

  /**
   * @param id Voller State-Pfad (`devices.X.info.Y`)
   */
  private async safeDeleteState(id: string): Promise<void> {
    const obj = await this.adapter.getObjectAsync(id).catch(() => null);
    if (!obj) {
      return;
    }
    await this.adapter.delStateAsync(id).catch(() => undefined);
    await this.adapter.delObjectAsync(id).catch(() => undefined);
  }

  /**
   * Remove a synthetic App-API/OpenAPI-MQTT sensor state (e.g. a phantom
   * `sensor_humidity` on a temp-only thermometer) at most once per adapter run.
   * These states are created ad-hoc by the App-API pipe and are NOT covered by
   * any def-driven cleanup, so a datapoint that should no longer exist (Govee's
   * `hum:0` sentinel on a device without a humidity capability, #31) would
   * otherwise linger forever. Existence-checked via {@link safeDeleteState}, so
   * it's a silent no-op on installs that never had the state.
   *
   * @param prefix Device object ID prefix
   * @param stateId Synthetic state ID (e.g. "sensor_humidity")
   */
  async removeSyntheticStateOnce(prefix: string, stateId: string): Promise<void> {
    const key = `${prefix}.${stateId}`;
    if (this.cleanedSyntheticStates.has(key)) {
      return;
    }
    this.cleanedSyntheticStates.add(key);
    await this.safeDeleteState(this.resolveStatePath(prefix, stateId));
  }

  /**
   * Push the device's trust tier (verified/reported/seed/unknown) into
   * the user-visible `diag.tier` state. Called after every device-state
   * refresh so the value tracks any registry change between adapter
   * restarts (e.g. seed → verified once a tester confirms). No-op for
   * groups (BaseGroup has no per-device tier).
   *
   * @param device Govee device
   * @param tier Canonical tier label
   */
  async updateDeviceTier(device: GoveeDevice, tier: string): Promise<void> {
    if (device.sku === "BaseGroup") {
      return;
    }
    const prefix = this.devicePrefix(device);
    await this.adapter.setState(`${prefix}.diag.tier`, { val: tier, ack: true }).catch(() => undefined);
  }

  /**
   * Migrate v2.1.0 layout (`info.diagnostics_*`) to v2.1.1 layout
   * (`diag.*`). Deletes the three old objects + states; the new ones get
   * created by the regular `createDeviceStates` pass. Idempotent — calling
   * twice is a no-op once the old objects are gone.
   *
   * @param device Govee device
   */
  async migrateLegacyDiagnostics(device: GoveeDevice): Promise<void> {
    if (device.sku === "BaseGroup") {
      return;
    }
    const prefix = this.devicePrefix(device);
    for (const stale of ["diagnostics_export", "diagnostics_result", "diagnostics_tier"]) {
      await this.safeDeleteState(`${prefix}.info.${stale}`);
      this.stateChannelMap.delete(`${prefix}.${stale}`);
    }
  }

  /**
   * B2 hard-cut migration: the LAN control colour states were renamed from
   * camelCase (`control.colorRgb` / `control.colorTemperature`) to snake_case
   * (`control.color_rgb` / `control.color_temperature`) for a consistent
   * state-tree spelling. Delete the old objects on upgraded installs so they
   * don't linger as dead duplicates next to the freshly-created snake_case
   * states. Existence-checked + idempotent (a no-op once migrated / on fresh
   * installs); works for devices AND groups (both carry these control states).
   * Users must update scripts that referenced the old ids.
   *
   * @param device Govee device or group
   */
  async migrateLegacyColorStateIds(device: GoveeDevice): Promise<void> {
    const prefix = this.devicePrefix(device);
    await this.safeDeleteState(`${prefix}.control.colorRgb`);
    await this.safeDeleteState(`${prefix}.control.colorTemperature`);
  }

  /**
   * Resolve full state path for a given device prefix and state ID.
   * Routes the state to the correct channel (control, scenes, music, snapshots).
   *
   * @param prefix Device object ID prefix
   * @param stateId State ID suffix
   */
  resolveStatePath(prefix: string, stateId: string): string {
    const channel = this.stateChannelMap.get(`${prefix}.${stateId}`) ?? inferChannelFromStateId(stateId);
    return `${prefix}.${channel}.${stateId}`;
  }

  /**
   * Lazily create the channel + state object for synthetic state IDs the
   * App-API poll and OpenAPI-MQTT pipeline write. Cloud-capability defs
   * for sensor SKUs (e.g. H5179) are often empty in OpenAPI v2, so the
   * usual `createDeviceStates` pass would not declare battery / temperature
   * / events.* — without this helper the first write logs
   * `info: <id> has no existing object`.
   *
   * Idempotent: skips when the meta table doesn't know the stateId, and
   * `setObjectNotExistsAsync` is itself a no-op for existing objects.
   *
   * @param prefix Device prefix (e.g. "devices.h5179_aabb")
   * @param stateId State ID without channel (e.g. "battery")
   */
  async ensureSyntheticStateObject(prefix: string, stateId: string): Promise<void> {
    const meta = SYNTHETIC_STATE_META[stateId.toLowerCase()];
    if (!meta) {
      return;
    }
    const channel = inferChannelFromStateId(stateId);
    // Channel object first — sensors land in the new sensor/ subtree, events
    // in events/. Without an extendObject the channel parent stays missing
    // and Admin shows the state directly under the device root.
    await this.adapter
      .extendObject(
        `${prefix}.${channel}`,
        {
          type: "channel",
          common: { name: CHANNEL_NAMES[channel] ?? channel },
          native: {},
        },
        { preserve: { common: ["name"] } },
      )
      .catch(() => undefined);
    await this.adapter
      .extendObject(
        `${prefix}.${channel}.${stateId}`,
        {
          type: "state",
          common: {
            name: tName(meta.nameKey),
            type: meta.type,
            role: meta.role,
            read: true,
            write: false,
            ...(meta.unit !== undefined ? { unit: meta.unit } : {}),
            def: meta.type === "boolean" ? false : 0,
          },
          native: {},
        },
        { preserve: { common: ["name"] } },
      )
      .catch(() => undefined);
    this.stateChannelMap.set(`${prefix}.${stateId}`, channel);
  }

  /**
   * Phase 1 — Info-States. Always-existing device metadata: info.name,
   * info.online (per-device for lights, global for groups), info.model,
   * info.serial, info.ip, info.type. For groups: info.members + cleanup
   * of legacy device-level info states.
   *
   * Idempotent. Called from every phase callback (LAN-Phase + Cloud-Phase
   * + Group-Phase) — extendObject de-duplicates so the cost is small.
   *
   * Never deletes states from MANAGED_CHANNELS. The info channel is not in
   * MANAGED_CHANNELS, so cleanup never touches its content.
   *
   * @param device Govee device
   */
  async createInfoStates(device: GoveeDevice): Promise<void> {
    const key = this.deviceKey(device);
    const newPrefix = this.devicePrefix(device);
    const oldPrefix = this.prefixMap.get(key);

    // Migrate if prefix changed (e.g., old naming scheme)
    if (oldPrefix && oldPrefix !== newPrefix) {
      this.adapter.log.debug(`Migrating device ${device.sku}: ${oldPrefix} → ${newPrefix}`);
      await this.adapter.delObjectAsync(oldPrefix, { recursive: true });
      // Drop stale channel-map entries under the old prefix so they don't
      // shadow resolveStatePath lookups after the rename.
      const oldChannelKey = `${oldPrefix}.`;
      for (const mapKey of this.stateChannelMap.keys()) {
        if (mapKey.startsWith(oldChannelKey)) {
          this.stateChannelMap.delete(mapKey);
        }
      }
    }
    this.prefixMap.set(key, newPrefix);

    const prefix = newPrefix;
    const isGroup = device.sku === "BaseGroup";

    // Device object with online status indicator + type-aware icon.
    // Groups use the general groups.info.online state instead of per-group online.
    const onlineId = isGroup
      ? `${this.adapter.namespace}.groups.info.online`
      : `${this.adapter.namespace}.${prefix}.info.online`;
    const icon = isGroup ? GROUP_ICON : iconForGoveeType(device.type);
    await this.adapter.extendObject(
      prefix,
      {
        type: "device",
        common: {
          name: device.name,
          icon,
          statusStates: { onlineId },
        },
        native: {
          sku: device.sku,
          deviceId: device.deviceId,
        },
      },
      { preserve: { common: ["name"] } },
    );

    // Info channel — groups only get name (no individual online)
    await this.adapter.extendObject(
      `${prefix}.info`,
      {
        type: "channel",
        common: { name: tName("deviceInformation") },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );

    // setStateChangedAsync (not setState) for the info metadata below:
    // createInfoStates re-runs on every phase callback (cloud refresh,
    // snapshot save/delete, …) with mostly identical values — only a real
    // change should write and bump the timestamp. No consumer reads the
    // ts/lc of these states as a freshness signal (grep-verified).
    await this.ensureState(`${prefix}.info.name`, "Name", "string", "text", false);
    await this.adapter.setStateChangedAsync(`${prefix}.info.name`, {
      val: device.name,
      ack: true,
    });

    if (!isGroup) {
      await this.ensureState(
        `${prefix}.info.online`,
        "Online",
        "boolean",
        "indicator.reachable",
        false,
        undefined,
        false,
      );
      // info.online is written via syncInfoOnline (resolver-based, no
      // ts-rewrite-spam). The initial sync happens right after this method
      // returns — see syncInfoOnline. Direct write here was the source of
      // periodic false→true bounces (captured 2026-05-13).
      await this.ensureState(`${prefix}.info.model`, "Model", "string", "text", false, undefined, "");
      await this.ensureState(`${prefix}.info.serial`, "Serial Number", "string", "text", false, undefined, "");
      await this.ensureState(`${prefix}.info.ip`, "IP Address", "string", "info.ip", false, undefined, "");
      // Device-type marker — short label like "light", "thermometer",
      // "heater" (Govee API type without the "devices.types." prefix).
      // Lets scripts filter `*.info.type === "light"` without parsing.
      await this.ensureState(`${prefix}.info.type`, "Device Type", "string", "text", false, undefined, "");
      await this.adapter.setStateChangedAsync(`${prefix}.info.model`, {
        val: device.sku,
        ack: true,
      });
      await this.adapter.setStateChangedAsync(`${prefix}.info.serial`, {
        val: device.deviceId,
        ack: true,
      });
      await this.adapter.setStateChangedAsync(`${prefix}.info.ip`, {
        val: device.lanIp ?? "",
        ack: true,
      });
      await this.adapter.setStateChangedAsync(`${prefix}.info.type`, {
        val: shortenGoveeType(device.type),
        ack: true,
      });
      // Initial info.online sync — see syncInfoOnline for the resolver.
      // Subsequent updates come from the periodic sync timer in main.ts
      // and from direct calls in onDeviceStateUpdate when state.online
      // arrives via the existing event paths.
      await this.syncInfoOnline(device);
    } else {
      // Group members: comma-separated device prefix IDs
      const memberIds = (device.groupMembers ?? []).map(m => treeKey(m.sku, m.deviceId)).join(", ");
      await this.ensureState(`${prefix}.info.members`, "Members", "string", "text", false);
      await this.adapter.setStateChangedAsync(`${prefix}.info.members`, {
        val: memberIds,
        ack: true,
      });

      // Legacy cleanup — groups never carry device-level info states or
      // diagnostics, but older installs had them. Drop any leftovers so the
      // tree reflects the current layout.
      for (const staleId of [
        "online",
        "model",
        "serial",
        "ip",
        "diagnostics_export",
        "diagnostics_result",
        "diagnostics_tier",
      ]) {
        await this.safeDeleteState(`${prefix}.info.${staleId}`);
      }
      // Groups never had a `diag` channel — drop any leftover from migrated installs.
      await this.adapter.delObjectAsync(`${prefix}.diag`, { recursive: true }).catch(() => {});
    }
  }

  /**
   * Phase 2 — LAN-States. Power, brightness, colorRgb, colorTemperature
   * (the LAN-default set defined by getDefaultLanStates). Pure additive:
   * never deletes from MANAGED_CHANNELS, no cleanup at end. Devices without
   * lanIp get no states (sensors/appliances/groups skip silently).
   *
   * @param device Govee device
   */
  async createLanStates(device: GoveeDevice): Promise<void> {
    const stateDefs = buildLanStateDefs(device, this.adapter.log);
    if (stateDefs.length === 0) {
      this.adapter.log.debug(
        `buildLanStateDefs for ${device.sku} ${device.deviceId}: 0 states (no LAN IP / not a light) — LAN phase skipped`,
      );
      return;
    }
    this.adapter.log.debug(
      `buildLanStateDefs for ${device.sku} ${device.deviceId}: ${stateDefs.length} state(s) → writing to LAN channel`,
    );
    const prefix = this.devicePrefix(device);
    await this.writeStateDefsToChannels(prefix, stateDefs, "LAN");
  }

  /**
   * Phase 3 — Cloud-States. Capability-derived states (scenes, music,
   * snapshots, sensor, events, segments, cloud-only control toggles) plus
   * synthetic local states (diagnostics, refresh_cloud, snapshot_local/...).
   * Runs cleanupCloudOwnedStates at the end to remove states no longer
   * present in stateDefs — but LAN-default ids in the control channel are
   * preserved via the LAN_STATE_IDS skip.
   *
   * @param device Govee device
   * @param stateDefs Cloud-owned state definitions from buildCloudStateDefs
   */
  async createCloudStates(device: GoveeDevice, stateDefs: StateDefinition[]): Promise<void> {
    const prefix = this.devicePrefix(device);

    // Drop _segment_ marker entries — segments have their own dedicated
    // createSegmentStates pass (per-segment color/brightness states).
    const nonSegmentDefs = stateDefs.filter(d => !d.id.startsWith("_segment_"));
    await this.writeStateDefsToChannels(prefix, nonSegmentDefs, `Cloud ${device.sku}`);

    // Remove states no longer present in this Cloud-phase build. LAN_STATE_IDS
    // protects the LAN-default ids in the control channel — the LAN phase
    // owns those.
    await this.cleanupCloudOwnedStates(prefix, nonSegmentDefs);

    // Segment channel if device has segment caps
    if (stateDefs.some(d => d.id.startsWith("_segment_"))) {
      await this.createSegmentStates(device);
    }
  }

  /**
   * Shared inner loop — group stateDefs by channel, create the channel
   * object once, then create each state. Called from createLanStates and
   * createCloudStates. Idempotent (extendObject).
   *
   * @param prefix Device prefix (e.g. "devices.h6172_abcd")
   * @param stateDefs State definitions to write
   * @param logTag Short tag for the per-phase debug log line
   */
  private async writeStateDefsToChannels(prefix: string, stateDefs: StateDefinition[], logTag: string): Promise<void> {
    const channelGroups = new Map<string, StateDefinition[]>();
    for (const def of stateDefs) {
      const channel = def.channel ?? "control";
      this.stateChannelMap.set(`${prefix}.${def.id}`, channel);
      if (!channelGroups.has(channel)) {
        channelGroups.set(channel, []);
      }
      channelGroups.get(channel)!.push(def);
    }

    this.adapter.log.debug(
      `createStates [${logTag}] ${prefix}: ${stateDefs.length} states in ${channelGroups.size} channel(s)`,
    );

    for (const [channel, defs] of channelGroups) {
      await this.adapter.extendObject(
        `${prefix}.${channel}`,
        {
          type: "channel",
          common: { name: CHANNEL_NAMES[channel] ?? channel },
          native: {},
        },
        { preserve: { common: ["name"] } },
      );

      for (const def of defs) {
        const common: Partial<ioBroker.StateCommon> = {
          name: def.name as ioBroker.StringOrTranslated,
          type: def.type,
          role: def.role,
          read: true,
          write: def.write,
        };

        if (def.unit) {
          common.unit = def.unit;
        }
        if (def.min !== undefined) {
          common.min = def.min;
        }
        if (def.max !== undefined) {
          common.max = def.max;
        }
        if (def.states) {
          common.states = def.states;
        }
        if (def.def !== undefined) {
          common.def = def.def;
        }
        if (def.desc) {
          common.desc = def.desc as ioBroker.StringOrTranslated;
        }

        await this.adapter.extendObject(
          `${prefix}.${channel}.${def.id}`,
          {
            type: "state",
            common: common,
            native: {
              capabilityType: def.capabilityType,
              capabilityInstance: def.capabilityInstance,
            },
          },
          { preserve: { common: ["name"] } },
        );

        // Existing diag.tier datapoints from v2.6.0+ may carry translation-object
        // VALUES in common.states (the old buildCloudStateDefs wrote tLabel(...)
        // directly). extendObject deep-merges and cannot replace an
        // object-value with a string. Force-replace via setObjectAsync when
        // any persisted state value is non-string. Pattern proven in hassemu
        // v1.27.2 / v1.28.4. React Error #31 would otherwise fatal-crash Admin
        // on dropdown open (write:true states) or any view that renders the
        // value (write:false states like diag.tier).
        if (def.states) {
          await this.repairCommonStatesIfBuggy(`${prefix}.${channel}.${def.id}`, def.states);
        }

        // Initialize or validate state value
        if (def.def !== undefined) {
          const current = await this.adapter.getStateAsync(`${prefix}.${channel}.${def.id}`);
          if (!current || current.val === null || current.val === undefined) {
            // Set default value for new states
            await this.adapter.setState(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true,
            });
          } else if (def.states && !(String(current.val) in def.states)) {
            // Reset dropdown to default if current value is no longer valid
            this.adapter.log.debug(
              `Resetting stale dropdown: ${prefix}.${channel}.${def.id} = "${String(current.val)}" → "${String(def.def)}"`,
            );
            await this.adapter.setState(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true,
            });
          }
        }
      }
    }
  }

  /**
   * Create segment channel with per-segment color + brightness states.
   *
   * @param device Govee device
   */
  async createSegmentStates(device: GoveeDevice): Promise<void> {
    const prefix = this.devicePrefix(device);

    await this.adapter.extendObject(
      `${prefix}.segments`,
      {
        type: "channel",
        common: { name: tName("ledSegments") },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );

    // Resolve the authoritative count: cache/MQTT-learned wins over Cloud
    // capabilities. A manual list can only grow the count (never shrink it)
    // so users editing manual_list can reveal hidden indices without losing
    // the already-learned total.
    const resolved = resolveSegmentCount(device);
    const manualMax =
      Array.isArray(device.manualSegments) && device.manualSegments.length > 0
        ? Math.max(...device.manualSegments) + 1
        : 0;
    const segmentCount = Math.max(resolved, manualMax);
    device.segmentCount = segmentCount;

    // Effective segment list — honor manual override if active (cut-strip support)
    const validIndices =
      device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0
        ? device.manualSegments.slice().sort((a, b) => a - b)
        : Array.from({ length: segmentCount }, (_, i) => i);
    const reportedCount = validIndices.length;

    await this.ensureState(`${prefix}.segments.count`, tName("segmentCount"), "number", "value", false);
    await this.adapter.setState(`${prefix}.segments.count`, {
      val: reportedCount,
      ack: true,
    });

    // Manual-mode toggle and list — user-writable for cut-strip overrides
    await this.adapter.extendObject(
      `${prefix}.segments.manual_mode`,
      {
        type: "state",
        common: {
          name: tName("manualSegmentsActive"),
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
          def: false,
          desc: tDesc("manualSegmentsDesc"),
        },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );
    await this.adapter.extendObject(
      `${prefix}.segments.manual_list`,
      {
        type: "state",
        common: {
          name: tName("manualSegmentList"),
          type: "string",
          role: "text",
          read: true,
          write: true,
          def: "",
          desc: tDesc("manualListDesc"),
        },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );

    // Sync manual_mode / manual_list states back from the runtime device
    // (restored from cache on startup, or updated by the wizard). Using
    // ack=true keeps this out of the user-change handler path.
    const manualModeVal = device.manualMode === true;
    const manualListVal =
      device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0
        ? device.manualSegments.join(",")
        : "";
    await this.adapter.setState(`${prefix}.segments.manual_mode`, {
      val: manualModeVal,
      ack: true,
    });
    await this.adapter.setState(`${prefix}.segments.manual_list`, {
      val: manualListVal,
      ack: true,
    });

    for (const i of validIndices) {
      await this.adapter.extendObject(
        `${prefix}.segments.${i}`,
        {
          type: "channel",
          common: { name: `Segment ${i}` },
          native: {},
        },
        { preserve: { common: ["name"] } },
      );

      await this.adapter.extendObject(
        `${prefix}.segments.${i}.color`,
        {
          type: "state",
          common: {
            name: tName("color"),
            type: "string",
            role: "level.color.rgb",
            read: true,
            write: true,
            def: "#000000", // avoid null in vis until the first write (LAN-only tier) — B6
          },
          native: {},
        },
        { preserve: { common: ["name"] } },
      );

      await this.adapter.extendObject(
        `${prefix}.segments.${i}.brightness`,
        {
          type: "state",
          common: {
            name: tName("brightness"),
            type: "number",
            role: "level.brightness",
            read: true,
            write: true,
            min: 0,
            max: 100,
            unit: "%",
            def: 0, // avoid null in vis until the first write (LAN-only tier) — B6
          },
          native: {},
        },
        { preserve: { common: ["name"] } },
      );
    }

    // Comfort command state for batch segment control
    await this.adapter.extendObject(
      `${prefix}.segments.command`,
      {
        type: "state",
        common: {
          name: tName("batchSegmentCommand"),
          type: "string",
          role: "text",
          read: false,
          write: true,
          desc: tDesc("batchCommandDesc"),
        },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );

    // Remove segment channels that aren't in the valid list (supports gaps for manual mode)
    await this.cleanupExcessSegments(prefix, validIndices);
  }

  /**
   * Remove segment sub-channels that are not in the valid-indices list.
   * Supports gaps (e.g. manual list "0-8,10-14" → segment 9 channel gets removed).
   *
   * @param prefix Device prefix
   * @param validIndices Valid segment indices (all others will be deleted)
   */
  private async cleanupExcessSegments(prefix: string, validIndices: number[]): Promise<void> {
    const valid = new Set(validIndices);
    const segPrefix = `${this.adapter.namespace}.${prefix}.segments.`;
    const existing = await this.adapter.getObjectViewAsync("system", "channel", {
      startkey: segPrefix,
      endkey: `${segPrefix}\u9999`,
    });

    if (!existing?.rows) {
      return;
    }

    for (const row of existing.rows) {
      const localId = row.id.replace(`${this.adapter.namespace}.`, "");
      const segPart = localId.replace(`${prefix}.segments.`, "");
      const segIdx = parseInt(segPart, 10);
      if (!isNaN(segIdx) && !valid.has(segIdx)) {
        this.adapter.log.debug(`Removing excess segment: ${localId}`);
        // Drop orphan state values too — `delObjectAsync(recursive)` removes
        // the object tree but leaves the state-table values for color and
        // brightness behind. Without these explicit `delStateAsync` calls,
        // historical values would resurrect into a re-created segment after
        // a length change.
        await this.adapter.delStateAsync(`${localId}.color`).catch(() => undefined);
        await this.adapter.delStateAsync(`${localId}.brightness`).catch(() => undefined);
        await this.adapter.delObjectAsync(localId, { recursive: true });
      }
    }
  }

  /**
   * Update device state from any source (LAN, MQTT, Cloud).
   *
   * Writes are fire-and-forget and run in parallel — they're independent,
   * and the "does this state exist?" check that used to guard each write
   * was an extra object-read on the hot path (one MQTT push = one update
   * call). createDeviceStates has already run before any update lands,
   * so the states are guaranteed to exist; if one disappears (manual
   * deletion), the setState will reject and we swallow it.
   *
   * @param device Govee device
   * @param state Partial state update
   */
  async updateDeviceState(device: GoveeDevice, state: Partial<DeviceState>): Promise<void> {
    const prefix = this.devicePrefix(device);
    const writes: Promise<unknown>[] = [];

    const set = (id: string, val: ioBroker.StateValue): void => {
      // setStateChangedAsync (not setState): the LAN devStatus poll (every
      // 30 s when no MQTT is connected) re-delivers identical power / brightness
      // / colorRgb / colorTemperature each cycle — only write (and bump the
      // timestamp) on a real value change. Freshness lives on the device object
      // (lastLanReplyAt / lastSeenOnNetwork), not on these control-state ts.
      writes.push(this.adapter.setStateChangedAsync(id, { val, ack: true }).catch(() => undefined));
    };

    // info.online for Lights is owned by syncInfoOnline — direct writes here
    // would re-introduce the ts-rewrite-spam (every 2 min same value) and
    // the false-positive `true` writes from Cloud/MQTT paths. For Sensors/
    // Appliances the existing flow stays (applyOnlineCap → onDeviceUpdate →
    // here → info.online).
    if (state.online !== undefined && device.type !== GOVEE_DEVICE_TYPE.LIGHT) {
      set(`${prefix}.info.online`, state.online);
    }
    if (state.power !== undefined) {
      set(`${prefix}.control.power`, state.power);
    }
    if (state.brightness !== undefined) {
      set(`${prefix}.control.brightness`, state.brightness);
    }
    if (state.colorRgb !== undefined) {
      set(`${prefix}.control.color_rgb`, state.colorRgb);
    }
    if (state.colorTemperature !== undefined) {
      set(`${prefix}.control.color_temperature`, state.colorTemperature);
    }
    if (state.scene !== undefined) {
      set(`${prefix}.control.scene`, state.scene);
    }

    await Promise.all(writes);
  }

  /**
   * Create the general groups.info.online state (reflects Cloud connection).
   *
   * @param online Initial online value
   */
  async createGroupsOnlineState(online: boolean): Promise<void> {
    await this.adapter.extendObject(
      "groups",
      {
        type: "folder",
        common: { name: tName("groups") },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );
    await this.adapter.extendObject(
      "groups.info",
      {
        type: "channel",
        common: { name: tName("groupsStatus") },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );
    await this.ensureState("groups.info.online", "Cloud Online", "boolean", "indicator.reachable", false);
    await this.adapter.setState("groups.info.online", {
      val: online,
      ack: true,
    });
  }

  /**
   * Update the general groups online state.
   *
   * @param online Cloud connection status
   */
  async updateGroupsOnline(online: boolean): Promise<void> {
    await this.adapter.setState("groups.info.online", { val: online, ack: true }).catch(() => undefined);
  }

  /**
   * Update info.membersUnreachable for a group.
   *
   * Always keeps the state (existing) and writes a comma-separated list of the
   * unreachable members, or an empty string when all are online. Previously we
   * deleted the object on "all reachable" — but that produced a js-controller
   * WARN "State 'X.membersUnreachable' has no existing object" every ~2 minutes,
   * because parallel updateGroupReachability calls (LAN+MQTT status updates fire
   * almost simultaneously) could trigger a race condition between setState
   * (object exists) and safeDeleteState (object gone). Always keeping the state
   * present avoids that entirely.
   *
   * @param group BaseGroup device
   * @param memberDevices Resolved member devices
   */
  async updateGroupMembersUnreachable(group: GoveeDevice, memberDevices: GoveeDevice[]): Promise<void> {
    const prefix = this.devicePrefix(group);
    const stateId = `${prefix}.info.membersUnreachable`;

    const unreachable = memberDevices.filter(m => !m.state.online).map(m => treeKey(m.sku, m.deviceId));

    await this.ensureState(stateId, "Unreachable Members", "string", "text", false);
    await this.adapter.setState(stateId, {
      val: unreachable.join(", "),
      ack: true,
    });
  }

  /**
   * Cleanup stale devices that no longer exist.
   *
   * Returns the prefixes of removed devices so callers (DeviceManager,
   * adapter-level maps) can drop their own entries for the same devices
   * and prevent unbounded map growth across the adapter's lifetime.
   *
   * @param currentDevices Current device list
   * @returns Prefixes of removed devices (e.g. "devices.h61be_1d6f")
   */
  async cleanupDevices(currentDevices: GoveeDevice[]): Promise<string[]> {
    const currentPrefixes = new Set(currentDevices.map(d => this.devicePrefix(d)));
    const removed: string[] = [];

    // Cleanup both devices/ and groups/ folders
    for (const folder of ["devices", "groups"]) {
      // getObjectViewAsync can throw on transient js-controller hiccups \u2014
      // wrapping it lets cleanupDevices proceed with the other folder
      // instead of bailing out of the whole cleanup pass.
      let existingObjects;
      try {
        existingObjects = await this.adapter.getObjectViewAsync("system", "device", {
          startkey: `${this.adapter.namespace}.${folder}.`,
          endkey: `${this.adapter.namespace}.${folder}.\u9999`,
        });
      } catch (e) {
        this.adapter.log.debug(
          `cleanupDevices: getObjectViewAsync failed for ${folder}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      if (!existingObjects?.rows) {
        continue;
      }

      for (const row of existingObjects.rows) {
        const localId = row.id.replace(`${this.adapter.namespace}.`, "");
        if (!currentPrefixes.has(localId)) {
          this.adapter.log.debug(`Removing stale device: ${localId}`);
          // Recursive delObject removes the object tree but can leave
          // orphan state values in the state-table — clean those too so
          // historical values don't survive a device removal.
          const stateRows = await this.adapter
            .getObjectViewAsync("system", "state", {
              startkey: `${row.id}.`,
              endkey: `${row.id}.香`,
            })
            .catch(() => undefined);
          if (stateRows?.rows) {
            for (const stateRow of stateRows.rows) {
              const stateLocalId = stateRow.id.replace(`${this.adapter.namespace}.`, "");
              await this.adapter.delStateAsync(stateLocalId).catch(() => undefined);
            }
          }
          await this.adapter.delObjectAsync(localId, { recursive: true });
          this.forgetPrefix(localId);
          removed.push(localId);
        }
      }
    }
    return removed;
  }

  /**
   * Phase 3 cleanup — remove Cloud-owned states that are no longer in the
   * current Cloud-phase stateDefs. Respects LAN_STATE_IDS so the LAN phase's
   * states in the control channel never get touched.
   *
   * The Cloud-owned channels (scenes, music, snapshots, sensor, events) are
   * 100% Cloud territory — anything not in cloudStateDefs there is stale.
   * The control channel is mixed: LAN-default ids (power, brightness, …)
   * belong to the LAN phase and are skipped via the LAN_STATE_IDS constant.
   *
   * Public for the v2.8.0 migration shot in main.ts.onReady — pure-LAN
   * devices need a one-time cleanupCloudOwnedStates(prefix, []) to wipe
   * scene/music/snapshot leftovers from prior versions.
   *
   * @param prefix Device prefix
   * @param cloudStateDefs Current Cloud-phase state definitions (non-segment)
   */
  async cleanupCloudOwnedStates(prefix: string, cloudStateDefs: StateDefinition[]): Promise<void> {
    // Build expected state set per channel
    const expectedByChannel = new Map<string, Set<string>>();
    for (const def of cloudStateDefs) {
      const channel = def.channel ?? "control";
      if (!expectedByChannel.has(channel)) {
        expectedByChannel.set(channel, new Set());
      }
      expectedByChannel.get(channel)!.add(def.id);
    }

    const devicePrefix = `${this.adapter.namespace}.${prefix}.`;
    const existing = await this.adapter.getObjectViewAsync("system", "state", {
      startkey: devicePrefix,
      endkey: `${devicePrefix}\u9999`,
    });
    if (!existing?.rows) {
      return;
    }

    const totalsPerChannel = new Map<string, { seen: number; deleted: number }>();
    for (const row of existing.rows) {
      const rest = row.id.replace(devicePrefix, "");
      const dotIdx = rest.indexOf(".");
      if (dotIdx < 0) {
        continue;
      }
      const channel = rest.slice(0, dotIdx);
      const stateId = rest.slice(dotIdx + 1);
      if (!MANAGED_CHANNELS.includes(channel)) {
        continue;
      }
      // In the control channel, LAN-default ids belong to the LAN phase —
      // Cloud cleanup must not touch them. Other MANAGED_CHANNELS are
      // wholly Cloud territory. Count them as seen-but-not-deleted survivors so
      // the "empty channel" removal below doesn't delete the control channel
      // object out from under its surviving LAN states (L9).
      if (channel === "control" && LAN_STATE_IDS.has(stateId)) {
        const survivors = totalsPerChannel.get(channel) ?? { seen: 0, deleted: 0 };
        survivors.seen++;
        totalsPerChannel.set(channel, survivors);
        continue;
      }
      const totals = totalsPerChannel.get(channel) ?? { seen: 0, deleted: 0 };
      totals.seen++;
      const validIds = expectedByChannel.get(channel) ?? new Set<string>();
      if (!validIds.has(stateId)) {
        const localId = row.id.replace(`${this.adapter.namespace}.`, "");
        this.adapter.log.debug(`Removing stale state: ${localId}`);
        await this.adapter.delObjectAsync(localId);
        await this.adapter.delStateAsync(localId).catch(() => {});
        totals.deleted++;
      }
      totalsPerChannel.set(channel, totals);
    }

    // Remove empty channel objects — no surviving states for this channel
    for (const [channel, totals] of totalsPerChannel) {
      if (totals.deleted > 0 && totals.deleted === totals.seen) {
        this.adapter.log.debug(`Removing empty channel: ${prefix}.${channel}`);
        await this.adapter.delObjectAsync(`${prefix}.${channel}`).catch(() => undefined);
      }
    }
  }

  /**
   * Get device object ID prefix — stable SKU + short device ID.
   * Groups (BaseGroup) go under groups/, devices under devices/.
   * Human-readable name is in common.name, not in the object ID.
   *
   * @param device Govee device
   */
  devicePrefix(device: GoveeDevice): string {
    const folder = device.sku === "BaseGroup" ? "groups" : "devices";
    return `${folder}.${treeKey(device.sku, device.deviceId)}`;
  }

  /**
   * Drop prefix + stateChannel entries for a device that was removed.
   * Prevents the maps from growing indefinitely across adapter lifetime.
   *
   * @param prefix Device prefix that was removed
   */
  private forgetPrefix(prefix: string): void {
    for (const key of this.prefixMap.keys()) {
      if (this.prefixMap.get(key) === prefix) {
        this.prefixMap.delete(key);
      }
    }
    const stalePrefix = `${prefix}.`;
    for (const key of this.stateChannelMap.keys()) {
      if (key.startsWith(stalePrefix)) {
        this.stateChannelMap.delete(key);
      }
    }
    // Drop ensureState cache for this device too — a re-pair must run the
    // full extendObject path again so the new device's name/type get
    // applied (cache hit would skip the round-trip and keep stale common.*).
    // ensureState stores namespace-less ids (extendObject takes a relative
    // id), so match the same way as stateChannelMap above — the old namespaced
    // match never fired, so re-paired devices skipped info-state creation (M4).
    for (const id of this.ensuredStates) {
      if (id === prefix || id.startsWith(stalePrefix)) {
        this.ensuredStates.delete(id);
      }
    }
  }

  /**
   * Unique key for internal tracking (not used as object ID).
   *
   * @param device Govee device
   */
  private deviceKey(device: GoveeDevice): string {
    return mapKey(device.sku, device.deviceId);
  }

  /**
   * Create a state if it doesn't exist. Cached after the first successful
   * `extendObject` so hot-path callers (e.g. `updateGroupMembersUnreachable`
   * fires per status update) skip the Redis round-trip.
   *
   * @param id State object ID
   * @param name Display name
   * @param type Value type
   * @param role ioBroker role
   * @param write Whether state is writable
   * @param unit Optional unit of measurement
   * @param def Optional default value — set so the state has a sensible
   *            initial value before the first writeback (avoids `null`
   *            display in admin between create and first setState).
   */
  private async ensureState(
    id: string,
    name: ioBroker.StringOrTranslated,
    type: ioBroker.CommonType,
    role: string,
    write: boolean,
    unit?: string,
    def?: ioBroker.StateValue,
  ): Promise<void> {
    if (this.ensuredStates.has(id)) {
      return;
    }
    const common: Partial<ioBroker.StateCommon> = {
      name,
      type,
      role,
      read: true,
      write,
    };
    if (unit) {
      common.unit = unit;
    }
    if (def !== undefined) {
      common.def = def;
    }
    await this.adapter.extendObject(
      id,
      {
        type: "state",
        common: common,
        native: {},
      },
      { preserve: { common: ["name"] } },
    );
    this.ensuredStates.add(id);
  }

  /**
   * Resolver-based info.online sync.
   *
   * For LAN-capable LED Lights (`type === light` AND `lanIp` set) the
   * truth-source is exclusively `device.lastLanReplyAt` — set when the device
   * replies to a LAN-Discovery multicast or LAN-Unicast devStatus. The 90 s
   * freshness window tolerates 3 missed 30 s scans against UDP packet loss but
   * still flips offline reasonably fast on a real outage.
   *
   * For cloud-only Lights (a light whose owner never enabled the local API, so
   * `lanIp` is null) and for Sensors/Appliances there is no LAN signal:
   * `device.state.online` — set by `applyOnlineCap` from App-API / OpenAPI-MQTT
   * — is read straight through here. Local-first stays, local-only does not.
   *
   * Writes `info.online` only when the resolved value differs from the
   * current state — kills the 2-min ts-rewrite-spam captured 2026-05-13.
   *
   * For Lights: when the resolved online value changes, the internal
   * `device.state.online` is also updated so downstream consumers
   * (`updateGroupReachability`, `handleLanDiscovery` wasOffline check)
   * stay in sync. Returns `true` in that case so the caller can fire
   * the group-fanout reachability refresh.
   *
   * Skips BaseGroup devices — groups have a global `groups.info.online`
   * managed elsewhere.
   *
   * @param device Govee device to sync
   * @returns true if a Light's resolved online state changed (caller should
   *          refresh group-reachability), false otherwise
   */
  async syncInfoOnline(device: GoveeDevice): Promise<boolean> {
    if (device.sku === "BaseGroup") {
      return false;
    }
    const prefix = this.devicePrefix(device);
    const stateId = `${prefix}.info.online`;

    let desiredOnline: boolean;
    if (device.type === GOVEE_DEVICE_TYPE.LIGHT && device.lanIp) {
      // LAN-capable light: LAN-reply freshness is the truth-source (v2.9.0 — the
      // Cloud cache lagged real reachability and wrote 2× false-positive `true`
      // during the 2026-05-13 outage capture).
      desiredOnline = !!(device.lastLanReplyAt && Date.now() - device.lastLanReplyAt < 90_000);
    } else {
      // Cloud-only light (no local API, lanIp === null) + sensors/appliances:
      // no LAN signal to trust, so the cloud-reported device online
      // (`state.online`, fed by applyOnlineCap from App-API / OpenAPI-MQTT) is
      // the right source. Local-first stays — local-only does not.
      desiredOnline = device.state.online === true;
    }

    const current = await this.adapter.getStateAsync(stateId).catch(() => null);
    if (!current || current.val !== desiredOnline) {
      await this.adapter.setState(stateId, { val: desiredOnline, ack: true }).catch(() => undefined);
    }

    let lightOnlineChanged = false;
    if (device.type === GOVEE_DEVICE_TYPE.LIGHT && device.state.online !== desiredOnline) {
      device.state.online = desiredOnline;
      lightOnlineChanged = true;
    }

    return lightOnlineChanged;
  }
}
