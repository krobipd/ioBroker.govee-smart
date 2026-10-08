/**
 * Adapter surface required by the dropdown-reset helpers. Loose
 * `setState` shape for utils.Adapter structural matching.
 */
export interface GroupStateHelpersAdapter {
  /** The instance namespace, e.g. `govee-smart.0`. */
  readonly namespace: string;
  /** Read one own state. */
  getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
  /** Write one own state. */
  setState(id: string, state: ioBroker.SettableState | ioBroker.StateValue): Promise<unknown>;
}

/**
 * State-suffix → command-name lookup for writable states. Segment indices
 * are dynamic and handled by regex in {@link stateToCommand} — everything
 * else is a straight string mapping.
 */
export const STATE_TO_COMMAND: Readonly<Record<string, string>> = {
  "control.power": "power",
  "control.brightness": "brightness",
  "control.color_rgb": "colorRgb",
  "control.color_temperature": "colorTemperature",
  "control.scene": "scene",
  "control.gradient_toggle": "gradientToggle",
  "control.work_mode": "workMode",
  "control.mode_value": "workMode",
  "control.target_temperature": "targetTemperature",
  "control.auto_stop": "targetTemperature",
  "scenes.light_scene": "lightScene",
  "scenes.diy_scene": "diyScene",
  "scenes.scene_speed": "sceneSpeed",
  "music.music_mode": "music",
  "music.music_sensitivity": "music",
  "music.music_auto_color": "music",
  "snapshots.snapshot_cloud": "snapshot",
  "segments.command": "segmentBatch",
};

/** Dropdowns whose value is a mode-selection — reset to "---" (0) when the mode stops. */
export const MODE_DROPDOWNS: readonly string[] = [
  "scenes.light_scene",
  "scenes.diy_scene",
  "snapshots.snapshot_cloud",
  "snapshots.snapshot_local",
  "music.music_mode",
];

/** Map command → its own dropdown path (excluded from reset when that mode is the one that was just activated). */
export const COMMAND_DROPDOWN: Readonly<Record<string, string>> = {
  lightScene: "scenes.light_scene",
  diyScene: "scenes.diy_scene",
  snapshot: "snapshots.snapshot_cloud",
  snapshotLocal: "snapshots.snapshot_local",
  music: "music.music_mode",
  colorRgb: "",
  colorTemperature: "",
};

/**
 * Map state suffix to command name. Simple suffixes live in
 * {@link STATE_TO_COMMAND}; segment indices need regex extraction because
 * they're dynamic. The three music states all route to the same "music"
 * command — the handler reads sibling values.
 *
 * @param suffix State ID suffix (e.g. "power", "brightness")
 */
export function stateToCommand(suffix: string): string | null {
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

/**
 * What a written datapoint does to the mode dropdowns — the ONE rule for a device and a group (until 3.1.0 the
 * group reset only after a scene or music mode, so a group switched off or set to a colour kept showing its old
 * scene; audit DRY-4): power off resets every mode, a mode or a colour resets the other modes, the music
 * sensitivity and auto colour change no mode.
 *
 * @param adapter ioBroker adapter surface
 * @param prefix Device or group state prefix
 * @param stateSuffix The written datapoint (`control.power`, `scenes.light_scene`, …)
 * @param val The value that went out
 */
export async function resetAfterWrite(
  adapter: GroupStateHelpersAdapter,
  prefix: string,
  stateSuffix: string,
  val: ioBroker.StateValue,
): Promise<void> {
  const command = stateToCommand(stateSuffix);
  if (!command) {
    return;
  }
  if (command === "power" && val === false) {
    await resetModeDropdowns(adapter, prefix, "");
    return;
  }
  if (command === "music" && stateSuffix !== "music.music_mode") {
    return;
  }
  await resetRelatedDropdowns(adapter, prefix, command);
}

/**
 * Reset related dropdown states when switching between scenes/snapshots/colors.
 * Each mode-switch resets all OTHER mode dropdowns to "---" (0).
 *
 * @param adapter ioBroker adapter surface
 * @param prefix Device state prefix
 * @param activeCommand The command that was just executed
 */
export async function resetRelatedDropdowns(
  adapter: GroupStateHelpersAdapter,
  prefix: string,
  activeCommand: string,
): Promise<void> {
  if (!(activeCommand in COMMAND_DROPDOWN)) {
    return;
  }
  const ownDropdown = COMMAND_DROPDOWN[activeCommand];
  await resetModeDropdowns(adapter, prefix, ownDropdown);
}

/**
 * Reset every mode dropdown except `keep` (empty = reset all). Used both for
 * mode-switches (keep the new mode's own dropdown) and for power-off
 * (reset everything — a device that's off has no active mode).
 *
 * @param adapter ioBroker adapter surface
 * @param prefix Device state prefix
 * @param keep   Dropdown path to leave untouched (e.g. "music.music_mode"), or "" to reset all
 */
export async function resetModeDropdowns(
  adapter: GroupStateHelpersAdapter,
  prefix: string,
  keep: string,
): Promise<void> {
  await Promise.all(
    MODE_DROPDOWNS.filter(d => d !== keep).map(async dropdown => {
      const stateId = `${adapter.namespace}.${prefix}.${dropdown}`;
      const current = await adapter.getStateAsync(stateId);
      if (current?.val && current.val !== "0" && current.val !== 0) {
        await adapter.setState(stateId, { val: "0", ack: true });
      }
    }),
  );
}
