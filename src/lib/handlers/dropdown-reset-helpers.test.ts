import {
  COMMAND_DROPDOWN,
  MODE_DROPDOWNS,
  STATE_TO_COMMAND,
  resetModeDropdowns,
  resetRelatedDropdowns,
  stateToCommand,
  type GroupStateHelpersAdapter,
} from "./dropdown-reset-helpers";

function makeAdapter(initial: Record<string, ioBroker.StateValue> = {}): {
  adapter: GroupStateHelpersAdapter;
  states: Map<string, ioBroker.StateValue>;
  writes: Array<{ id: string; val: ioBroker.StateValue }>;
} {
  const states = new Map<string, ioBroker.StateValue>(Object.entries(initial));
  const writes: Array<{ id: string; val: ioBroker.StateValue }> = [];
  return {
    states,
    writes,
    adapter: {
      namespace: "govee-smart.0",
      getStateAsync: async id => (states.has(id) ? ({ val: states.get(id), ack: true } as ioBroker.State) : null),
      setStateAsync: async (id, state) => {
        const val = (state as { val: ioBroker.StateValue }).val;
        states.set(id, val);
        writes.push({ id, val });
      },
    },
  };
}

const PREFIX = "devices.h6160_0011";
const id = (dropdown: string): string => `govee-smart.0.${PREFIX}.${dropdown}`;

describe("stateToCommand", () => {
  it("extracts dynamic segment-index commands via regex (not in the static table)", () => {
    expect(stateToCommand("segments.3.color")).toBe("segmentColor:3");
    expect(stateToCommand("segments.12.brightness")).toBe("segmentBrightness:12");
  });

  it("does NOT match non-numeric or nested segment paths", () => {
    expect(stateToCommand("segments.abc.color")).toBeNull();
    expect(stateToCommand("segments.3.color.extra")).toBeNull();
    expect(stateToCommand("segments.command.color")).toBeNull();
  });

  it("returns null for unmapped suffixes so the generic-capability path takes over", () => {
    expect(stateToCommand("control.unknown_toggle")).toBeNull();
    expect(stateToCommand("info.online")).toBeNull();
  });

  it("routes all three music states to the one shared 'music' command (handler reads siblings)", () => {
    expect(stateToCommand("music.music_mode")).toBe("music");
    expect(stateToCommand("music.music_sensitivity")).toBe("music");
    expect(stateToCommand("music.music_auto_color")).toBe("music");
  });

  it("maps the snake_case colour state ids to their (camelCase) command tokens (B2 write path)", () => {
    // The user writes the renamed control.color_rgb / control.color_temperature
    // states; the internal command token stays camelCase (it mirrors the cloud
    // capability instance it targets). This is the guarantee the rename didn't
    // orphan the control path.
    expect(stateToCommand("control.color_rgb")).toBe("colorRgb");
    expect(stateToCommand("control.color_temperature")).toBe("colorTemperature");
    // The old camelCase suffixes no longer resolve (hard-cut).
    expect(stateToCommand("control.colorRgb")).toBeNull();
    expect(stateToCommand("control.colorTemperature")).toBeNull();
  });
});

describe("table invariants", () => {
  it("every MODE_DROPDOWN that is writable has a STATE_TO_COMMAND route (except local-only snapshot_local)", () => {
    // snapshot_local is handled by a dedicated branch in onStateChange (the
    // local snapshot store), not via STATE_TO_COMMAND — everything else in
    // MODE_DROPDOWNS must be routable or a user write would dead-end.
    for (const dropdown of MODE_DROPDOWNS) {
      if (dropdown === "snapshots.snapshot_local") {
        continue;
      }
      expect(STATE_TO_COMMAND[dropdown], `${dropdown} must have a command route`).toBeDefined();
    }
  });

  it("every non-empty COMMAND_DROPDOWN target is a known MODE_DROPDOWN (reset would silently no-op otherwise)", () => {
    for (const [command, dropdown] of Object.entries(COMMAND_DROPDOWN)) {
      if (dropdown === "") {
        continue; // colorRgb/colorTemperature reset ALL dropdowns by design
      }
      expect(MODE_DROPDOWNS, `${command} → ${dropdown}`).toContain(dropdown);
    }
  });
});

describe("resetModeDropdowns", () => {
  it("resets every active dropdown except `keep` to '0'", async () => {
    const { adapter, states } = makeAdapter({
      [id("scenes.light_scene")]: "2",
      [id("scenes.diy_scene")]: "1",
      [id("music.music_mode")]: "5",
    });
    await resetModeDropdowns(adapter, PREFIX, "music.music_mode");
    expect(states.get(id("scenes.light_scene"))).toBe("0");
    expect(states.get(id("scenes.diy_scene"))).toBe("0");
    expect(states.get(id("music.music_mode"))).toBe("5"); // kept
  });

  it("keep='' resets everything (power-off semantics: an off device has no active mode)", async () => {
    const { adapter, states } = makeAdapter({
      [id("scenes.light_scene")]: "2",
      [id("music.music_mode")]: "5",
      [id("snapshots.snapshot_cloud")]: "1",
    });
    await resetModeDropdowns(adapter, PREFIX, "");
    expect(states.get(id("scenes.light_scene"))).toBe("0");
    expect(states.get(id("music.music_mode"))).toBe("0");
    expect(states.get(id("snapshots.snapshot_cloud"))).toBe("0");
  });

  it("does not write dropdowns that are already reset (0/'0'/empty) — no ack churn", async () => {
    const { adapter, writes } = makeAdapter({
      [id("scenes.light_scene")]: "0",
      [id("scenes.diy_scene")]: 0,
      [id("music.music_mode")]: "",
    });
    await resetModeDropdowns(adapter, PREFIX, "");
    expect(writes).toHaveLength(0);
  });

  it("tolerates missing dropdown states (device without music/snapshots)", async () => {
    const { adapter, writes } = makeAdapter({});
    await resetModeDropdowns(adapter, PREFIX, "");
    expect(writes).toHaveLength(0);
  });
});

describe("resetRelatedDropdowns", () => {
  it("resets the OTHER mode dropdowns but keeps the command's own", async () => {
    const { adapter, states } = makeAdapter({
      [id("scenes.light_scene")]: "3",
      [id("snapshots.snapshot_cloud")]: "2",
    });
    await resetRelatedDropdowns(adapter, PREFIX, "lightScene");
    expect(states.get(id("scenes.light_scene"))).toBe("3"); // the activated mode survives
    expect(states.get(id("snapshots.snapshot_cloud"))).toBe("0");
  });

  it("colorRgb resets ALL mode dropdowns (static color ends any scene/music mode)", async () => {
    const { adapter, states } = makeAdapter({
      [id("scenes.light_scene")]: "3",
      [id("music.music_mode")]: "1",
    });
    await resetRelatedDropdowns(adapter, PREFIX, "colorRgb");
    expect(states.get(id("scenes.light_scene"))).toBe("0");
    expect(states.get(id("music.music_mode"))).toBe("0");
  });

  it("is a no-op for commands without a dropdown mapping (power, brightness, segment ops)", async () => {
    const { adapter, writes } = makeAdapter({ [id("scenes.light_scene")]: "3" });
    await resetRelatedDropdowns(adapter, PREFIX, "brightness");
    await resetRelatedDropdowns(adapter, PREFIX, "segmentColor:3");
    expect(writes).toHaveLength(0);
  });
});
