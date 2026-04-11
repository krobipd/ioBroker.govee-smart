import type * as utils from "@iobroker/adapter-core";
import type { StateDefinition } from "./capability-mapper.js";
import {
  normalizeDeviceId,
  type DeviceState,
  type GoveeDevice,
} from "./types.js";

/**
 * Sanitize a string for ioBroker object ID
 *
 * @param str Input string to sanitize
 */
function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/** State IDs routed to the scenes channel */
const SCENE_IDS = new Set(["light_scene", "diy_scene", "scene_speed"]);
/** State IDs routed to the music channel */
const MUSIC_IDS = new Set([
  "music_mode",
  "music_sensitivity",
  "music_auto_color",
]);
/** State IDs routed to the snapshots channel */
const SNAPSHOT_IDS = new Set([
  "snapshot",
  "snapshot_local",
  "snapshot_save",
  "snapshot_delete",
]);
/** All managed channels (for cleanup of stale states) */
const MANAGED_CHANNELS = ["control", "scenes", "music", "snapshots"];
/** Channel display names */
const CHANNEL_NAMES: Record<string, string> = {
  control: "Controls",
  scenes: "Scenes",
  music: "Music",
  snapshots: "Snapshots",
};

/**
 * Determine which channel a state belongs to.
 *
 * @param stateId State ID suffix (e.g. "power", "light_scene")
 */
function getChannelForState(stateId: string): string {
  if (SCENE_IDS.has(stateId)) {
    return "scenes";
  }
  if (MUSIC_IDS.has(stateId)) {
    return "music";
  }
  if (SNAPSHOT_IDS.has(stateId)) {
    return "snapshots";
  }
  return "control";
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
   * Resolve full state path for a given device prefix and state ID.
   * Routes the state to the correct channel (control, scenes, music, snapshots).
   *
   * @param prefix Device object ID prefix
   * @param stateId State ID suffix
   */
  resolveStatePath(prefix: string, stateId: string): string {
    return `${prefix}.${getChannelForState(stateId)}.${stateId}`;
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
    const isGroup = device.sku === "BaseGroup";

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

    // Info channel — groups only get name + online
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
    await this.adapter.setStateAsync(`${prefix}.info.online`, {
      val: device.state.online ?? false,
      ack: true,
    });

    if (!isGroup) {
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
        `${prefix}.info.ip`,
        "IP Address",
        "string",
        "info.ip",
        false,
      );
      await this.adapter.setStateAsync(`${prefix}.info.model`, {
        val: device.sku,
        ack: true,
      });
      await this.adapter.setStateAsync(`${prefix}.info.serial`, {
        val: device.deviceId,
        ack: true,
      });
      await this.adapter.setStateAsync(`${prefix}.info.ip`, {
        val: device.lanIp ?? "",
        ack: true,
      });
    } else {
      // Clean up stale info states from older versions
      for (const staleId of ["model", "serial", "ip"]) {
        await this.adapter
          .delObjectAsync(`${prefix}.info.${staleId}`)
          .catch(() => {});
        await this.adapter
          .delStateAsync(`${prefix}.info.${staleId}`)
          .catch(() => {});
      }
    }

    // Group state defs by channel (control, scenes, music, snapshots)
    const nonSegmentDefs = stateDefs.filter(
      (d) => !d.id.startsWith("_segment_"),
    );
    const channelGroups = new Map<string, StateDefinition[]>();
    for (const def of nonSegmentDefs) {
      const channel = getChannelForState(def.id);
      if (!channelGroups.has(channel)) {
        channelGroups.set(channel, []);
      }
      channelGroups.get(channel)!.push(def);
    }

    this.adapter.log.debug(
      `createDeviceStates ${device.sku}: ${nonSegmentDefs.length} states in ${channelGroups.size} channel(s)`,
    );

    // Create states in each channel
    for (const [channel, defs] of channelGroups) {
      await this.adapter.extendObjectAsync(`${prefix}.${channel}`, {
        type: "channel",
        common: { name: CHANNEL_NAMES[channel] ?? channel },
        native: {},
      });

      for (const def of defs) {
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

        await this.adapter.extendObjectAsync(`${prefix}.${channel}.${def.id}`, {
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
            `${prefix}.${channel}.${def.id}`,
          );
          if (!current || current.val === null || current.val === undefined) {
            await this.adapter.setStateAsync(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true,
            });
          }
        }
      }
    }

    // Remove stale states across all managed channels
    await this.cleanupAllChannelStates(prefix, nonSegmentDefs);

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
    device.segmentCount = segmentCount;

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

    // Comfort command state for batch segment control
    await this.adapter.extendObjectAsync(`${prefix}.segments.command`, {
      type: "state",
      common: {
        name: "Batch Segment Command",
        type: "string",
        role: "text",
        read: false,
        write: true,
        desc: "Format: segments:color:brightness — e.g. 1-5:#ff0000:20, all:#00ff00, 0,3,7::50",
      } as ioBroker.StateCommon,
      native: {},
    });

    // Remove excess segment channels from previous runs
    await this.cleanupExcessSegments(prefix, segmentCount);
  }

  /**
   * Remove segment sub-channels that exceed the current segment count.
   *
   * @param prefix Device prefix
   * @param segmentCount Current segment count
   */
  private async cleanupExcessSegments(
    prefix: string,
    segmentCount: number,
  ): Promise<void> {
    const segPrefix = `${this.adapter.namespace}.${prefix}.segments.`;
    const existing = await this.adapter.getObjectViewAsync(
      "system",
      "channel",
      {
        startkey: segPrefix,
        endkey: `${segPrefix}\u9999`,
      },
    );

    if (!existing?.rows) {
      return;
    }

    for (const row of existing.rows) {
      const localId = row.id.replace(`${this.adapter.namespace}.`, "");
      const segPart = localId.replace(`${prefix}.segments.`, "");
      const segIdx = parseInt(segPart, 10);
      if (!isNaN(segIdx) && segIdx >= segmentCount) {
        this.adapter.log.debug(`Removing excess segment: ${localId}`);
        await this.adapter.delObjectAsync(localId, { recursive: true });
      }
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
   * Remove stale states across all managed channels.
   * Also handles migration from old single-control layout.
   *
   * @param prefix Device prefix
   * @param stateDefs Current state definitions (non-segment)
   */
  private async cleanupAllChannelStates(
    prefix: string,
    stateDefs: StateDefinition[],
  ): Promise<void> {
    // Build expected state set per channel
    const expectedByChannel = new Map<string, Set<string>>();
    for (const def of stateDefs) {
      const channel = getChannelForState(def.id);
      if (!expectedByChannel.has(channel)) {
        expectedByChannel.set(channel, new Set());
      }
      expectedByChannel.get(channel)!.add(def.id);
    }

    for (const channel of MANAGED_CHANNELS) {
      const channelPrefix = `${this.adapter.namespace}.${prefix}.${channel}.`;
      const existing = await this.adapter.getObjectViewAsync(
        "system",
        "state",
        {
          startkey: channelPrefix,
          endkey: `${channelPrefix}\u9999`,
        },
      );

      if (!existing?.rows) {
        continue;
      }

      const validIds = expectedByChannel.get(channel) ?? new Set<string>();
      let deleted = 0;
      for (const row of existing.rows) {
        const stateId = row.id.replace(channelPrefix, "");
        if (!validIds.has(stateId)) {
          const localId = row.id.replace(`${this.adapter.namespace}.`, "");
          this.adapter.log.debug(`Removing stale state: ${localId}`);
          await this.adapter.delObjectAsync(localId);
          await this.adapter.delStateAsync(localId).catch(() => {});
          deleted++;
        }
      }

      // Remove empty channel object
      if (deleted > 0 && deleted === existing.rows.length) {
        this.adapter.log.debug(`Removing empty channel: ${prefix}.${channel}`);
        await this.adapter
          .delObjectAsync(`${prefix}.${channel}`)
          .catch(() => {});
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
            fields?: Array<{
              fieldName?: string;
              elementRange?: { min?: number; max?: number };
            }>;
          };
        }
      | undefined,
  ): number {
    if (!cap?.parameters?.fields) {
      return 0;
    }
    // Segment count from "segment" field's elementRange (0-based max → count = max + 1)
    const segField = cap.parameters.fields.find(
      (f) => f.fieldName === "segment",
    );
    if (segField?.elementRange?.max !== undefined) {
      return segField.elementRange.max + 1;
    }
    return 0;
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
