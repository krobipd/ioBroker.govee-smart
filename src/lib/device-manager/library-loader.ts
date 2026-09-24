import type { GoveeApiClient } from "../govee-api-client";
import type { GoveeCloudClient } from "../govee-cloud-client";
import type { DiagnosticsCollector } from "../diagnostics";
import { GOVEE_CAP_TYPE } from "../govee-constants";
import { extractHttpStatus } from "../http-client";
import { LIBRARY_RECHECK_MS } from "../timing-constants";
import { APP_API_LANE, limiterDeviceKey, type CallLane } from "../rate-limiter";
import {
  deviceLabel,
  errMessage,
  type CloudDevice,
  type CloudScene,
  type GoveeDevice,
  type NamedCapabilityOption,
} from "../types";

/**
 * Host surface for the scene/library loaders — the Cloud/App-API data
 * acquisition extracted from DeviceManager (M12). The orchestration
 * (loadFromCloud / refreshSceneDataForDevice, device map, scenesChecked,
 * cache persistence, error dedup) stays in DeviceManager; these functions
 * only fetch and mutate the passed device.
 *
 * `runLimited` encodes the budget semantics at ONE place in the host and
 * settles when the call actually RAN — queued or not (since 2.39.0; before,
 * fire-and-queue returned "no data this round" before a byte had arrived,
 * and an answer that landed minutes later reached neither cache nor tree,
 * issue #46). A call the limiter cancels is caught by the host, never by the
 * loaders: their `await host.runLimited(...)` is outside their own try/catch.
 * The keep-cache paths (e.g. the Issue-#13 three-way snapshot resolution)
 * still hold — the fetch closures assign only on a non-empty answer. The
 * orchestration keeps `loadFromCloud` from waiting on these calls by running
 * each light's load as a background job (DeviceManager.startSceneLoad).
 */
export interface LibraryLoaderHost {
  readonly cloudClient: GoveeCloudClient;
  readonly apiClient: GoveeApiClient | null;
  readonly log: ioBroker.Logger;
  readonly diagnostics: DiagnosticsCollector;
  runLimited(fn: () => Promise<void>, lane: CallLane): Promise<void>;
  /**
   * Per-run memo for the SKU-level fetches (scene/music/DIY library, SKU
   * features): the first device of a SKU fetches, every other device of that
   * SKU awaits the same outcome and gets the same data. Eight bulbs of one
   * SKU used to make the same four calls eight times per start. Absent = no
   * sharing (the manual refresh of one device).
   */
  readonly sharedFetches?: Map<string, Promise<SharedFetchOutcome<unknown>>>;
  /**
   * Tells the host that a fetch this device depends on never ran (the limiter
   * dropped it) — so the caller can tell "checked, empty" from "not checked".
   * The host's own runLimited notes that for the device that issued the call;
   * a device that merely shared the outcome needs this hook.
   */
  noteCancelled?(): void;
  /**
   * Tells the host that an account-token endpoint was not asked because no
   * bearer token was there yet — the libraries are then NOT checked, and the
   * first token loads them (M3). Without it an unasked endpoint counted as
   * "empty" for a week.
   */
  noteSkipped?(): void;
}

/** What a (possibly shared) fetch came back with. `ran: false` = the limiter never ran it. */
export interface SharedFetchOutcome<T> {
  ran: boolean;
  data: T | null;
  error?: unknown;
}

/**
 * Run one SKU-level fetch through the host's budget, shared per run when the
 * host carries a memo. The memoised promise never rejects: a failed fetch is
 * an outcome with `error`, so one failure cannot poison every device of the
 * SKU with a rejection — each keeps what it had, the next run fetches again.
 *
 * @param host Loader host
 * @param key Memo key — the endpoint including the SKU
 * @param fetch The API call
 */
async function sharedFetch<T>(
  host: LibraryLoaderHost,
  key: string,
  fetch: () => Promise<T>,
): Promise<SharedFetchOutcome<T>> {
  const memo = host.sharedFetches;
  const existing = memo?.get(key);
  if (existing) {
    return (await existing) as SharedFetchOutcome<T>;
  }
  const outcome = (async (): Promise<SharedFetchOutcome<T>> => {
    let result: SharedFetchOutcome<T> = { ran: false, data: null };
    await host.runLimited(async () => {
      try {
        result = { ran: true, data: await fetch() };
      } catch (e) {
        result = { ran: true, data: null, error: e };
      }
    }, APP_API_LANE);
    return result;
  })();
  memo?.set(key, outcome);
  return outcome;
}

/**
 * Whether an empty answer for this device's libraries is recent enough to
 * trust. Remembered WITH an expiry: the #13 trap was "once empty, empty
 * forever" — here Govee gets asked again after {@link LIBRARY_RECHECK_MS}.
 *
 * @param device The device
 * @param now Current time (ms)
 */
function recentlyCheckedEmpty(device: GoveeDevice, now: number): boolean {
  return typeof device.librariesCheckedAt === "number" && now - device.librariesCheckedAt < LIBRARY_RECHECK_MS;
}

/**
 * Structured debug-log for failed undocumented App-API calls. Pulls apart
 * the cryptic "Invalid JSON in HTTP 200 response — body starts with: <snippet>"
 * message into addressable fields so the user can read the actual facts:
 * endpoint URL, HTTP status, bearer-token presence, body snippet.
 * No interpretation — just the data.
 *
 * @param log Adapter logger
 * @param sku Govee SKU (for log context)
 * @param what Human-readable name of the data being loaded
 * @param endpoint Endpoint identifier for diagnostics history
 * @param hasBearer Whether a bearer token was attached to the request
 * @param e Caught error
 */
function logUndocApiFailure(
  log: ioBroker.Logger,
  sku: string,
  what: string,
  endpoint: string,
  hasBearer: boolean,
  e: unknown,
): void {
  const httpStatus = extractHttpStatus(e);
  const msg = errMessage(e);
  // http-client formats invalid-JSON-200 errors as "...body starts with: <snippet>"
  const bodyMatch = msg.match(/body starts with: (.+)$/);
  const bodySnippet = bodyMatch?.[1] ?? "";
  const statusPart = httpStatus !== undefined ? ` httpStatus=${httpStatus}` : "";
  const bodyPart = bodySnippet ? ` body="${bodySnippet}"` : ` error="${msg}"`;
  log.debug(
    `Could not load ${what} for ${sku}: endpoint=${endpoint}${statusPart} bearer=${hasBearer ? "yes" : "no"}${bodyPart}`,
  );
}

/**
 * Load scenes, DIY scenes, and snapshots for a device from the Cloud API.
 *
 * @param host Loader host (clients, logger, diagnostics, budget runner)
 * @param device Target device to populate
 * @param cd Cloud device data with capabilities
 * @returns true if the device ended up with any scene/snapshot data
 */
export async function loadDeviceScenes(
  host: LibraryLoaderHost,
  device: GoveeDevice,
  cd: CloudDevice,
): Promise<boolean> {
  host.diagnostics.addLog(cd.device, "debug", `loadDeviceScenes called for ${cd.sku}`);
  // Scenes from dedicated scenes endpoint (rate-limited).
  //
  // lightScene + diyScene: per-list guard against transient empties. Govee's
  // /device/scenes sometimes returns 149 lightScenes + 0 snapshots (or vice
  // versa) on back-to-back calls. One guard per list keeps the last-known-good
  // data in place for those types.
  //
  // snapshot: handled separately AFTER this block (see below). A per-list
  // guard alone froze the cached snapshot list forever once it was populated —
  // user content (snapshots created in the Govee Home app) never surfaced
  // (Issue #13, tukey42, v2.6.7).
  let scenesCallSucceeded = false;
  let snapsFromScenesCall: CloudScene[] = [];
  let diyFromScenesCall: CloudScene[] = [];
  const loadScenes = async (): Promise<void> => {
    try {
      const { lightScenes, diyScenes, snapshots } = await host.cloudClient.getScenes(cd.sku, cd.device);
      scenesCallSucceeded = true;
      snapsFromScenesCall = snapshots;
      diyFromScenesCall = diyScenes;
      if (lightScenes.length > 0) {
        device.scenes = lightScenes;
      }
      if (diyScenes.length > 0) {
        device.diyScenes = diyScenes;
      }
    } catch (e) {
      host.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/scenes", e, extractHttpStatus(e));
      host.log.debug(`Could not load scenes for ${deviceLabel(device)}: ${errMessage(e)}`);
    }
  };
  await host.runLimited(loadScenes, { kind: "device-read", deviceKey: limiterDeviceKey(device) });

  // DIY scenes from the dedicated endpoint. Gate on whether THIS /device/scenes
  // call carried DIY scenes — NOT on an empty cache. The old `diyScenes.length
  // === 0` gate froze the list after the first population, so DIY scenes the
  // user created in the app later never surfaced (Pattern 54, same class as the
  // snapshot bug below). getDiyScenes only overwrites on a non-empty result, so
  // a transient empty keeps the cache.
  if (diyFromScenesCall.length === 0) {
    const loadDiy = async (): Promise<void> => {
      try {
        const diy = await host.cloudClient.getDiyScenes(cd.sku, cd.device);
        if (diy.length > 0) {
          device.diyScenes = diy;
        }
      } catch (e) {
        host.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/diy-scenes", e, extractHttpStatus(e));
        host.log.debug(`Could not load DIY scenes for ${deviceLabel(device)}: ${errMessage(e)}`);
      }
    };
    await host.runLimited(loadDiy, { kind: "device-read", deviceKey: limiterDeviceKey(device) });
  }

  // Snapshots — three-way resolution:
  //   1. /device/scenes returned non-empty snapshots → trust that list.
  //   2. /device/scenes succeeded but returned empty → fall back to the
  //      `snapshot` capability inside /user/devices (cd.capabilities).
  //      This is the fix path for newly-created snapshots: /device/scenes
  //      lags or omits them for some SKUs, but /user/devices carries them.
  //      Empty capability options here is a legitimate "user deleted all
  //      snapshots in the app" — we reflect that and clear the list.
  //   3. /device/scenes threw OR no snapshot capability exists at all →
  //      keep device.snapshots untouched (cache survives transient Cloud
  //      outages and devices that simply don't expose the capability).
  if (snapsFromScenesCall.length > 0) {
    device.snapshots = snapsFromScenesCall;
  } else if (scenesCallSucceeded) {
    const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
    const snapCap = caps.find(
      c =>
        c &&
        c.type === GOVEE_CAP_TYPE.DYNAMIC_SCENE &&
        c.instance === "snapshot" &&
        Array.isArray(c.parameters?.options),
    );
    if (snapCap?.parameters?.options) {
      device.snapshots = snapCap.parameters.options
        .filter(
          (o): o is NamedCapabilityOption =>
            !!o && typeof o.name === "string" && o.value !== undefined && o.value !== null,
        )
        .map(o => ({
          name: o.name,
          value: typeof o.value === "number" ? o.value : (o.value as Record<string, unknown>),
        }));
      host.log.debug(`Snapshots from capabilities for ${deviceLabel(device)}: ${device.snapshots.length}`);
    }
  }

  // "Changed" = we ended up with any scene/snapshot data.
  return device.scenes.length > 0 || device.diyScenes.length > 0 || device.snapshots.length > 0;
}

/**
 * Fetch one undocumented-API library (scene / music / DIY) into its device
 * field, rate-limited. Only fetches when forced or the field is still empty;
 * records the raw array in the diag buffer (incl. scenceParam Base64 + config
 * JSON) so a byte-level "why won't this activate on SKU X?" diagnosis works
 * from the diag JSON alone. Returns true if the device changed.
 *
 * @param host Loader host
 * @param device Target device
 * @param sku Product model (for the endpoint + log line)
 * @param hasBearer Whether a bearer token is present (for the failure log)
 * @param cfg Per-library specifics — force flag, current field, endpoint,
 *   labels, and the fetch + assign closures
 * @param cfg.force Refetch even when the field already holds data
 * @param cfg.current The device field being populated — skipped when non-empty unless forced
 * @param cfg.recentlyChecked An empty field was confirmed empty recently — skipped unless forced
 * @param cfg.ep API endpoint path, recorded in the diag buffer and failure log
 * @param cfg.label Human-readable library name for the debug count line
 * @param cfg.noun Plural noun for the count line (e.g. "scenes")
 * @param cfg.failLabel Library label passed to the undocumented-API failure log
 * @param cfg.fetch Closure that performs the actual API fetch
 * @param cfg.assign Closure that stores the fetched array on the device
 * @param cfg.needsBearer The endpoint runs on the account token — without one it is not asked (M3)
 */
async function loadLibrary<T>(
  host: LibraryLoaderHost,
  device: GoveeDevice,
  sku: string,
  hasBearer: boolean,
  cfg: {
    force: boolean;
    current: T[];
    recentlyChecked: boolean;
    ep: string;
    label: string;
    noun: string;
    failLabel: string;
    fetch: () => Promise<T[]>;
    assign: (lib: T[]) => void;
    /** The endpoint runs on the account token — without one it is not asked. */
    needsBearer: boolean;
  },
): Promise<boolean> {
  if (!cfg.force && (cfg.current.length > 0 || cfg.recentlyChecked)) {
    return false;
  }
  if (cfg.needsBearer && !hasBearer) {
    host.noteSkipped?.();
    return false;
  }
  const outcome = await sharedFetch(host, cfg.ep, cfg.fetch);
  if (!outcome.ran) {
    host.noteCancelled?.();
    return false;
  }
  if (outcome.error !== undefined || outcome.data === null) {
    host.diagnostics.recordApiFailure(device.deviceId, cfg.ep, outcome.error, extractHttpStatus(outcome.error));
    logUndocApiFailure(host.log, sku, cfg.failLabel, cfg.ep, hasBearer, outcome.error);
    return false;
  }
  const lib = outcome.data;
  host.diagnostics.recordApiSuccess(device.deviceId, cfg.ep, lib);
  host.log.debug(
    `${cfg.label} for ${sku}: ${lib.length} ${cfg.noun}${lib.length === 0 ? " — empty (Govee returned no data for this SKU)" : ""}`,
  );
  if (lib.length > 0) {
    cfg.assign(lib);
    return true;
  }
  return false;
}

/**
 * Whether the stored snapshot packets belong to exactly the snapshots the
 * device has now — same names, same order.
 *
 * @param device The light
 */
export function snapshotPacketsMatch(device: GoveeDevice): boolean {
  const packets = device.snapshotBleCmds;
  if (!packets || packets.length !== device.snapshots.length) {
    return false;
  }
  return device.snapshots.every((s, i) => packets[i].name === s.name);
}

/**
 * Load scene/music/DIY libraries and SKU features from the undocumented API.
 *
 * Each fetch runs through the rate-limiter so a fresh install with 10
 * devices doesn't slam app2.govee.com with 40 back-to-back requests —
 * those endpoints are undocumented and aggressive callers can get the
 * account temporarily locked.
 *
 * @param host Loader host
 * @param device Target device to populate
 * @param sku Product model
 * @param force When true, refetch every endpoint regardless of cache —
 *   used by the user-triggered refresh button so a stale library
 *   actually gets replaced
 * @param now Current time (ms) — the empty-answer memory expires against it
 * @returns true if any library data changed
 */
export async function loadDeviceLibraries(
  host: LibraryLoaderHost,
  device: GoveeDevice,
  sku: string,
  force = false,
  now: number = Date.now(),
): Promise<boolean> {
  if (!host.apiClient) {
    return false;
  }
  const apiClient = host.apiClient;

  host.diagnostics.addLog(device.deviceId, "debug", `loadDeviceLibraries called for ${sku} (force=${force})`);
  let changed = false;

  const hasBearer = apiClient.hasBearerToken();
  const recentlyChecked = recentlyCheckedEmpty(device, now);

  if (
    await loadLibrary(host, device, sku, hasBearer, {
      force,
      current: device.sceneLibrary,
      recentlyChecked,
      ep: `/light-effect-libraries?sku=${sku}`,
      label: "Scene library",
      noun: "scene(s)",
      failLabel: "scene library",
      fetch: () => apiClient.fetchSceneLibrary(sku),
      assign: lib => {
        device.sceneLibrary = lib;
      },
      needsBearer: false,
    })
  ) {
    changed = true;
  }

  if (
    await loadLibrary(host, device, sku, hasBearer, {
      force,
      current: device.musicLibrary,
      recentlyChecked,
      ep: `/light-effect-libraries-music?sku=${sku}`,
      label: "Music library",
      noun: "mode(s)",
      failLabel: "music library",
      fetch: () => apiClient.fetchMusicLibrary(sku),
      assign: lib => {
        device.musicLibrary = lib;
      },
      needsBearer: true,
    })
  ) {
    changed = true;
  }

  if (
    await loadLibrary(host, device, sku, hasBearer, {
      force,
      current: device.diyLibrary,
      recentlyChecked,
      ep: `/diy-effect-libraries?sku=${sku}`,
      label: "DIY library",
      noun: "effect(s)",
      failLabel: "DIY library",
      fetch: () => apiClient.fetchDiyLibrary(sku),
      assign: lib => {
        device.diyLibrary = lib;
      },
      needsBearer: true,
    })
  ) {
    changed = true;
  }

  if ((force || (!device.skuFeatures && !recentlyChecked)) && !hasBearer) {
    host.noteSkipped?.();
  } else if (force || (!device.skuFeatures && !recentlyChecked)) {
    const ep = `/sku-features?sku=${sku}`;
    const outcome = await sharedFetch(host, ep, () => apiClient.fetchSkuFeatures(sku));
    if (!outcome.ran) {
      host.noteCancelled?.();
    } else if (outcome.error !== undefined) {
      host.diagnostics.recordApiFailure(device.deviceId, ep, outcome.error, extractHttpStatus(outcome.error));
      logUndocApiFailure(host.log, sku, "SKU features", ep, hasBearer, outcome.error);
    } else {
      const features = outcome.data;
      host.diagnostics.recordApiSuccess(device.deviceId, ep, features);
      if (features) {
        device.skuFeatures = features;
        changed = true;
        host.log.debug(`SKU features for ${sku}: ${JSON.stringify(features).slice(0, 200)}`);
      } else {
        host.log.debug(`SKU features for ${sku}: null — Govee returned no data for this SKU`);
      }
    }
  }

  // Load snapshot BLE commands for local activation.
  // `force` honoured so refresh_cloud also clears stale BLE-Cmds when the
  // user re-creates a snapshot in the Govee app and re-imports it. Without
  // the force-branch the gate was sticky — cached snapshot packets stayed
  // until the cache file was manually deleted (Issue #13 v2.8.2, tukey42).
  // Fetched anew when the name list changed (a snapshot added, renamed or
  // removed in the app), not only when none are stored (N33).
  const packetsStale = force || !snapshotPacketsMatch(device);
  if (packetsStale && device.snapshots.length > 0 && !hasBearer) {
    host.noteSkipped?.();
  } else if (packetsStale && device.snapshots.length > 0) {
    await host.runLimited(async () => {
      const ep = `/bff-app/v1/devices/snapshots?sku=${sku}`;
      try {
        const snaps = await apiClient.fetchSnapshots(sku, device.deviceId);
        // v2.9.1 — record the full bleCmds payload (per-snapshot Base64
        // packet groups). Was completely absent from apiHistory in v2.9.0;
        // Issue #13 H61A8 byte-level analysis couldn't proceed without it.
        host.diagnostics.recordApiSuccess(device.deviceId, ep, snaps);
        host.log.debug(
          `Snapshot BLE for ${sku}: ${snaps.length} snapshot(s) with local data${snaps.length === 0 ? " — Govee returned no BLE-cmds for this SKU/device" : ""}`,
        );
        if (snaps.length > 0) {
          device.snapshotBleCmds = device.snapshots.map(ds => ({
            name: ds.name,
            cmds: snaps.find(s => s.name === ds.name)?.bleCmds ?? [],
          }));
          changed = true;
        }
      } catch (e) {
        host.diagnostics.recordApiFailure(device.deviceId, ep, e, extractHttpStatus(e));
        logUndocApiFailure(host.log, sku, "snapshot BLE", ep, hasBearer, e);
      }
    }, APP_API_LANE);
  }

  return changed;
}
