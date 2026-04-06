import type * as utils from "@iobroker/adapter-core";
import type { StateDefinition } from "./capability-mapper.js";
import type { DeviceState, GoveeDevice } from "./types.js";

/**
 * Sanitize a string for ioBroker object ID
 *
 * @param str Input string to sanitize
 */
function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/**
 * Normalize device ID — remove colons, lowercase
 *
 * @param id Raw device identifier
 */
function normalizeDeviceId(id: string): string {
  return id.replace(/:/g, "").toLowerCase();
}

/** Manages ioBroker state creation and updates for Govee devices */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  /** Maps deviceKey (sku_deviceId) → current object prefix */
  private readonly prefixMap = new Map<string, string>();

  /** @param adapter The ioBroker adapter instance */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Create device object and all states from capability definitions.
   *
   * @param device Govee device
   * @param stateDefs State definitions from capability mapper
   */
  async createDeviceStates(
    device: GoveeDevice,
    stateDefs: StateDefinition[],
  ): Promise<void> {
    const key = this.deviceKey(device);
    const newPrefix = this.devicePrefix(device);
    const oldPrefix = this.prefixMap.get(key);

    // Migrate if prefix changed (e.g., old naming scheme)
    if (oldPrefix && oldPrefix !== newPrefix) {
      this.adapter.log.debug(
        `Migrating device ${device.sku}: ${oldPrefix} → ${newPrefix}`,
      );
      await this.adapter.delObjectAsync(oldPrefix, { recursive: true });
    }
    this.prefixMap.set(key, newPrefix);

    const prefix = newPrefix;

    // Device object with online status indicator
    await this.adapter.extendObjectAsync(prefix, {
      type: "device",
      common: {
        name: device.name,
        statusStates: {
          onlineId: `${this.adapter.namespace}.${prefix}.info.online`,
        },
      } as ioBroker.DeviceCommon,
      native: {
        sku: device.sku,
        deviceId: device.deviceId,
      },
    });

    // Info channel
    await this.adapter.extendObjectAsync(`${prefix}.info`, {
      type: "channel",
      common: { name: "Device Information" },
      native: {},
    });

    await this.ensureState(
      `${prefix}.info.name`,
      "Name",
      "string",
      "text",
      false,
    );
    await this.ensureState(
      `${prefix}.info.model`,
      "Model",
      "string",
      "text",
      false,
    );
    await this.ensureState(
      `${prefix}.info.serial`,
      "Serial Number",
      "string",
      "text",
      false,
    );
    await this.ensureState(
      `${prefix}.info.online`,
      "Online",
      "boolean",
      "indicator.reachable",
      false,
    );

    await this.adapter.setStateAsync(`${prefix}.info.name`, {
      val: device.name,
      ack: true,
    });
    await this.adapter.setStateAsync(`${prefix}.info.model`, {
      val: device.sku,
      ack: true,
    });
    await this.adapter.setStateAsync(`${prefix}.info.serial`, {
      val: device.deviceId,
      ack: true,
    });
    await this.adapter.setStateAsync(`${prefix}.info.online`, {
      val: device.state.online ?? false,
      ack: true,
    });

    // Control channel
    const controlDefs = stateDefs.filter((d) => !d.id.startsWith("_segment_"));
    this.adapter.log.info(
      `[DBG] createDeviceStates ${device.sku}: ${controlDefs.length} states [${controlDefs.map((d) => d.id).join(", ")}]`,
    );
    if (controlDefs.length > 0) {
      await this.adapter.extendObjectAsync(`${prefix}.control`, {
        type: "channel",
        common: { name: "Controls" },
        native: {},
      });

      for (const def of controlDefs) {
        const common: Partial<ioBroker.StateCommon> = {
          name: def.name,
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

        await this.adapter.extendObjectAsync(`${prefix}.control.${def.id}`, {
          type: "state",
          common: common as ioBroker.StateCommon,
          native: {
            capabilityType: def.capabilityType,
            capabilityInstance: def.capabilityInstance,
          },
        });

        // Set default value if state has no value yet
        if (def.def !== undefined) {
          const current = await this.adapter.getStateAsync(
            `${prefix}.control.${def.id}`,
          );
          this.adapter.log.info(
            `[DBG] Default ${prefix}.${def.id}: current=${current ? JSON.stringify(current.val) : "null"}, def=${JSON.stringify(def.def)}`,
          );
          if (!current || current.val === null || current.val === undefined) {
            await this.adapter.setStateAsync(`${prefix}.control.${def.id}`, {
              val: def.def,
              ack: true,
            });
          }
        }
      }
    }

    // Check if device has segment capabilities
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
  async createSegmentStates(device: GoveeDevice): Promise<void> {
    const prefix = this.devicePrefix(device);

    await this.adapter.extendObjectAsync(`${prefix}.segments`, {
      type: "channel",
      common: { name: "LED Segments" },
      native: {},
    });

    // Determine segment count from capability parameters
    const segCap = device.capabilities.find((c) =>
      c.type.includes("segment_color_setting"),
    );
    const segmentCount = this.getSegmentCount(segCap);

    await this.ensureState(
      `${prefix}.segments.count`,
      "Segment Count",
      "number",
      "value",
      false,
    );
    await this.adapter.setStateAsync(`${prefix}.segments.count`, {
      val: segmentCount,
      ack: true,
    });

    for (let i = 0; i < segmentCount; i++) {
      await this.adapter.extendObjectAsync(`${prefix}.segments.${i}`, {
        type: "channel",
        common: { name: `Segment ${i}` },
        native: {},
      });

      await this.adapter.extendObjectAsync(`${prefix}.segments.${i}.color`, {
        type: "state",
        common: {
          name: "Color",
          type: "string",
          role: "level.color.rgb",
          read: true,
          write: true,
        } as ioBroker.StateCommon,
        native: {},
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
            unit: "%",
          } as ioBroker.StateCommon,
          native: {},
        },
      );
    }
  }

  /**
   * Update device state from any source (LAN, MQTT, Cloud).
   *
   * @param device Govee device
   * @param state Partial state update
   */
  async updateDeviceState(
    device: GoveeDevice,
    state: Partial<DeviceState>,
  ): Promise<void> {
    const prefix = this.devicePrefix(device);

    if (state.online !== undefined) {
      await this.setStateIfExists(`${prefix}.info.online`, state.online);
    }
    if (state.power !== undefined) {
      await this.setStateIfExists(`${prefix}.control.power`, state.power);
    }
    if (state.brightness !== undefined) {
      await this.setStateIfExists(
        `${prefix}.control.brightness`,
        state.brightness,
      );
    }
    if (state.colorRgb !== undefined) {
      await this.setStateIfExists(`${prefix}.control.colorRgb`, state.colorRgb);
    }
    if (state.colorTemperature !== undefined) {
      await this.setStateIfExists(
        `${prefix}.control.colorTemperature`,
        state.colorTemperature,
      );
    }
    if (state.scene !== undefined) {
      await this.setStateIfExists(`${prefix}.control.scene`, state.scene);
    }
  }

  /**
   * Remove all states for a device.
   *
   * @param device Govee device
   */
  async removeDevice(device: GoveeDevice): Promise<void> {
    const prefix = this.devicePrefix(device);
    await this.adapter.delObjectAsync(prefix, { recursive: true });
    this.prefixMap.delete(this.deviceKey(device));
  }

  /**
   * Cleanup stale devices that no longer exist.
   *
   * @param currentDevices Current device list
   */
  async cleanupDevices(currentDevices: GoveeDevice[]): Promise<void> {
    const currentPrefixes = new Set(
      currentDevices.map((d) => this.devicePrefix(d)),
    );

    // Cleanup both devices/ and groups/ folders
    for (const folder of ["devices", "groups"]) {
      const existingObjects = await this.adapter.getObjectViewAsync(
        "system",
        "device",
        {
          startkey: `${this.adapter.namespace}.${folder}.`,
          endkey: `${this.adapter.namespace}.${folder}.\u9999`,
        },
      );

      if (!existingObjects?.rows) {
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
   * Get device object ID prefix — stable SKU + short device ID.
   * Groups (BaseGroup) go under groups/, devices under devices/.
   * Human-readable name is in common.name, not in the object ID.
   *
   * @param device Govee device
   */
  devicePrefix(device: GoveeDevice): string {
    const shortId = normalizeDeviceId(device.deviceId).slice(-4);
    const folder = device.sku === "BaseGroup" ? "groups" : "devices";
    return `${folder}.${sanitize(`${device.sku}_${shortId}`)}`;
  }

  /**
   * Unique key for internal tracking (not used as object ID).
   *
   * @param device Govee device
   */
  private deviceKey(device: GoveeDevice): string {
    return `${device.sku}_${device.deviceId.replace(/:/g, "").toLowerCase()}`;
  }

  /**
   * Determine segment count from capability
   *
   * @param cap Segment color capability definition
   */
  private getSegmentCount(
    cap:
      | {
          parameters?: {
            fields?: Array<{ options?: Array<{ value: unknown }> }>;
          };
        }
      | undefined,
  ): number {
    if (!cap?.parameters?.fields) {
      return 0;
    }
    // Look for segment array field — typically the first field with options
    const segField = cap.parameters.fields.find(
      (f) => f.options && f.options.length > 0,
    );
    return segField?.options?.length ?? 15; // Default to 15 segments
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
  private async ensureState(
    id: string,
    name: string,
    type: ioBroker.CommonType,
    role: string,
    write: boolean,
    unit?: string,
  ): Promise<void> {
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
    await this.adapter.extendObjectAsync(id, {
      type: "state",
      common: common as ioBroker.StateCommon,
      native: {},
    });
  }

  /**
   * Set state value only if the object exists
   *
   * @param id State object ID
   * @param value Value to set
   */
  private async setStateIfExists(
    id: string,
    value: ioBroker.StateValue,
  ): Promise<void> {
    const obj = await this.adapter.getObjectAsync(id);
    if (obj) {
      await this.adapter.setStateAsync(id, { val: value, ack: true });
    }
  }
}
