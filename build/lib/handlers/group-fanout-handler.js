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
var group_fanout_handler_exports = {};
__export(group_fanout_handler_exports, {
  buildGroupFanoutHost: () => buildGroupFanoutHost,
  resolveGroupMembers: () => import_group_fanout.resolveGroupMembers,
  updateGroupReachability: () => updateGroupReachability
});
module.exports = __toCommonJS(group_fanout_handler_exports);
var import_group_fanout = require("../group-fanout");
var import_types = require("../types");
function updateGroupReachability(adapter) {
  if (!adapter.deviceManager || !adapter.stateManager) {
    return 0;
  }
  const devices = adapter.deviceManager.getDevices();
  let written = 0;
  for (const group of devices) {
    if (group.sku !== "BaseGroup" || !group.groupMembers) {
      continue;
    }
    const memberDevices = (0, import_group_fanout.resolveGroupMembers)(group, devices);
    adapter.stateManager.updateGroupMembersUnreachable(group, memberDevices).catch((0, import_types.logRejected)(adapter.log, "write group members unreachable"));
    written++;
  }
  return written;
}
function buildGroupFanoutHost(adapter) {
  return {
    log: adapter.log,
    namespace: adapter.namespace,
    getDevices: () => {
      var _a, _b;
      return (_b = (_a = adapter.deviceManager) == null ? void 0 : _a.getDevices()) != null ? _b : [];
    },
    sendCommand: async (device, command, value) => {
      var _a;
      await ((_a = adapter.deviceManager) == null ? void 0 : _a.sendCommand(device, command, value));
    },
    devicePrefix: (device) => {
      var _a, _b;
      return (_b = (_a = adapter.stateManager) == null ? void 0 : _a.devicePrefix(device)) != null ? _b : "";
    },
    stateToCommand: (suffix) => {
      var _a;
      return (_a = adapter.stateToCommand(suffix)) != null ? _a : void 0;
    },
    getObject: (id) => adapter.getObjectAsync(id),
    sendMusicCommand: (device, devicePrefix, stateSuffix, value) => adapter.sendMusicCommand(device, devicePrefix, stateSuffix, value)
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildGroupFanoutHost,
  resolveGroupMembers,
  updateGroupReachability
});
//# sourceMappingURL=group-fanout-handler.js.map
