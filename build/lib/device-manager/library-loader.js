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
var library_loader_exports = {};
__export(library_loader_exports, {
  loadDeviceLibraries: () => loadDeviceLibraries,
  loadDeviceScenes: () => loadDeviceScenes
});
module.exports = __toCommonJS(library_loader_exports);
var import_govee_constants = require("../govee-constants");
var import_http_client = require("../http-client");
var import_types = require("../types");
function logUndocApiFailure(log, sku, what, endpoint, hasBearer, e) {
  var _a;
  const httpStatus = (0, import_http_client.extractHttpStatus)(e);
  const msg = (0, import_types.errMessage)(e);
  const bodyMatch = msg.match(/body starts with: (.+)$/);
  const bodySnippet = (_a = bodyMatch == null ? void 0 : bodyMatch[1]) != null ? _a : "";
  const statusPart = httpStatus !== void 0 ? ` httpStatus=${httpStatus}` : "";
  const bodyPart = bodySnippet ? ` body="${bodySnippet}"` : ` error="${msg}"`;
  log.debug(
    `Could not load ${what} for ${sku}: endpoint=${endpoint}${statusPart} bearer=${hasBearer ? "yes" : "no"}${bodyPart}`
  );
}
async function loadDeviceScenes(host, device, cd) {
  var _a;
  host.diagnostics.addLog(cd.device, "debug", `loadDeviceScenes called for ${cd.sku}`);
  let scenesCallSucceeded = false;
  let snapsFromScenesCall = [];
  let diyFromScenesCall = [];
  const loadScenes = async () => {
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
      host.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/scenes", e, (0, import_http_client.extractHttpStatus)(e));
      host.log.debug(`Could not load scenes for ${(0, import_types.deviceLabel)(device)}: ${(0, import_types.errMessage)(e)}`);
    }
  };
  await host.runLimited(loadScenes);
  if (diyFromScenesCall.length === 0) {
    const loadDiy = async () => {
      try {
        const diy = await host.cloudClient.getDiyScenes(cd.sku, cd.device);
        if (diy.length > 0) {
          device.diyScenes = diy;
        }
      } catch (e) {
        host.diagnostics.recordApiFailure(cd.device, "/router/api/v1/device/diy-scenes", e, (0, import_http_client.extractHttpStatus)(e));
        host.log.debug(`Could not load DIY scenes for ${(0, import_types.deviceLabel)(device)}: ${(0, import_types.errMessage)(e)}`);
      }
    };
    await host.runLimited(loadDiy);
  }
  if (snapsFromScenesCall.length > 0) {
    device.snapshots = snapsFromScenesCall;
  } else if (scenesCallSucceeded) {
    const caps = Array.isArray(cd.capabilities) ? cd.capabilities : [];
    const snapCap = caps.find(
      (c) => {
        var _a2;
        return c && c.type === import_govee_constants.GOVEE_CAP_TYPE.DYNAMIC_SCENE && c.instance === "snapshot" && Array.isArray((_a2 = c.parameters) == null ? void 0 : _a2.options);
      }
    );
    if ((_a = snapCap == null ? void 0 : snapCap.parameters) == null ? void 0 : _a.options) {
      device.snapshots = snapCap.parameters.options.filter((o) => o && typeof o.name === "string" && o.value !== void 0 && o.value !== null).map((o) => ({
        name: o.name,
        value: typeof o.value === "number" ? o.value : o.value
      }));
      host.log.debug(`Snapshots from capabilities for ${(0, import_types.deviceLabel)(device)}: ${device.snapshots.length}`);
    }
  }
  return device.scenes.length > 0 || device.diyScenes.length > 0 || device.snapshots.length > 0;
}
async function loadLibrary(host, device, sku, hasBearer, cfg) {
  if (!(cfg.force || cfg.current.length === 0)) {
    return false;
  }
  let changed = false;
  await host.runLimited(async () => {
    try {
      const lib = await cfg.fetch();
      host.diagnostics.recordApiSuccess(device.deviceId, cfg.ep, lib);
      host.log.debug(
        `${cfg.label} for ${sku}: ${lib.length} ${cfg.noun}${lib.length === 0 ? " \u2014 empty (Govee returned no data for this SKU)" : ""}`
      );
      if (lib.length > 0) {
        cfg.assign(lib);
        changed = true;
      }
    } catch (e) {
      host.diagnostics.recordApiFailure(device.deviceId, cfg.ep, e, (0, import_http_client.extractHttpStatus)(e));
      logUndocApiFailure(host.log, sku, cfg.failLabel, cfg.ep, hasBearer, e);
    }
  });
  return changed;
}
async function loadDeviceLibraries(host, device, sku, force = false) {
  if (!host.apiClient) {
    return false;
  }
  const apiClient = host.apiClient;
  host.diagnostics.addLog(device.deviceId, "debug", `loadDeviceLibraries called for ${sku} (force=${force})`);
  let changed = false;
  const hasBearer = apiClient.hasBearerToken();
  if (await loadLibrary(host, device, sku, hasBearer, {
    force,
    current: device.sceneLibrary,
    ep: `/light-effect-libraries?sku=${sku}`,
    label: "Scene library",
    noun: "scene(s)",
    failLabel: "scene library",
    fetch: () => apiClient.fetchSceneLibrary(sku),
    assign: (lib) => {
      device.sceneLibrary = lib;
    }
  })) {
    changed = true;
  }
  if (await loadLibrary(host, device, sku, hasBearer, {
    force,
    current: device.musicLibrary,
    ep: `/light-effect-libraries-music?sku=${sku}`,
    label: "Music library",
    noun: "mode(s)",
    failLabel: "music library",
    fetch: () => apiClient.fetchMusicLibrary(sku),
    assign: (lib) => {
      device.musicLibrary = lib;
    }
  })) {
    changed = true;
  }
  if (await loadLibrary(host, device, sku, hasBearer, {
    force,
    current: device.diyLibrary,
    ep: `/diy-effect-libraries?sku=${sku}`,
    label: "DIY library",
    noun: "effect(s)",
    failLabel: "DIY library",
    fetch: () => apiClient.fetchDiyLibrary(sku),
    assign: (lib) => {
      device.diyLibrary = lib;
    }
  })) {
    changed = true;
  }
  if (force || !device.skuFeatures) {
    await host.runLimited(async () => {
      const ep = `/sku-features?sku=${sku}`;
      try {
        const features = await apiClient.fetchSkuFeatures(sku);
        host.diagnostics.recordApiSuccess(device.deviceId, ep, features);
        if (features) {
          device.skuFeatures = features;
          changed = true;
          host.log.debug(`SKU features for ${sku}: ${JSON.stringify(features).slice(0, 200)}`);
        } else {
          host.log.debug(`SKU features for ${sku}: null \u2014 Govee returned no data for this SKU`);
        }
      } catch (e) {
        host.diagnostics.recordApiFailure(device.deviceId, ep, e, (0, import_http_client.extractHttpStatus)(e));
        logUndocApiFailure(host.log, sku, "SKU features", ep, hasBearer, e);
      }
    });
  }
  if ((force || !device.snapshotBleCmds) && device.snapshots.length > 0) {
    await host.runLimited(async () => {
      const ep = `/bff-app/v1/devices/snapshots?sku=${sku}`;
      try {
        const snaps = await apiClient.fetchSnapshots(sku, device.deviceId);
        host.diagnostics.recordApiSuccess(device.deviceId, ep, snaps);
        host.log.debug(
          `Snapshot BLE for ${sku}: ${snaps.length} snapshot(s) with local data${snaps.length === 0 ? " \u2014 Govee returned no BLE-cmds for this SKU/device" : ""}`
        );
        if (snaps.length > 0) {
          device.snapshotBleCmds = device.snapshots.map((ds) => {
            var _a;
            const match = snaps.find((s) => s.name === ds.name);
            return (_a = match == null ? void 0 : match.bleCmds) != null ? _a : [];
          });
          changed = true;
        }
      } catch (e) {
        host.diagnostics.recordApiFailure(device.deviceId, ep, e, (0, import_http_client.extractHttpStatus)(e));
        logUndocApiFailure(host.log, sku, "snapshot BLE", ep, hasBearer, e);
      }
    });
  }
  return changed;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  loadDeviceLibraries,
  loadDeviceScenes
});
//# sourceMappingURL=library-loader.js.map
