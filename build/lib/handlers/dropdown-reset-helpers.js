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
var dropdown_reset_helpers_exports = {};
__export(dropdown_reset_helpers_exports, {
  COMMAND_DROPDOWN: () => COMMAND_DROPDOWN,
  MODE_DROPDOWNS: () => MODE_DROPDOWNS,
  STATE_TO_COMMAND: () => STATE_TO_COMMAND,
  resetModeDropdowns: () => resetModeDropdowns,
  resetRelatedDropdowns: () => resetRelatedDropdowns,
  stateToCommand: () => stateToCommand
});
module.exports = __toCommonJS(dropdown_reset_helpers_exports);
const STATE_TO_COMMAND = {
  "control.power": "power",
  "control.brightness": "brightness",
  "control.color_rgb": "colorRgb",
  "control.color_temperature": "colorTemperature",
  "control.scene": "scene",
  "control.gradient_toggle": "gradientToggle",
  "scenes.light_scene": "lightScene",
  "scenes.diy_scene": "diyScene",
  "scenes.scene_speed": "sceneSpeed",
  "music.music_mode": "music",
  "music.music_sensitivity": "music",
  "music.music_auto_color": "music",
  "snapshots.snapshot_cloud": "snapshot",
  "segments.command": "segmentBatch"
};
const MODE_DROPDOWNS = [
  "scenes.light_scene",
  "scenes.diy_scene",
  "snapshots.snapshot_cloud",
  "snapshots.snapshot_local",
  "music.music_mode"
];
const COMMAND_DROPDOWN = {
  lightScene: "scenes.light_scene",
  diyScene: "scenes.diy_scene",
  snapshot: "snapshots.snapshot_cloud",
  snapshotLocal: "snapshots.snapshot_local",
  music: "music.music_mode",
  colorRgb: "",
  colorTemperature: ""
};
function stateToCommand(suffix) {
  const direct = STATE_TO_COMMAND[suffix];
  if (direct) {
    return direct;
  }
  const segColorMatch = /^segments\.(\d+)\.color$/.exec(suffix);
  if (segColorMatch) {
    return `segmentColor:${segColorMatch[1]}`;
  }
  const segBrightMatch = /^segments\.(\d+)\.brightness$/.exec(suffix);
  if (segBrightMatch) {
    return `segmentBrightness:${segBrightMatch[1]}`;
  }
  return null;
}
async function resetRelatedDropdowns(adapter, prefix, activeCommand) {
  if (!(activeCommand in COMMAND_DROPDOWN)) {
    return;
  }
  const ownDropdown = COMMAND_DROPDOWN[activeCommand];
  await resetModeDropdowns(adapter, prefix, ownDropdown);
}
async function resetModeDropdowns(adapter, prefix, keep) {
  await Promise.all(
    MODE_DROPDOWNS.filter((d) => d !== keep).map(async (dropdown) => {
      const stateId = `${adapter.namespace}.${prefix}.${dropdown}`;
      const current = await adapter.getStateAsync(stateId);
      if ((current == null ? void 0 : current.val) && current.val !== "0" && current.val !== 0) {
        await adapter.setState(stateId, { val: "0", ack: true });
      }
    })
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMAND_DROPDOWN,
  MODE_DROPDOWNS,
  STATE_TO_COMMAND,
  resetModeDropdowns,
  resetRelatedDropdowns,
  stateToCommand
});
//# sourceMappingURL=dropdown-reset-helpers.js.map
