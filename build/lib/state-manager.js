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
  StateManager: () => StateManager
});
module.exports = __toCommonJS(state_manager_exports);
var import_device_icons = require("./device-icons.js");
var import_device_manager = require("./device-manager.js");
var import_types = require("./types.js");
function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}
const MANAGED_CHANNELS = ["control", "scenes", "music", "snapshots"];
const CHANNEL_NAMES = {
  control: "Controls",
  scenes: "Scenes",
  music: "Music",
  snapshots: "Snapshots",
  info: "Device Information"
};
class StateManager {
  adapter;
  /** Maps deviceKey (sku_deviceId) → current object prefix */
  prefixMap = /* @__PURE__ */ new Map();
  /** Maps "prefix.stateId" → channel name (populated during createDeviceStates) */
  stateChannelMap = /* @__PURE__ */ new Map();
  /** @param adapter The ioBroker adapter instance */
  constructor(adapter) {
    this.adapter = adapter;
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
    const channel = (_a = this.stateChannelMap.get(`${prefix}.${stateId}`)) != null ? _a : "control";
    return `${prefix}.${channel}.${stateId}`;
  }
  /**
   * Create device object and all states from capability definitions.
   *
   * @param device Govee device
   * @param stateDefs State definitions from capability mapper
   */
  async createDeviceStates(device, stateDefs) {
    var _a, _b, _c, _d, _e;
    const key = this.deviceKey(device);
    const newPrefix = this.devicePrefix(device);
    const oldPrefix = this.prefixMap.get(key);
    if (oldPrefix && oldPrefix !== newPrefix) {
      this.adapter.log.debug(
        `Migrating device ${device.sku}: ${oldPrefix} \u2192 ${newPrefix}`
      );
      await this.adapter.delObjectAsync(oldPrefix, { recursive: true });
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
    const onlineId = isGroup ? `${this.adapter.namespace}.groups.info.online` : `${this.adapter.namespace}.${prefix}.info.online`;
    const icon = isGroup ? import_device_icons.GROUP_ICON : (0, import_device_icons.iconForGoveeType)(device.type);
    await this.adapter.extendObjectAsync(prefix, {
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
    });
    await this.adapter.extendObjectAsync(`${prefix}.info`, {
      type: "channel",
      common: { name: "Device Information" },
      native: {}
    });
    await this.ensureState(
      `${prefix}.info.name`,
      "Name",
      "string",
      "text",
      false
    );
    await this.adapter.setStateAsync(`${prefix}.info.name`, {
      val: device.name,
      ack: true
    });
    if (!isGroup) {
      await this.ensureState(
        `${prefix}.info.online`,
        "Online",
        "boolean",
        "indicator.reachable",
        false
      );
      await this.adapter.setStateAsync(`${prefix}.info.online`, {
        val: (_a = device.state.online) != null ? _a : false,
        ack: true
      });
      await this.ensureState(
        `${prefix}.info.model`,
        "Model",
        "string",
        "text",
        false
      );
      await this.ensureState(
        `${prefix}.info.serial`,
        "Serial Number",
        "string",
        "text",
        false
      );
      await this.ensureState(
        `${prefix}.info.ip`,
        "IP Address",
        "string",
        "info.ip",
        false
      );
      await this.ensureState(
        `${prefix}.info.type`,
        "Device Type",
        "string",
        "text",
        false
      );
      await this.adapter.setStateAsync(`${prefix}.info.model`, {
        val: device.sku,
        ack: true
      });
      await this.adapter.setStateAsync(`${prefix}.info.serial`, {
        val: device.deviceId,
        ack: true
      });
      await this.adapter.setStateAsync(`${prefix}.info.ip`, {
        val: (_b = device.lanIp) != null ? _b : "",
        ack: true
      });
      await this.adapter.setStateAsync(`${prefix}.info.type`, {
        val: (0, import_device_icons.shortenGoveeType)(device.type),
        ack: true
      });
    } else {
      const memberIds = ((_c = device.groupMembers) != null ? _c : []).map((m) => {
        const shortId = (0, import_types.normalizeDeviceId)(m.deviceId).slice(-4);
        return sanitize(`${m.sku}_${shortId}`);
      }).join(", ");
      await this.ensureState(
        `${prefix}.info.members`,
        "Members",
        "string",
        "text",
        false
      );
      await this.adapter.setStateAsync(`${prefix}.info.members`, {
        val: memberIds,
        ack: true
      });
      for (const staleId of [
        "online",
        "model",
        "serial",
        "ip",
        "diagnostics_export",
        "diagnostics_result"
      ]) {
        await this.adapter.delObjectAsync(`${prefix}.info.${staleId}`).catch(() => {
        });
        await this.adapter.delStateAsync(`${prefix}.info.${staleId}`).catch(() => {
        });
      }
    }
    const nonSegmentDefs = stateDefs.filter(
      (d) => !d.id.startsWith("_segment_")
    );
    const channelGroups = /* @__PURE__ */ new Map();
    for (const def of nonSegmentDefs) {
      const channel = (_d = def.channel) != null ? _d : "control";
      this.stateChannelMap.set(`${prefix}.${def.id}`, channel);
      if (!channelGroups.has(channel)) {
        channelGroups.set(channel, []);
      }
      channelGroups.get(channel).push(def);
    }
    this.adapter.log.debug(
      `createDeviceStates ${device.sku}: ${nonSegmentDefs.length} states in ${channelGroups.size} channel(s)`
    );
    for (const [channel, defs] of channelGroups) {
      await this.adapter.extendObjectAsync(`${prefix}.${channel}`, {
        type: "channel",
        common: { name: (_e = CHANNEL_NAMES[channel]) != null ? _e : channel },
        native: {}
      });
      for (const def of defs) {
        const common = {
          name: def.name,
          type: def.type,
          role: def.role,
          read: true,
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
        await this.adapter.extendObjectAsync(`${prefix}.${channel}.${def.id}`, {
          type: "state",
          common,
          native: {
            capabilityType: def.capabilityType,
            capabilityInstance: def.capabilityInstance
          }
        });
        if (def.def !== void 0) {
          const current = await this.adapter.getStateAsync(
            `${prefix}.${channel}.${def.id}`
          );
          if (!current || current.val === null || current.val === void 0) {
            await this.adapter.setStateAsync(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true
            });
          } else if (def.states && !(String(current.val) in def.states)) {
            this.adapter.log.debug(
              `Resetting stale dropdown: ${prefix}.${channel}.${def.id} = "${String(current.val)}" \u2192 "${String(def.def)}"`
            );
            await this.adapter.setStateAsync(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true
            });
          }
        }
      }
    }
    await this.cleanupAllChannelStates(prefix, nonSegmentDefs);
    const segmentDefs = stateDefs.filter((d) => d.id.startsWith("_segment_"));
    if (segmentDefs.length > 0) {
      await this.createSegmentStates(device);
    }
  }
  /**
   * Create segment channel with per-segment color + brightness states.
   *
   * @param device Govee device
   */
  async createSegmentStates(device) {
    const prefix = this.devicePrefix(device);
    await this.adapter.extendObjectAsync(`${prefix}.segments`, {
      type: "channel",
      common: { name: "LED Segments" },
      native: {}
    });
    const resolved = (0, import_device_manager.resolveSegmentCount)(device);
    const manualMax = Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? Math.max(...device.manualSegments) + 1 : 0;
    const segmentCount = Math.max(resolved, manualMax);
    device.segmentCount = segmentCount;
    const validIndices = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? device.manualSegments.slice().sort((a, b) => a - b) : Array.from({ length: segmentCount }, (_, i) => i);
    const reportedCount = validIndices.length;
    await this.ensureState(
      `${prefix}.segments.count`,
      "Segment Count",
      "number",
      "value",
      false
    );
    await this.adapter.setStateAsync(`${prefix}.segments.count`, {
      val: reportedCount,
      ack: true
    });
    await this.adapter.extendObjectAsync(`${prefix}.segments.manual_mode`, {
      type: "state",
      common: {
        name: "Manual Segments Active",
        type: "boolean",
        role: "switch",
        read: true,
        write: true,
        def: false,
        desc: "Enable manual segment list (e.g. for cut LED strips with fewer physical segments than reported)"
      },
      native: {}
    });
    await this.adapter.extendObjectAsync(`${prefix}.segments.manual_list`, {
      type: "state",
      common: {
        name: "Manual Segment List",
        type: "string",
        role: "text",
        read: true,
        write: true,
        def: "",
        desc: 'Comma-separated indices + ranges, e.g. "0-9" or "0-8,10-14" (only used when manual_mode=true)'
      },
      native: {}
    });
    const manualModeVal = device.manualMode === true;
    const manualListVal = device.manualMode && Array.isArray(device.manualSegments) && device.manualSegments.length > 0 ? device.manualSegments.join(",") : "";
    await this.adapter.setStateAsync(`${prefix}.segments.manual_mode`, {
      val: manualModeVal,
      ack: true
    });
    await this.adapter.setStateAsync(`${prefix}.segments.manual_list`, {
      val: manualListVal,
      ack: true
    });
    for (const i of validIndices) {
      await this.adapter.extendObjectAsync(`${prefix}.segments.${i}`, {
        type: "channel",
        common: { name: `Segment ${i}` },
        native: {}
      });
      await this.adapter.extendObjectAsync(`${prefix}.segments.${i}.color`, {
        type: "state",
        common: {
          name: "Color",
          type: "string",
          role: "level.color.rgb",
          read: true,
          write: true
        },
        native: {}
      });
      await this.adapter.extendObjectAsync(
        `${prefix}.segments.${i}.brightness`,
        {
          type: "state",
          common: {
            name: "Brightness",
            type: "number",
            role: "level.brightness",
            read: true,
            write: true,
            min: 0,
            max: 100,
            unit: "%"
          },
          native: {}
        }
      );
    }
    await this.adapter.extendObjectAsync(`${prefix}.segments.command`, {
      type: "state",
      common: {
        name: "Batch Segment Command",
        type: "string",
        role: "text",
        read: false,
        write: true,
        desc: "Format: segments:color:brightness \u2014 e.g. 1-5:#ff0000:20, all:#00ff00, 0,3,7::50"
      },
      native: {}
    });
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
    const existing = await this.adapter.getObjectViewAsync(
      "system",
      "channel",
      {
        startkey: segPrefix,
        endkey: `${segPrefix}\u9999`
      }
    );
    if (!(existing == null ? void 0 : existing.rows)) {
      return;
    }
    for (const row of existing.rows) {
      const localId = row.id.replace(`${this.adapter.namespace}.`, "");
      const segPart = localId.replace(`${prefix}.segments.`, "");
      const segIdx = parseInt(segPart, 10);
      if (!isNaN(segIdx) && !valid.has(segIdx)) {
        this.adapter.log.debug(`Removing excess segment: ${localId}`);
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
   * deletion), the setStateAsync will reject and we swallow it.
   *
   * @param device Govee device
   * @param state Partial state update
   */
  async updateDeviceState(device, state) {
    const prefix = this.devicePrefix(device);
    const writes = [];
    const set = (id, val) => {
      writes.push(
        this.adapter.setStateAsync(id, { val, ack: true }).catch(() => void 0)
      );
    };
    if (state.online !== void 0) {
      set(`${prefix}.info.online`, state.online);
    }
    if (state.power !== void 0) {
      set(`${prefix}.control.power`, state.power);
    }
    if (state.brightness !== void 0) {
      set(`${prefix}.control.brightness`, state.brightness);
    }
    if (state.colorRgb !== void 0) {
      set(`${prefix}.control.colorRgb`, state.colorRgb);
    }
    if (state.colorTemperature !== void 0) {
      set(`${prefix}.control.colorTemperature`, state.colorTemperature);
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
    await this.adapter.extendObjectAsync("groups", {
      type: "folder",
      common: { name: "Groups" },
      native: {}
    });
    await this.adapter.extendObjectAsync("groups.info", {
      type: "channel",
      common: { name: "Groups Status" },
      native: {}
    });
    await this.ensureState(
      "groups.info.online",
      "Cloud Online",
      "boolean",
      "indicator.reachable",
      false
    );
    await this.adapter.setStateAsync("groups.info.online", {
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
    await this.adapter.setStateAsync("groups.info.online", { val: online, ack: true }).catch(() => void 0);
  }
  /**
   * Update info.membersUnreachable for a group.
   * Creates the state if unreachable members exist, deletes it when all are reachable.
   *
   * @param group BaseGroup device
   * @param memberDevices Resolved member devices
   */
  async updateGroupMembersUnreachable(group, memberDevices) {
    const prefix = this.devicePrefix(group);
    const stateId = `${prefix}.info.membersUnreachable`;
    const unreachable = memberDevices.filter((m) => !m.state.online).map((m) => {
      const shortId = (0, import_types.normalizeDeviceId)(m.deviceId).slice(-4);
      return sanitize(`${m.sku}_${shortId}`);
    });
    if (unreachable.length === 0) {
      await this.adapter.delObjectAsync(stateId).catch(() => {
      });
      await this.adapter.delStateAsync(stateId).catch(() => {
      });
    } else {
      await this.ensureState(
        stateId,
        "Unreachable Members",
        "string",
        "text",
        false
      );
      await this.adapter.setStateAsync(stateId, {
        val: unreachable.join(", "),
        ack: true
      });
    }
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
    const currentPrefixes = new Set(
      currentDevices.map((d) => this.devicePrefix(d))
    );
    const removed = [];
    for (const folder of ["devices", "groups"]) {
      const existingObjects = await this.adapter.getObjectViewAsync(
        "system",
        "device",
        {
          startkey: `${this.adapter.namespace}.${folder}.`,
          endkey: `${this.adapter.namespace}.${folder}.\u9999`
        }
      );
      if (!(existingObjects == null ? void 0 : existingObjects.rows)) {
        continue;
      }
      for (const row of existingObjects.rows) {
        const localId = row.id.replace(`${this.adapter.namespace}.`, "");
        if (!currentPrefixes.has(localId)) {
          this.adapter.log.debug(`Removing stale device: ${localId}`);
          await this.adapter.delObjectAsync(localId, { recursive: true });
          this.forgetPrefix(localId);
          removed.push(localId);
        }
      }
    }
    return removed;
  }
  /**
   * Remove stale states across all managed channels.
   * Also handles migration from old single-control layout.
   *
   * One broad view-query across the whole device prefix replaces the old
   * four-per-device pass — the channel partition is recovered by parsing
   * the object id, saving three round-trips per device on every refresh.
   *
   * @param prefix Device prefix
   * @param stateDefs Current state definitions (non-segment)
   */
  async cleanupAllChannelStates(prefix, stateDefs) {
    var _a, _b, _c;
    const expectedByChannel = /* @__PURE__ */ new Map();
    for (const def of stateDefs) {
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
      return;
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
      const totals = (_b = totalsPerChannel.get(channel)) != null ? _b : { seen: 0, deleted: 0 };
      totals.seen++;
      const validIds = (_c = expectedByChannel.get(channel)) != null ? _c : /* @__PURE__ */ new Set();
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
    for (const [channel, totals] of totalsPerChannel) {
      if (totals.deleted > 0 && totals.deleted === totals.seen) {
        this.adapter.log.debug(`Removing empty channel: ${prefix}.${channel}`);
        await this.adapter.delObjectAsync(`${prefix}.${channel}`).catch(() => void 0);
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
  devicePrefix(device) {
    const shortId = (0, import_types.normalizeDeviceId)(device.deviceId).slice(-4);
    const folder = device.sku === "BaseGroup" ? "groups" : "devices";
    return `${folder}.${sanitize(`${device.sku}_${shortId}`)}`;
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
  }
  /**
   * Unique key for internal tracking (not used as object ID).
   *
   * @param device Govee device
   */
  deviceKey(device) {
    return `${device.sku}_${(0, import_types.normalizeDeviceId)(device.deviceId)}`;
  }
  /**
   * Create a state if it doesn't exist
   *
   * @param id State object ID
   * @param name Display name
   * @param type Value type
   * @param role ioBroker role
   * @param write Whether state is writable
   * @param unit Optional unit of measurement
   */
  async ensureState(id, name, type, role, write, unit) {
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
    await this.adapter.extendObjectAsync(id, {
      type: "state",
      common,
      native: {}
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager
});
//# sourceMappingURL=state-manager.js.map
