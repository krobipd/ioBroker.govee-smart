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
function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}
function normalizeDeviceId(id) {
  return id.replace(/:/g, "").toLowerCase();
}
class StateManager {
  adapter;
  /** Maps deviceKey (sku_deviceId) → current object prefix */
  prefixMap = /* @__PURE__ */ new Map();
  /** @param adapter The ioBroker adapter instance */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /**
   * Create device object and all states from capability definitions.
   *
   * @param device Govee device
   * @param stateDefs State definitions from capability mapper
   */
  async createDeviceStates(device, stateDefs) {
    var _a;
    const key = this.deviceKey(device);
    const newPrefix = this.devicePrefix(device);
    const oldPrefix = this.prefixMap.get(key);
    if (oldPrefix && oldPrefix !== newPrefix) {
      this.adapter.log.debug(
        `Migrating device ${device.sku}: ${oldPrefix} \u2192 ${newPrefix}`
      );
      await this.adapter.delObjectAsync(oldPrefix, { recursive: true });
    }
    this.prefixMap.set(key, newPrefix);
    const prefix = newPrefix;
    await this.adapter.extendObjectAsync(prefix, {
      type: "device",
      common: {
        name: device.name,
        statusStates: {
          onlineId: `${this.adapter.namespace}.${prefix}.info.online`
        }
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
      `${prefix}.info.online`,
      "Online",
      "boolean",
      "indicator.reachable",
      false
    );
    await this.adapter.setStateAsync(`${prefix}.info.name`, {
      val: device.name,
      ack: true
    });
    await this.adapter.setStateAsync(`${prefix}.info.model`, {
      val: device.sku,
      ack: true
    });
    await this.adapter.setStateAsync(`${prefix}.info.serial`, {
      val: device.deviceId,
      ack: true
    });
    await this.adapter.setStateAsync(`${prefix}.info.online`, {
      val: (_a = device.state.online) != null ? _a : false,
      ack: true
    });
    const controlDefs = stateDefs.filter((d) => !d.id.startsWith("_segment_"));
    this.adapter.log.debug(
      `createDeviceStates ${device.sku}: ${controlDefs.length} control states`
    );
    if (controlDefs.length > 0) {
      await this.adapter.extendObjectAsync(`${prefix}.control`, {
        type: "channel",
        common: { name: "Controls" },
        native: {}
      });
      for (const def of controlDefs) {
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
        await this.adapter.extendObjectAsync(`${prefix}.control.${def.id}`, {
          type: "state",
          common,
          native: {
            capabilityType: def.capabilityType,
            capabilityInstance: def.capabilityInstance
          }
        });
        if (def.def !== void 0) {
          const current = await this.adapter.getStateAsync(
            `${prefix}.control.${def.id}`
          );
          this.adapter.log.debug(
            `Default ${def.id}: current=${current ? JSON.stringify(current.val) : "null"}, def=${JSON.stringify(def.def)}`
          );
          if (!current || current.val === null || current.val === void 0) {
            await this.adapter.setStateAsync(`${prefix}.control.${def.id}`, {
              val: def.def,
              ack: true
            });
          }
        }
      }
    }
    await this.cleanupControlStates(prefix, controlDefs);
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
    const segCap = device.capabilities.find(
      (c) => c.type.includes("segment_color_setting")
    );
    const segmentCount = this.getSegmentCount(segCap);
    await this.ensureState(
      `${prefix}.segments.count`,
      "Segment Count",
      "number",
      "value",
      false
    );
    await this.adapter.setStateAsync(`${prefix}.segments.count`, {
      val: segmentCount,
      ack: true
    });
    for (let i = 0; i < segmentCount; i++) {
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
  }
  /**
   * Update device state from any source (LAN, MQTT, Cloud).
   *
   * @param device Govee device
   * @param state Partial state update
   */
  async updateDeviceState(device, state) {
    const prefix = this.devicePrefix(device);
    if (state.online !== void 0) {
      await this.setStateIfExists(`${prefix}.info.online`, state.online);
    }
    if (state.power !== void 0) {
      await this.setStateIfExists(`${prefix}.control.power`, state.power);
    }
    if (state.brightness !== void 0) {
      await this.setStateIfExists(
        `${prefix}.control.brightness`,
        state.brightness
      );
    }
    if (state.colorRgb !== void 0) {
      await this.setStateIfExists(`${prefix}.control.colorRgb`, state.colorRgb);
    }
    if (state.colorTemperature !== void 0) {
      await this.setStateIfExists(
        `${prefix}.control.colorTemperature`,
        state.colorTemperature
      );
    }
    if (state.scene !== void 0) {
      await this.setStateIfExists(`${prefix}.control.scene`, state.scene);
    }
  }
  /**
   * Remove all states for a device.
   *
   * @param device Govee device
   */
  async removeDevice(device) {
    const prefix = this.devicePrefix(device);
    await this.adapter.delObjectAsync(prefix, { recursive: true });
    this.prefixMap.delete(this.deviceKey(device));
  }
  /**
   * Cleanup stale devices that no longer exist.
   *
   * @param currentDevices Current device list
   */
  async cleanupDevices(currentDevices) {
    const currentPrefixes = new Set(
      currentDevices.map((d) => this.devicePrefix(d))
    );
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
        }
      }
    }
  }
  /**
   * Remove control states that are no longer in the current definitions.
   *
   * @param prefix Device prefix
   * @param controlDefs Current control state definitions
   */
  async cleanupControlStates(prefix, controlDefs) {
    const validIds = new Set(controlDefs.map((d) => d.id));
    const controlPrefix = `${this.adapter.namespace}.${prefix}.control.`;
    const existing = await this.adapter.getObjectViewAsync("system", "state", {
      startkey: controlPrefix,
      endkey: `${controlPrefix}\u9999`
    });
    if (!(existing == null ? void 0 : existing.rows)) {
      return;
    }
    for (const row of existing.rows) {
      const stateId = row.id.replace(controlPrefix, "");
      if (!validIds.has(stateId)) {
        const localId = row.id.replace(`${this.adapter.namespace}.`, "");
        this.adapter.log.debug(`Removing stale control state: ${localId}`);
        await this.adapter.delObjectAsync(localId);
        await this.adapter.delStateAsync(localId).catch(() => {
        });
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
    const shortId = normalizeDeviceId(device.deviceId).slice(-4);
    const folder = device.sku === "BaseGroup" ? "groups" : "devices";
    return `${folder}.${sanitize(`${device.sku}_${shortId}`)}`;
  }
  /**
   * Unique key for internal tracking (not used as object ID).
   *
   * @param device Govee device
   */
  deviceKey(device) {
    return `${device.sku}_${device.deviceId.replace(/:/g, "").toLowerCase()}`;
  }
  /**
   * Determine segment count from capability
   *
   * @param cap Segment color capability definition
   */
  getSegmentCount(cap) {
    var _a, _b, _c;
    if (!((_a = cap == null ? void 0 : cap.parameters) == null ? void 0 : _a.fields)) {
      return 0;
    }
    const segField = cap.parameters.fields.find(
      (f) => f.options && f.options.length > 0
    );
    return (_c = (_b = segField == null ? void 0 : segField.options) == null ? void 0 : _b.length) != null ? _c : 15;
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
  /**
   * Set state value only if the object exists
   *
   * @param id State object ID
   * @param value Value to set
   */
  async setStateIfExists(id, value) {
    const obj = await this.adapter.getObjectAsync(id);
    if (obj) {
      await this.adapter.setStateAsync(id, { val: value, ack: true });
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager
});
//# sourceMappingURL=state-manager.js.map
