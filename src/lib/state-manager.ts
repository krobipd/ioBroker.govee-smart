import type * as utils from "@iobroker/adapter-core";
import type { StateDefinition } from "./capability-mapper.js";
import {
  GROUP_ICON,
  iconForGoveeType,
  shortenGoveeType,
} from "./device-icons.js";
import { resolveSegmentCount } from "./device-manager.js";
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

/**
 * Channels whose state-set is fully described by capability-driven stateDefs.
 * Only these get the stale-state cleanup pass — `info` is intentionally absent
 * because it mixes capability-driven states (diagnostics_export/result) with
 * adapter-managed ones (online, model, serial, ip, members) that come from
 * ensureState instead of stateDefs. Cleaning `info` by stateDef-set would
 * delete the adapter-managed ones.
 */
const MANAGED_CHANNELS = ["control", "scenes", "music", "snapshots"];
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
  info: "Device Information",
};

/** Manages ioBroker state creation and updates for Govee devices */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  /** Maps deviceKey (sku_deviceId) → current object prefix */
  private readonly prefixMap = new Map<string, string>();
  /** Maps "prefix.stateId" → channel name (populated during createDeviceStates) */
  private readonly stateChannelMap = new Map<string, string>();

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
    const channel =
      this.stateChannelMap.get(`${prefix}.${stateId}`) ?? "control";
    return `${prefix}.${channel}.${stateId}`;
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
    await this.adapter.extendObjectAsync(prefix, {
      type: "device",
      common: {
        name: device.name,
        icon,
        statusStates: { onlineId },
      } as ioBroker.DeviceCommon,
      native: {
        sku: device.sku,
        deviceId: device.deviceId,
      },
    });

    // Info channel — groups only get name (no individual online)
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
    await this.adapter.setStateAsync(`${prefix}.info.name`, {
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
      );
      await this.adapter.setStateAsync(`${prefix}.info.online`, {
        val: device.state.online ?? false,
        ack: true,
      });
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
      // Device-type marker — short label like "light", "thermometer",
      // "heater" (Govee API type without the "devices.types." prefix).
      // Lets scripts filter `*.info.type === "light"` without parsing.
      await this.ensureState(
        `${prefix}.info.type`,
        "Device Type",
        "string",
        "text",
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
      await this.adapter.setStateAsync(`${prefix}.info.type`, {
        val: shortenGoveeType(device.type),
        ack: true,
      });
    } else {
      // Group members: comma-separated device prefix IDs
      const memberIds = (device.groupMembers ?? [])
        .map((m) => {
          const shortId = normalizeDeviceId(m.deviceId).slice(-4);
          return sanitize(`${m.sku}_${shortId}`);
        })
        .join(", ");
      await this.ensureState(
        `${prefix}.info.members`,
        "Members",
        "string",
        "text",
        false,
      );
      await this.adapter.setStateAsync(`${prefix}.info.members`, {
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
      ]) {
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
      const channel = def.channel ?? "control";
      this.stateChannelMap.set(`${prefix}.${def.id}`, channel);
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
        if (def.desc) {
          common.desc = def.desc;
        }

        await this.adapter.extendObjectAsync(`${prefix}.${channel}.${def.id}`, {
          type: "state",
          common: common as ioBroker.StateCommon,
          native: {
            capabilityType: def.capabilityType,
            capabilityInstance: def.capabilityInstance,
          },
        });

        // Initialize or validate state value
        if (def.def !== undefined) {
          const current = await this.adapter.getStateAsync(
            `${prefix}.${channel}.${def.id}`,
          );
          if (!current || current.val === null || current.val === undefined) {
            // Set default value for new states
            await this.adapter.setStateAsync(`${prefix}.${channel}.${def.id}`, {
              val: def.def,
              ack: true,
            });
          } else if (def.states && !(String(current.val) in def.states)) {
            // Reset dropdown to default if current value is no longer valid
            this.adapter.log.debug(
              `Resetting stale dropdown: ${prefix}.${channel}.${def.id} = "${String(current.val)}" → "${String(def.def)}"`,
            );
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
      device.manualMode &&
      Array.isArray(device.manualSegments) &&
      device.manualSegments.length > 0
        ? device.manualSegments.slice().sort((a, b) => a - b)
        : Array.from({ length: segmentCount }, (_, i) => i);
    const reportedCount = validIndices.length;

    await this.ensureState(
      `${prefix}.segments.count`,
      "Segment Count",
      "number",
      "value",
      false,
    );
    await this.adapter.setStateAsync(`${prefix}.segments.count`, {
      val: reportedCount,
      ack: true,
    });

    // Manual-mode toggle and list — user-writable for cut-strip overrides
    await this.adapter.extendObjectAsync(`${prefix}.segments.manual_mode`, {
      type: "state",
      common: {
        name: "Manual Segments Active",
        type: "boolean",
        role: "switch",
        read: true,
        write: true,
        def: false,
        desc: "Enable manual segment list (e.g. for cut LED strips with fewer physical segments than reported)",
      } as ioBroker.StateCommon,
      native: {},
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
        desc: 'Comma-separated indices + ranges, e.g. "0-9" or "0-8,10-14" (only used when manual_mode=true)',
      } as ioBroker.StateCommon,
      native: {},
    });

    // Sync manual_mode / manual_list states back from the runtime device
    // (restored from cache on startup, or updated by the wizard). Using
    // ack=true keeps this out of the user-change handler path.
    const manualModeVal = device.manualMode === true;
    const manualListVal =
      device.manualMode &&
      Array.isArray(device.manualSegments) &&
      device.manualSegments.length > 0
        ? device.manualSegments.join(",")
        : "";
    await this.adapter.setStateAsync(`${prefix}.segments.manual_mode`, {
      val: manualModeVal,
      ack: true,
    });
    await this.adapter.setStateAsync(`${prefix}.segments.manual_list`, {
      val: manualListVal,
      ack: true,
    });

    for (const i of validIndices) {
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
  private async cleanupExcessSegments(
    prefix: string,
    validIndices: number[],
  ): Promise<void> {
    const valid = new Set(validIndices);
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
  async updateDeviceState(
    device: GoveeDevice,
    state: Partial<DeviceState>,
  ): Promise<void> {
    const prefix = this.devicePrefix(device);
    const writes: Promise<unknown>[] = [];

    const set = (id: string, val: ioBroker.StateValue): void => {
      writes.push(
        this.adapter
          .setStateAsync(id, { val, ack: true })
          .catch(() => undefined),
      );
    };

    if (state.online !== undefined) {
      set(`${prefix}.info.online`, state.online);
    }
    if (state.power !== undefined) {
      set(`${prefix}.control.power`, state.power);
    }
    if (state.brightness !== undefined) {
      set(`${prefix}.control.brightness`, state.brightness);
    }
    if (state.colorRgb !== undefined) {
      set(`${prefix}.control.colorRgb`, state.colorRgb);
    }
    if (state.colorTemperature !== undefined) {
      set(`${prefix}.control.colorTemperature`, state.colorTemperature);
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
    await this.adapter.extendObjectAsync("groups", {
      type: "folder",
      common: { name: "Groups" },
      native: {},
    });
    await this.adapter.extendObjectAsync("groups.info", {
      type: "channel",
      common: { name: "Groups Status" },
      native: {},
    });
    await this.ensureState(
      "groups.info.online",
      "Cloud Online",
      "boolean",
      "indicator.reachable",
      false,
    );
    await this.adapter.setStateAsync("groups.info.online", {
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
    await this.adapter
      .setStateAsync("groups.info.online", { val: online, ack: true })
      .catch(() => undefined);
  }

  /**
   * Update info.membersUnreachable for a group.
   * Creates the state if unreachable members exist, deletes it when all are reachable.
   *
   * @param group BaseGroup device
   * @param memberDevices Resolved member devices
   */
  async updateGroupMembersUnreachable(
    group: GoveeDevice,
    memberDevices: GoveeDevice[],
  ): Promise<void> {
    const prefix = this.devicePrefix(group);
    const stateId = `${prefix}.info.membersUnreachable`;

    const unreachable = memberDevices
      .filter((m) => !m.state.online)
      .map((m) => {
        const shortId = normalizeDeviceId(m.deviceId).slice(-4);
        return sanitize(`${m.sku}_${shortId}`);
      });

    if (unreachable.length === 0) {
      // All members reachable — delete the state
      await this.adapter.delObjectAsync(stateId).catch(() => {});
      await this.adapter.delStateAsync(stateId).catch(() => {});
    } else {
      await this.ensureState(
        stateId,
        "Unreachable Members",
        "string",
        "text",
        false,
      );
      await this.adapter.setStateAsync(stateId, {
        val: unreachable.join(", "),
        ack: true,
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
  async cleanupDevices(currentDevices: GoveeDevice[]): Promise<string[]> {
    const currentPrefixes = new Set(
      currentDevices.map((d) => this.devicePrefix(d)),
    );
    const removed: string[] = [];

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
  private async cleanupAllChannelStates(
    prefix: string,
    stateDefs: StateDefinition[],
  ): Promise<void> {
    // Build expected state set per channel
    const expectedByChannel = new Map<string, Set<string>>();
    for (const def of stateDefs) {
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

    const totalsPerChannel = new Map<
      string,
      { seen: number; deleted: number }
    >();
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
        await this.adapter
          .delObjectAsync(`${prefix}.${channel}`)
          .catch(() => undefined);
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
  }

  /**
   * Unique key for internal tracking (not used as object ID).
   *
   * @param device Govee device
   */
  private deviceKey(device: GoveeDevice): string {
    // Use normalizeDeviceId which is defensive against non-string input —
    // cached data on disk could theoretically be tampered with.
    return `${device.sku}_${normalizeDeviceId(device.deviceId)}`;
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
}
