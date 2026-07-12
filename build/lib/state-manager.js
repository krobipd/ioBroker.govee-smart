"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var state_manager_exports = {};
__export(state_manager_exports, {
  SYNTHETIC_STATE_META: () => SYNTHETIC_STATE_META,
  StateManager: () => StateManager
});
module.exports = __toCommonJS(state_manager_exports);
var import_capability_mapper = require("./capability-mapper");
var import_device_icons = require("./device-icons");
var import_device_manager = require("./device-manager");
var import_govee_constants = require("./govee-constants");
var import_i18n = require("./i18n");
var import_device_key = require("./device-key");
const MANAGED_CHANNELS = ["control", "scenes", "music", "snapshots", "sensor", "events"];
const CHANNEL_NAME_KEYS = {
  control: "channelControls",
  scenes: "channelScenes",
  music: "channelMusic",
  snapshots: "channelSnapshots",
  sensor: "channelSensorData",
  events: "channelEvents",
  info: "deviceInformation",
  diag: "channelDiagnostics"
};
function channelName(channel) {
  const key = CHANNEL_NAME_KEYS[channel];
  return key ? (0, import_i18n.tName)(key) : channel;
}
const numSensor = (kind, nameKey) => ({
  type: "number",
  role: import_capability_mapper.SENSOR_ROLE_UNIT[kind].role,
  unit: import_capability_mapper.SENSOR_ROLE_UNIT[kind].unit,
  nameKey,
  channel: "sensor"
});
const SYNTHETIC_STATE_META = {
  temperature: numSensor("temperature", "temperature"),
  humidity: numSensor("humidity", "humidity"),
  battery: numSensor("battery", "battery"),
  co2: numSensor("co2", "co2"),
  carbondioxide: numSensor("co2", "co2"),
  online: { type: "boolean", role: "indicator.connected", nameKey: "online", channel: "sensor" },
  lackwater: { type: "boolean", role: import_capability_mapper.EVENT_STATE_ROLES.lackwater.role, nameKey: "lackOfWater", channel: "events" },
  lackwaterevent: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.lackwaterevent.role,
    nameKey: "lackOfWater",
    channel: "events"
  },
  icefull: { type: "boolean", role: import_capability_mapper.EVENT_STATE_ROLES.icefull.role, nameKey: "iceBucketFull", channel: "events" },
  icefullevent: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.icefullevent.role,
    nameKey: "iceBucketFull",
    channel: "events"
  },
  bodyappeared: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.bodyappeared.role,
    nameKey: "bodyDetected",
    channel: "events"
  },
  dirtdetected: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.dirtdetected.role,
    nameKey: "dirtDetected",
    channel: "events"
  },
  sensor_temperature: numSensor("temperature", "temperature"),
  sensor_humidity: numSensor("humidity", "humidity"),
  sensor_battery: numSensor("battery", "battery"),
  lack_water: { type: "boolean", role: import_capability_mapper.EVENT_STATE_ROLES.lack_water.role, nameKey: "lackOfWater", channel: "events" },
  lack_water_event: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.lack_water_event.role,
    nameKey: "lackOfWater",
    channel: "events"
  },
  ice_full: { type: "boolean", role: import_capability_mapper.EVENT_STATE_ROLES.ice_full.role, nameKey: "iceBucketFull", channel: "events" },
  ice_full_event: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.ice_full_event.role,
    nameKey: "iceBucketFull",
    channel: "events"
  },
  body_appeared: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.body_appeared.role,
    nameKey: "bodyDetected",
    channel: "events"
  },
  dirt_detected: {
    type: "boolean",
    role: import_capability_mapper.EVENT_STATE_ROLES.dirt_detected.role,
    nameKey: "dirtDetected",
    channel: "events"
  }
};
function inferChannelFromStateId(stateId) {
  var _a, _b;
  return (_b = (_a = SYNTHETIC_STATE_META[stateId.toLowerCase()]) == null ? void 0 : _a.channel) != null ? _b : "control";
}
class StateManager {
  adapter;
  /** Maps deviceKey (sku_deviceId) → current object prefix */
  prefixMap = /* @__PURE__ */ new Map();
  /** Maps "prefix.stateId" → channel name (populated during createDeviceStates) */
  stateChannelMap = /* @__PURE__ */ new Map();
  /**
   * Cache of state IDs already created via {@link ensureState} — skips the
   * `extendObject` round-trip on the hot path. Refreshed on
   * {@link removeDevice}/{@link forgetPrefix} so a re-pair doesn't reuse stale
   * cache entries.
   */
  ensuredStates = /* @__PURE__ */ new Set();
  /**
   * "prefix.stateId" keys already handled by {@link removeSyntheticStateOnce} —
   * bounds the phantom-state cleanup to one existence-check per adapter run.
   */
  cleanedSyntheticStates = /* @__PURE__ */ new Set();
  /** @param adapter The ioBroker adapter instance */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /**
   * Force-replace `common.states` on a persisted state object if any existing
   * value is non-string (= translation object from older releases).
   *
   * A full-object replace is required: js-controller's `extendObject`
   * deep-merges via node.extend (verified against js-controller 7.2.2 /
   * node.extend 2.0.3) — same-key values ARE replaced, but stale keys absent
   * from `fresh` survive the merge, and one surviving translation-object value
   * is enough to keep crashing the Admin. `setObject` would deliver the "map
   * contains exactly `fresh`" postcondition but is discouraged (repochecker
   * S5054 — a blind full write clobbers runtime-added common fields). The
   * js-controller-blessed full replace is `delObject` → `setObjectNotExists`:
   * dropping the object physically clears the stale keys, recreating it from
   * the read-back `existing` (with the plain-string `fresh` map) preserves
   * name/native/role. The state value survives in the states DB and is
   * re-seeded by the caller's def-value guard if the DB dropped it. Same
   * React-#31 fix-pattern as hassemu v1.27.2 (URL-dropdown) and v1.28.4
   * (mode-dropdown): Admin renders states-VALUES as React children, so a
   * translation object triggers React Error #31 → fatal "Error in GUI" on
   * dropdown open (write:true) or any render path (write:false like diag.tier).
   *
   * @param id    Full state path.
   * @param fresh Plain-string `common.states` map to write.
   */
  async repairCommonStatesIfBuggy(id, fresh) {
    var _a;
    const existing = await this.adapter.getObjectAsync(id).catch(() => null);
    if (!existing) {
      return;
    }
    const states = (_a = existing.common) == null ? void 0 : _a.states;
    if (!states || typeof states !== "object") {
      return;
    }
    const buggy = Object.values(states).some((v) => typeof v !== "string");
    if (!buggy) {
      return;
    }
    existing.common.states = fresh;
    await this.adapter.delObjectAsync(id).catch(() => void 0);
    await this.adapter.setObjectNotExistsAsync(id, existing).catch(() => void 0);
  }
  /**
   * @param id Voller State-Pfad (`devices.X.info.Y`)
   */
  async safeDeleteState(id) {
    const obj = await this.adapter.getObjectAsync(id).catch(() => null);
    if (!obj) {
      return;
    }
    await this.adapter.delStateAsync(id).catch(() => void 0);
    await this.adapter.delObjectAsync(id).catch(() => void 0);
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
  async removeSyntheticStateOnce(prefix, stateId) {
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
  async updateDeviceTier(device, tier) {
    if (device.sku === "BaseGroup") {
      return;
    }
    const prefix = this.devicePrefix(device);
    await this.adapter.setState(`${prefix}.diag.tier`, { val: tier, ack: true }).catch(() => void 0);
  }
  /**
   * Migrate v2.1.0 layout (`info.diagnostics_*`) to v2.1.1 layout
   * (`diag.*`). Deletes the three old objects + states; the new ones get
   * created by the regular `createDeviceStates` pass. Idempotent — calling
   * twice is a no-op once the old objects are gone.
   *
   * @param device Govee device
   */
  async migrateLegacyDiagnostics(device) {
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
  async migrateLegacyColorStateIds(device) {
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
  resolveStatePath(prefix, stateId) {
    var _a;
    const channel = (_a = this.stateChannelMap.get(`${prefix}.${stateId}`)) != null ? _a : inferChannelFromStateId(stateId);
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
  async ensureSyntheticStateObject(prefix, stateId) {
    const meta = SYNTHETIC_STATE_META[stateId.toLowerCase()];
    if (!meta) {
      return;
    }
    const channel = inferChannelFromStateId(stateId);
    await this.adapter.extendObject(
      `${prefix}.${channel}`,
      {
        type: "channel",
        common: { name: channelName(channel) },
        native: {}
      },
      { preserve: { common: ["name"] } }
    ).catch(() => void 0);
    await this.adapter.extendObject(
      `${prefix}.${channel}.${stateId}`,
      {
        type: "state",
        common: {
          name: (0, import_i18n.tName)(meta.nameKey),
          type: meta.type,
          role: meta.role,
          read: true,
          write: false,
          ...meta.unit !== void 0 ? { unit: meta.unit } : {},
          def: meta.type === "boolean" ? false : 0
        },
        native: {}
      },
      { preserve: { common: ["name"] } }
    ).catch(() => void 0);
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
  async createInfoStates(device) {
    var _a, _b;
    const key = this.deviceKey(device);
    const newPrefix = this.devicePrefix(device);
    const oldPrefix = this.prefixMap.get(key);
    if (oldPrefix && oldPrefix !== newPrefix) {
      this.adapter.log.debug(`Migrating device ${device.sku}: ${oldPrefix} \u2192 ${newPrefix}`);
      await this.adapter.delObjectAsync(oldPrefix, { recursive: true });
      const oldChannelKey = `${oldPrefix}.`;
      for (const mapKey2 of this.stateChannelMap.keys()) {
        if (mapKey2.startsWith(oldChannelKey)) {
          this.stateChannelMap.delete(mapKey2);
        }
      }
    }
    this.prefixMap.set(key, newPrefix);
    const prefix = newPrefix;
    const isGroup = device.sku === "BaseGroup";
    const onlineId = isGroup ? `${this.adapter.namespace}.groups.info.online` : `${this.adapter.namespace}.${prefix}.info.online`;
    const icon = isGroup ? import_device_icons.GROUP_ICON : (0, import_device_icons.iconForGoveeType)(device.type);
    await this.adapter.extendObject(
      prefix,
      {
        type: "device",
        common: {
          name: device.name,
          icon,
          statusStates: { onlineId }
        },
        native: {
          sku: device.sku,
          deviceId: device.deviceId
        }
      },
      { preserve: { common: ["name"] } }
    );
    await this.adapter.extendObject(
      `${prefix}.info`,
      {
        type: "channel",
        common: { name: (0, import_i18n.tName)("deviceInformation") },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    await this.ensureState(`${prefix}.info.name`, (0, import_i18n.tName)("stateName"), "string", "text", false);
    await this.adapter.setStateChangedAsync(`${prefix}.info.name`, {
      val: device.name,
      ack: true
    });
    if (!isGroup) {
      await this.ensureState(
        `${prefix}.info.online`,
        (0, import_i18n.tName)("online"),
        "boolean",
        "indicator.reachable",
        false,
        void 0,
        false
      );
      await this.ensureState(`${prefix}.info.model`, (0, import_i18n.tName)("model"), "string", "text", false, void 0, "");
      await this.ensureState(`${prefix}.info.serial`, (0, import_i18n.tName)("serialNumber"), "string", "text", false, void 0, "");
      await this.ensureState(`${prefix}.info.ip`, (0, import_i18n.tName)("ipAddress"), "string", "info.ip", false, void 0, "");
      await this.ensureState(`${prefix}.info.type`, (0, import_i18n.tName)("deviceType"), "string", "text", false, void 0, "");
      await this.adapter.setStateChangedAsync(`${prefix}.info.model`, {
        val: device.sku,
        ack: true
      });
      await this.adapter.setStateChangedAsync(`${prefix}.info.serial`, {
        val: device.deviceId,
        ack: true
      });
      await this.adapter.setStateChangedAsync(`${prefix}.info.ip`, {
        val: (_a = device.lanIp) != null ? _a : "",
        ack: true
      });
      await this.adapter.setStateChangedAsync(`${prefix}.info.type`, {
        val: (0, import_device_icons.shortenGoveeType)(device.type),
        ack: true
      });
      await this.syncInfoOnline(device);
    } else {
      const memberIds = ((_b = device.groupMembers) != null ? _b : []).map((m) => (0, import_device_key.treeKey)(m.sku, m.deviceId)).join(", ");
      await this.ensureState(`${prefix}.info.members`, (0, import_i18n.tName)("members"), "string", "text", false);
      await this.adapter.setStateChangedAsync(`${prefix}.info.members`, {
        val: memberIds,
        ack: true
      });
      for (const staleId of [
        "online",
        "model",
        "serial",
        "ip",
        "diagnostics_export",
        "diagnostics_result",
        "diagnostics_tier"
      ]) {
        await this.safeDeleteState(`${prefix}.info.${staleId}`);
      }
      await this.adapter.delObjectAsync(`${prefix}.diag`, { recursive: true }).catch(() => {
      });
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
  async createLanStates(device) {
    const stateDefs = (0, import_capability_mapper.buildLanStateDefs)(device, this.adapter.log);
    if (stateDefs.length === 0) {
      this.adapter.log.debug(
        `buildLanStateDefs for ${device.sku} ${device.deviceId}: 0 states (no LAN IP / not a light) \u2014 LAN phase skipped`
      );
      return;
    }
    this.adapter.log.debug(
      `buildLanStateDefs for ${device.sku} ${device.deviceId}: ${stateDefs.length} state(s) \u2192 writing to LAN channel`
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
  async createCloudStates(device, stateDefs) {
    const prefix = this.devicePrefix(device);
    const nonSegmentDefs = stateDefs.filter((d) => !d.id.startsWith("_segment_"));
    await this.writeStateDefsToChannels(prefix, nonSegmentDefs, `Cloud ${device.sku}`);
    await this.cleanupCloudOwnedStates(prefix, nonSegmentDefs);
    if (stateDefs.some((d) => d.id.startsWith("_segment_"))) {
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
  async writeStateDefsToChannels(prefix, stateDefs, logTag) {
    var _a;
    const channelGroups = /* @__PURE__ */ new Map();
    for (const def of stateDefs) {
      const channel = (_a = def.channel) != null ? _a : "control";
      this.stateChannelMap.set(`${prefix}.${def.id}`, channel);
      if (!channelGroups.has(channel)) {
        channelGroups.set(channel, []);
      }
      channelGroups.get(channel).push(def);
    }
    this.adapter.log.debug(
      `createStates [${logTag}] ${prefix}: ${stateDefs.length} states in ${channelGroups.size} channel(s)`
    );
    for (const [channel, defs] of channelGroups) {
      await this.adapter.extendObject(
        `${prefix}.${channel}`,
        {
          type: "channel",
          common: { name: channelName(channel) },
          native: {}
        },
        { preserve: { common: ["name"] } }
      );
      for (const def of defs) {
        const common = {
          name: def.name,
          type: def.type,
          role: def.role,
          // Buttons are write-only triggers (role catalogue) — the adapter
          // already declares its io-package button (manual_sync_devices)
          // with read:false; capability-driven buttons now match (LOW).
          read: def.role === "button" ? false : true,
          write: def.write
        };
        if (def.unit) {
          common.unit = def.unit;
        }
        if (def.min !== void 0) {
          common.min = def.min;
        }
        if (def.max !== void 0) {
          common.max = def.max;
        }
        if (def.states) {
          common.states = def.states;
        }
        if (def.def !== void 0) {
          common.def = def.def;
        }
        if (def.desc) {
          common.desc = def.desc;
        }
        await this.adapter.extendObject(
          `${prefix}.${channel}.${def.id}`,
          {
            type: "state",
            common,
            native: {
              capabilityType: def.capabilityType,
              capabilityInstance: def.capabilityInstance
            }
          },
          { preserve: { common: ["name"] } }
        );
        if (def.states) {
          await this.repairCommonStatesIfBuggy(`${prefix}.${channel}.${def.id}`, def.states);
        }
        if (def.def !== void 0) {
          const current = await this.adapter.getStateAsync(`${prefix}.${channel}.${def.id}`);
          if (!current || current.val === null || current.val === void 0) {
            await this.adapter.setState(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true
            });
          } else if (def.states && !(String(current.val) in def.states)) {
            this.adapter.log.debug(
              `Resetting stale dropdown: ${prefix}.${channel}.${def.id} = "${String(current.val)}" \u2192 "${String(def.def)}"`
            );
            await this.adapter.setState(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true
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
  async createSegmentStates(device) {
    const prefix = this.devicePrefix(device);
    await this.adapter.extendObject(
      `${prefix}.segments`,
      {
        type: "channel",
        common: { name: (0, import_i18n.tName)("ledSegments") },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    const resolved = (0, import_device_manager.resolveSegmentCount)(device);
    const manualMax = Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? Math.max(...device.manualSegments) + 1 : 0;
    const segmentCount = Math.max(resolved, manualMax);
    device.segmentCount = segmentCount;
    const validIndices = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? device.manualSegments.slice().sort((a, b) => a - b) : Array.from({ length: segmentCount }, (_, i) => i);
    const reportedCount = validIndices.length;
    await this.ensureState(`${prefix}.segments.count`, (0, import_i18n.tName)("segmentCount"), "number", "value", false);
    await this.adapter.setState(`${prefix}.segments.count`, {
      val: reportedCount,
      ack: true
    });
    await this.adapter.extendObject(
      `${prefix}.segments.manual_mode`,
      {
        type: "state",
        common: {
          name: (0, import_i18n.tName)("manualSegmentsActive"),
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
          def: false,
          desc: (0, import_i18n.tDesc)("manualSegmentsDesc")
        },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    await this.adapter.extendObject(
      `${prefix}.segments.manual_list`,
      {
        type: "state",
        common: {
          name: (0, import_i18n.tName)("manualSegmentList"),
          type: "string",
          role: "text",
          read: true,
          write: true,
          def: "",
          desc: (0, import_i18n.tDesc)("manualListDesc")
        },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    const manualModeVal = device.manualMode === true;
    const manualListVal = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? device.manualSegments.join(",") : "";
    await this.adapter.setState(`${prefix}.segments.manual_mode`, {
      val: manualModeVal,
      ack: true
    });
    await this.adapter.setState(`${prefix}.segments.manual_list`, {
      val: manualListVal,
      ack: true
    });
    for (const i of validIndices) {
      await this.adapter.extendObject(
        `${prefix}.segments.${i}`,
        {
          type: "channel",
          common: { name: `Segment ${i}` },
          native: {}
        },
        { preserve: { common: ["name"] } }
      );
      await this.adapter.extendObject(
        `${prefix}.segments.${i}.color`,
        {
          type: "state",
          common: {
            name: (0, import_i18n.tName)("color"),
            type: "string",
            role: "level.color.rgb",
            read: true,
            write: true,
            def: "#000000"
            // avoid null in vis until the first write (LAN-only tier) — B6
          },
          native: {}
        },
        { preserve: { common: ["name"] } }
      );
      await this.adapter.extendObject(
        `${prefix}.segments.${i}.brightness`,
        {
          type: "state",
          common: {
            name: (0, import_i18n.tName)("brightness"),
            type: "number",
            role: "level.brightness",
            read: true,
            write: true,
            min: 0,
            max: 100,
            unit: "%",
            def: 0
            // avoid null in vis until the first write (LAN-only tier) — B6
          },
          native: {}
        },
        { preserve: { common: ["name"] } }
      );
    }
    await this.adapter.extendObject(
      `${prefix}.segments.command`,
      {
        type: "state",
        common: {
          name: (0, import_i18n.tName)("batchSegmentCommand"),
          type: "string",
          role: "text",
          read: false,
          write: true,
          def: "",
          desc: (0, import_i18n.tDesc)("batchCommandDesc")
        },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    await this.cleanupExcessSegments(prefix, validIndices);
  }
  /**
   * Remove segment sub-channels that are not in the valid-indices list.
   * Supports gaps (e.g. manual list "0-8,10-14" → segment 9 channel gets removed).
   *
   * @param prefix Device prefix
   * @param validIndices Valid segment indices (all others will be deleted)
   */
  async cleanupExcessSegments(prefix, validIndices) {
    const valid = new Set(validIndices);
    const segPrefix = `${this.adapter.namespace}.${prefix}.segments.`;
    const existing = await this.adapter.getObjectViewAsync("system", "channel", {
      startkey: segPrefix,
      endkey: `${segPrefix}\u9999`
    });
    if (!(existing == null ? void 0 : existing.rows)) {
      return;
    }
    for (const row of existing.rows) {
      const localId = row.id.replace(`${this.adapter.namespace}.`, "");
      const segPart = localId.replace(`${prefix}.segments.`, "");
      const segIdx = parseInt(segPart, 10);
      if (!isNaN(segIdx) && !valid.has(segIdx)) {
        this.adapter.log.debug(`Removing excess segment: ${localId}`);
        await this.adapter.delStateAsync(`${localId}.color`).catch(() => void 0);
        await this.adapter.delStateAsync(`${localId}.brightness`).catch(() => void 0);
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
  async updateDeviceState(device, state) {
    const prefix = this.devicePrefix(device);
    const writes = [];
    const set = (id, val) => {
      writes.push(this.adapter.setStateChangedAsync(id, { val, ack: true }).catch(() => void 0));
    };
    if (state.online !== void 0 && device.type !== import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT) {
      set(`${prefix}.info.online`, state.online);
    }
    if (state.power !== void 0) {
      set(`${prefix}.control.power`, state.power);
    }
    if (state.brightness !== void 0) {
      set(`${prefix}.control.brightness`, state.brightness);
    }
    if (state.colorRgb !== void 0) {
      set(`${prefix}.control.color_rgb`, state.colorRgb);
    }
    if (state.colorTemperature !== void 0) {
      set(`${prefix}.control.color_temperature`, state.colorTemperature);
    }
    if (state.scene !== void 0) {
      set(`${prefix}.control.scene`, state.scene);
    }
    await Promise.all(writes);
  }
  /**
   * Create the general groups.info.online state (reflects Cloud connection).
   *
   * @param online Initial online value
   */
  async createGroupsOnlineState(online) {
    await this.adapter.extendObject(
      "groups",
      {
        type: "folder",
        common: { name: (0, import_i18n.tName)("groups") },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    await this.adapter.extendObject(
      "groups.info",
      {
        type: "channel",
        common: { name: (0, import_i18n.tName)("groupsStatus") },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    await this.ensureState("groups.info.online", (0, import_i18n.tName)("cloudOnline"), "boolean", "indicator.reachable", false);
    await this.adapter.setState("groups.info.online", {
      val: online,
      ack: true
    });
  }
  /**
   * Update the general groups online state.
   *
   * @param online Cloud connection status
   */
  async updateGroupsOnline(online) {
    await this.adapter.setState("groups.info.online", { val: online, ack: true }).catch(() => void 0);
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
  async updateGroupMembersUnreachable(group, memberDevices) {
    const prefix = this.devicePrefix(group);
    const stateId = `${prefix}.info.membersUnreachable`;
    const unreachable = memberDevices.filter((m) => !m.state.online).map((m) => (0, import_device_key.treeKey)(m.sku, m.deviceId));
    await this.ensureState(stateId, (0, import_i18n.tName)("membersUnreachable"), "string", "text", false);
    await this.adapter.setStateChangedAsync(stateId, {
      val: unreachable.join(", "),
      ack: true
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
  async cleanupDevices(currentDevices) {
    const currentPrefixes = new Set(currentDevices.map((d) => this.devicePrefix(d)));
    const removed = [];
    for (const folder of ["devices", "groups"]) {
      let existingObjects;
      try {
        existingObjects = await this.adapter.getObjectViewAsync("system", "device", {
          startkey: `${this.adapter.namespace}.${folder}.`,
          endkey: `${this.adapter.namespace}.${folder}.\u9999`
        });
      } catch (e) {
        this.adapter.log.debug(
          `cleanupDevices: getObjectViewAsync failed for ${folder}: ${e instanceof Error ? e.message : String(e)}`
        );
        continue;
      }
      if (!(existingObjects == null ? void 0 : existingObjects.rows)) {
        continue;
      }
      for (const row of existingObjects.rows) {
        const localId = row.id.replace(`${this.adapter.namespace}.`, "");
        if (!currentPrefixes.has(localId)) {
          this.adapter.log.debug(`Removing stale device: ${localId}`);
          const stateRows = await this.adapter.getObjectViewAsync("system", "state", {
            startkey: `${row.id}.`,
            endkey: `${row.id}.\u9999`
          }).catch(() => void 0);
          if (stateRows == null ? void 0 : stateRows.rows) {
            for (const stateRow of stateRows.rows) {
              const stateLocalId = stateRow.id.replace(`${this.adapter.namespace}.`, "");
              await this.adapter.delStateAsync(stateLocalId).catch(() => void 0);
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
  async cleanupCloudOwnedStates(prefix, cloudStateDefs) {
    var _a, _b, _c, _d;
    const expectedByChannel = /* @__PURE__ */ new Map();
    for (const def of cloudStateDefs) {
      const channel = (_a = def.channel) != null ? _a : "control";
      if (!expectedByChannel.has(channel)) {
        expectedByChannel.set(channel, /* @__PURE__ */ new Set());
      }
      expectedByChannel.get(channel).add(def.id);
    }
    const devicePrefix = `${this.adapter.namespace}.${prefix}.`;
    const existing = await this.adapter.getObjectViewAsync("system", "state", {
      startkey: devicePrefix,
      endkey: `${devicePrefix}\u9999`
    });
    if (!(existing == null ? void 0 : existing.rows)) {
      return 0;
    }
    const totalsPerChannel = /* @__PURE__ */ new Map();
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
      if (channel === "control" && import_capability_mapper.LAN_STATE_IDS.has(stateId)) {
        const survivors = (_b = totalsPerChannel.get(channel)) != null ? _b : { seen: 0, deleted: 0 };
        survivors.seen++;
        totalsPerChannel.set(channel, survivors);
        continue;
      }
      const totals = (_c = totalsPerChannel.get(channel)) != null ? _c : { seen: 0, deleted: 0 };
      totals.seen++;
      const validIds = (_d = expectedByChannel.get(channel)) != null ? _d : /* @__PURE__ */ new Set();
      if (!validIds.has(stateId)) {
        const localId = row.id.replace(`${this.adapter.namespace}.`, "");
        this.adapter.log.debug(`Removing stale state: ${localId}`);
        await this.adapter.delObjectAsync(localId);
        await this.adapter.delStateAsync(localId).catch(() => {
        });
        totals.deleted++;
      }
      totalsPerChannel.set(channel, totals);
    }
    let deletedTotal = 0;
    for (const [channel, totals] of totalsPerChannel) {
      deletedTotal += totals.deleted;
      if (totals.deleted > 0 && totals.deleted === totals.seen) {
        this.adapter.log.debug(`Removing empty channel: ${prefix}.${channel}`);
        await this.adapter.delObjectAsync(`${prefix}.${channel}`).catch(() => void 0);
      }
    }
    return deletedTotal;
  }
  /**
   * Get device object ID prefix — stable SKU + short device ID.
   * Groups (BaseGroup) go under groups/, devices under devices/.
   * Human-readable name is in common.name, not in the object ID.
   *
   * @param device Govee device
   */
  devicePrefix(device) {
    const folder = device.sku === "BaseGroup" ? "groups" : "devices";
    return `${folder}.${(0, import_device_key.treeKey)(device.sku, device.deviceId)}`;
  }
  /**
   * Drop prefix + stateChannel entries for a device that was removed.
   * Prevents the maps from growing indefinitely across adapter lifetime.
   *
   * @param prefix Device prefix that was removed
   */
  forgetPrefix(prefix) {
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
  deviceKey(device) {
    return (0, import_device_key.mapKey)(device.sku, device.deviceId);
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
  async ensureState(id, name, type, role, write, unit, def) {
    if (this.ensuredStates.has(id)) {
      return;
    }
    const common = {
      name,
      type,
      role,
      read: true,
      write
    };
    if (unit) {
      common.unit = unit;
    }
    if (def !== void 0) {
      common.def = def;
    }
    await this.adapter.extendObject(
      id,
      {
        type: "state",
        common,
        native: {}
      },
      { preserve: { common: ["name"] } }
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
  async syncInfoOnline(device) {
    if (device.sku === "BaseGroup") {
      return false;
    }
    const prefix = this.devicePrefix(device);
    const stateId = `${prefix}.info.online`;
    let desiredOnline;
    if (device.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT && device.lanIp) {
      desiredOnline = !!(device.lastLanReplyAt && Date.now() - device.lastLanReplyAt < 9e4);
    } else {
      desiredOnline = device.state.online === true;
    }
    const current = await this.adapter.getStateAsync(stateId).catch(() => null);
    if (!current || current.val !== desiredOnline) {
      await this.adapter.setState(stateId, { val: desiredOnline, ack: true }).catch(() => void 0);
    }
    let lightOnlineChanged = false;
    if (device.type === import_govee_constants.GOVEE_DEVICE_TYPE.LIGHT && device.state.online !== desiredOnline) {
      device.state.online = desiredOnline;
      lightOnlineChanged = true;
    }
    return lightOnlineChanged;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SYNTHETIC_STATE_META,
  StateManager
});
//# sourceMappingURL=state-manager.js.map
