// The object id a device's tree lives under — decided once, stored, never derived again.

import { isAppGroup } from "./govee-constants";
import { mapKey } from "./device-key";
import { normalizeDeviceId } from "./types";

/**
 * The generation of the device-id rule a device object was given its id under, written as
 * `native.idScheme` with the rest of the device object. Objects of 2.x carry no mark: their id was
 * `<sku>_<last 4>`, derived again at every start and never checked for a second device with the same
 * four characters. 3 is `<sku>-<last 4>`, the rule of the sister adapters (yamaha, homeconnect),
 * with the collision handled. A device object without the mark moves once (`migrateDeviceIds`).
 */
export const ID_SCHEME = 3;

/** Ids the instance keeps for itself below `devices.`/`groups.` — `groups.info` holds the group rollup. */
const RESERVED_DEVICE_IDS: ReadonlySet<string> = new Set(["info"]);

/** How many trailing characters of the device's own id the object id carries. */
const ID_TAIL = 4;

/**
 * The model half of the id: the SKU in lower case, every run of anything but a letter or a digit one
 * hyphen, nothing at either end (`H61BE` → `h61be`, `BaseGroup` → `basegroup`); `device` when nothing
 * is left.
 *
 * @param sku the Govee SKU
 * @returns the id-safe model part
 */
export function modelPart(sku: unknown): string {
  const slug =
    typeof sku === "string"
      ? sku
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
      : "";
  return slug.length > 0 ? slug : "device";
}

/**
 * The part of the id that names this one device: Govee's device id without separators, letters and
 * digits only, lower case (`AB:CD:EF:12:34:56:78:90` → `abcdef1234567890`; a group number stays as it is).
 *
 * @param deviceId Govee's device id
 * @returns the piece, empty when nothing usable is left
 */
export function idPiece(deviceId: unknown): string {
  return normalizeDeviceId(deviceId as string).replace(/[^a-z0-9]/g, "");
}

/**
 * `base`, or `base-2`, `base-3` … — the first one that is free.
 *
 * @param base the id wanted
 * @param taken the ids other devices hold in the same folder
 * @returns a free id
 */
function counted(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_DEVICE_IDS.has(id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/**
 * The id a device gets: its SKU and the last four characters of its own id (`h61be-525f`). Short, and
 * unique for two devices of one model — unless both end in the same four characters: then the one
 * that comes second gets its whole id (`h61be-abcdef123456525f`), and a counter after that.
 *
 * @param sku the Govee SKU
 * @param deviceId Govee's device id
 * @param taken the ids other devices hold in the same folder
 * @returns the id
 */
export function deviceIdFor(sku: unknown, deviceId: unknown, taken: ReadonlySet<string>): string {
  const model = modelPart(sku);
  const piece = idPiece(deviceId);
  if (piece.length === 0) {
    return counted(model, taken);
  }
  const short = `${model}-${piece.slice(-ID_TAIL)}`;
  if (!taken.has(short) && !RESERVED_DEVICE_IDS.has(short)) {
    return short;
  }
  return counted(`${model}-${piece}`, taken);
}

/**
 * The folder a device's tree lives in.
 *
 * @param sku the Govee SKU
 * @returns `groups` for an app group, `devices` for everything else
 */
export function deviceFolder(sku: string): "devices" | "groups" {
  return isAppGroup({ sku }) ? "groups" : "devices";
}

/** One device the registry knows. */
interface Entry {
  sku: string;
  deviceId: string;
  /** `devices.<id>` or `groups.<id>`. */
  prefix: string;
}

/**
 * The one place that knows which tree belongs to which device. Filled at start from the device
 * objects (after the one-time move, every one carries `native.idScheme`); a device seen for the first
 * time gets its id from {@link deviceIdFor} against the ids already held. Everything that names a
 * device's tree — the state tree, the member lists, the cleanup's protection, the local snapshots —
 * reads it here; nothing derives an id on its own any more.
 */
export class DeviceIdRegistry {
  private readonly byKey = new Map<string, Entry>();
  private readonly byPrefix = new Map<string, Entry>();

  /**
   * Record a tree that already exists under its id.
   *
   * @param sku the Govee SKU
   * @param deviceId Govee's device id
   * @param prefix the tree (`devices.<id>`)
   * @returns false when the device or the tree is already recorded under something else
   */
  seed(sku: string, deviceId: string, prefix: string): boolean {
    const key = mapKey(sku, deviceId);
    if (this.byKey.has(key) || this.byPrefix.has(prefix)) {
      return this.byKey.get(key)?.prefix === prefix;
    }
    const entry = { sku, deviceId, prefix };
    this.byKey.set(key, entry);
    this.byPrefix.set(prefix, entry);
    return true;
  }

  /**
   * The tree of a device — assigned on the first ask, the same from then on.
   *
   * @param sku the Govee SKU
   * @param deviceId Govee's device id
   * @returns `devices.<id>` or `groups.<id>`
   */
  prefixFor(sku: string, deviceId: string): string {
    const known = this.byKey.get(mapKey(sku, deviceId));
    if (known) {
      return known.prefix;
    }
    const folder = deviceFolder(sku);
    const prefix = `${folder}.${deviceIdFor(sku, deviceId, this.idsIn(folder))}`;
    this.seed(sku, deviceId, prefix);
    return prefix;
  }

  /**
   * The id part of a device's tree (`h61be-525f`) — what a group's member list names.
   *
   * @param sku the Govee SKU
   * @param deviceId Govee's device id
   * @returns the id without its folder
   */
  idFor(sku: string, deviceId: string): string {
    const prefix = this.prefixFor(sku, deviceId);
    return prefix.slice(prefix.indexOf(".") + 1);
  }

  /**
   * Forget a tree that was removed — its id is free again.
   *
   * @param prefix the removed tree
   */
  release(prefix: string): void {
    const entry = this.byPrefix.get(prefix);
    if (entry) {
      this.byPrefix.delete(prefix);
      this.byKey.delete(mapKey(entry.sku, entry.deviceId));
    }
  }

  /**
   * The ids held in one folder.
   *
   * @param folder `devices` or `groups`
   * @returns the ids without their folder
   */
  private idsIn(folder: string): Set<string> {
    const ids = new Set<string>();
    for (const prefix of this.byPrefix.keys()) {
      if (prefix.startsWith(`${folder}.`)) {
        ids.add(prefix.slice(folder.length + 1));
      }
    }
    return ids;
  }
}
