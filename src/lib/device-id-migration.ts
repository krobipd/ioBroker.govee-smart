// The one-time move of every 2.x tree (`devices.h61be_525f`) to the id rule of 3.0.0 (`devices.h61be-525f`).

import { copyDeviceTree, movedId, type DeviceMoveDeps } from "./device-move";
import { ID_SCHEME, idPiece, type DeviceIdRegistry } from "./device-id";
import { isPseudoGroupSku } from "./govee-constants";
import { errMessage } from "./err-message";

/** What the migration needs beyond the move itself. */
export interface IdMigrationDeps extends DeviceMoveDeps {
  /** The device objects of the instance, keyed by full id — the one read every start needs. */
  deviceObjects(): Promise<Record<string, ioBroker.Object | null | undefined>>;
  /**
   * Delete the given ids one by one, in the given order, and carry their room and function entries to
   * their successors — the fleet helper `moveAllWithEnums` in its order (read, delete, write). Never a
   * recursive delete: that removes the root first, and the root holds the move journal (round 72).
   *
   * @param ids the full ids that go away, deepest first, the root last
   * @param successors the new full ids of an id that moves
   * @returns how many room/function entries now list one of the new ids
   */
  removeCarryingEnums(ids: readonly string[], successors: (id: string) => readonly string[]): Promise<number>;
  /** Adapter log. */
  log: { info(msg: string): void; debug(msg: string): void; warn(msg: string): void };
}

/** A device tree found at start. */
interface Tree {
  /** Namespace-relative id (`devices.h61be_525f`). */
  rel: string;
  sku: string;
  deviceId: string;
  /** The device object carries the mark of the current rule. */
  marked: boolean;
  /** The move journal of an interrupted move (`native.movingTo`). */
  movingTo?: string;
  /** The name to show in the log line. */
  label: string;
}

/**
 * The display name of a device object — a plain name or the English of a translated one.
 *
 * @param common the device object's `common`
 * @param fallback what to show without a name
 * @returns the name
 */
function labelOf(common: unknown, fallback: string): string {
  const name = (common as { name?: unknown } | undefined)?.name;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  if (name && typeof name === "object") {
    const en = (name as Record<string, unknown>).en;
    if (typeof en === "string" && en.length > 0) {
      return en;
    }
  }
  return fallback;
}

/**
 * Every device tree below `devices.`/`groups.` that the migration can place: a device object whose
 * `native` names its SKU and Govee's device id (every version since the first writes both).
 *
 * @param namespace the adapter namespace
 * @param all every object of the instance
 * @param log the adapter log
 * @returns the trees
 */
function findTrees(
  namespace: string,
  all: Record<string, ioBroker.Object | null | undefined>,
  log: IdMigrationDeps["log"],
): Tree[] {
  const trees: Tree[] = [];
  for (const [id, obj] of Object.entries(all)) {
    if (!obj || obj.type !== "device" || !id.startsWith(`${namespace}.`)) {
      continue;
    }
    const rel = id.slice(namespace.length + 1);
    if (!/^(devices|groups)\.[^.]+$/.test(rel)) {
      continue;
    }
    const native = (obj.native ?? {}) as Record<string, unknown>;
    if (typeof native.sku !== "string" || typeof native.deviceId !== "string" || native.deviceId.length === 0) {
      log.debug(`device id migration: ${rel} names no device — left to the cleanup`);
      continue;
    }
    if (isPseudoGroupSku(native.sku)) {
      continue;
    }
    trees.push({
      rel,
      sku: native.sku,
      deviceId: native.deviceId,
      marked: native.idScheme === ID_SCHEME,
      movingTo: typeof native.movingTo === "string" && native.movingTo.length > 0 ? native.movingTo : undefined,
      label: labelOf(obj.common, rel),
    });
  }
  return trees;
}

/**
 * Move every device tree that does not carry the mark of the current id rule to its id under that
 * rule, and record every tree in the registry. Runs once per start, before anything else touches the
 * trees; a tree that already carries the mark costs one comparison.
 *
 * Order: trees with the mark are recorded first (their ids are taken), the targets of interrupted
 * moves next (the journal decides, the id must not change between two starts), then every other tree
 * gets its id from the registry — sorted by Govee's device id, so which of two devices that end in the
 * same four characters keeps the short id does not depend on the order of the object listing. A second
 * tree of a device whose tree is already in place (a leftover of an interrupted move) only fills in
 * what the kept tree lacks, and goes.
 *
 * @param deps object and state calls, the enum-carrying delete and the log
 * @param registry the registry every device's tree is recorded in
 * @returns how many trees moved
 */
export async function migrateDeviceIds(deps: IdMigrationDeps, registry: DeviceIdRegistry): Promise<number> {
  const trees = findTrees(deps.namespace, await deps.deviceObjects(), deps.log);
  const complete = new Set<string>();
  for (const tree of trees) {
    if (tree.marked && !tree.movingTo && registry.seed(tree.sku, tree.deviceId, tree.rel)) {
      complete.add(tree.rel);
    }
  }
  for (const tree of trees) {
    if (!tree.marked && tree.movingTo && tree.movingTo !== tree.rel) {
      registry.seed(tree.sku, tree.deviceId, tree.movingTo);
    }
  }
  const pending = trees
    .filter(tree => !complete.has(tree.rel))
    .sort((a, b) => idPiece(a.deviceId).localeCompare(idPiece(b.deviceId)) || a.rel.localeCompare(b.rel));
  let moved = 0;
  for (const tree of pending) {
    const target = registry.prefixFor(tree.sku, tree.deviceId);
    try {
      if (target === tree.rel) {
        // Already under its id, only the mark is missing (a tree written between two releases).
        await deps.extendObject(`${deps.namespace}.${tree.rel}`, { native: { idScheme: ID_SCHEME } });
        complete.add(target);
        continue;
      }
      await moveTree(deps, tree, target, complete.has(target));
      complete.add(target);
      moved++;
    } catch (e) {
      // The device stays where it is for this session, unmarked: its values keep flowing into the tree
      // its recordings belong to, and the next start tries again. Handing out the new id anyway built a
      // fresh tree there that the next start took as complete — and only filled around it, without the
      // recordings of what already stood there.
      registry.keepUnmoved(tree.sku, tree.deviceId, tree.rel);
      deps.log.warn(
        `Device "${tree.label}": could not move ${tree.rel} to ${target} — ${errMessage(e)}; it stays under its old id and is moved at the next start`,
      );
    }
  }
  return moved;
}

/**
 * Move one tree: journal, copy (objects, values, recordings, aliases), delete carrying the rooms and
 * functions, one log line.
 *
 * @param deps the calls
 * @param tree the tree that moves
 * @param target its new id (`devices.h61be-525f`)
 * @param fillOnly the target is already a complete tree — add only what it lacks
 */
async function moveTree(deps: IdMigrationDeps, tree: Tree, target: string, fillOnly: boolean): Promise<void> {
  const fromFull = `${deps.namespace}.${tree.rel}`;
  const toFull = `${deps.namespace}.${target}`;
  if (!fillOnly && tree.movingTo !== target) {
    await deps.extendObject(fromFull, { native: { movingTo: target } });
  }
  const report = await copyDeviceTree(deps, tree.rel, target, fillOnly);
  // Deepest first, the root (with its journal) last — an interruption leaves the journal in place.
  const oldIds = Object.keys(await deps.objects())
    .filter(id => movedId(id, fromFull, toFull) !== undefined)
    .sort((a, b) => b.split(".").length - a.split(".").length || b.localeCompare(a));
  report.enums = await deps.removeCarryingEnums(oldIds, id => {
    const next = movedId(id, fromFull, toFull);
    return next ? [next] : [];
  });
  if (fillOnly) {
    deps.log.info(`Device "${tree.label}": finished the interrupted move of ${tree.rel} to ${target}`);
    return;
  }
  const extras = [
    ...(report.enums > 0 ? [`${report.enums} room/function entr${report.enums === 1 ? "y" : "ies"}`] : []),
    ...(report.aliases > 0 ? [`${report.aliases} alias(es)`] : []),
  ];
  deps.log.info(
    `Device "${tree.label}": object ID is now ${target} (was ${tree.rel}) — moved ${report.datapoints} datapoint(s)${
      extras.length > 0 ? ` with ${extras.join(" and ")}` : ""
    }${report.history > 0 ? `; ${report.history} recording(s) keep their history` : ""}`,
  );
}
