import { SEGMENT_HARD_MAX } from "./device-manager.js";
import type { GoveeDevice } from "./types.js";

/** Session state for the interactive segment-detection wizard */
export interface SegmentWizardSession {
  /** Target device key (sku:deviceId) */
  deviceKey: string;
  /** Device SKU for display */
  sku: string;
  /** Display name */
  name: string;
  /** Next segment index the wizard will flash */
  current: number;
  /** Upper bound — protocol limit, NOT Cloud-reported count */
  total: number;
  /** Indices confirmed visible by user */
  visible: number[];
  /** Timestamp of session start (for idle-timeout) */
  startedAt: number;
  /** Baseline snapshot for restore on abort/finish */
  baseline: {
    power?: boolean;
    brightness?: number;
    colorRgb?: string;
    segmentColors: { idx: number; color: string; brightness: number }[];
  };
}

/** Minimum response shape — onMessage forwards this verbatim to the caller. */
export type WizardResponse = Record<string, unknown>;

/** Result of a completed wizard session — the host applies this to the device. */
export interface WizardResult {
  /** Real physical segment count (indices the user acknowledged, one past the last answered) */
  segmentCount: number;
  /** Gaps detected (indices marked dark between visible ones). Empty = contiguous strip. */
  manualList: string;
  /** Whether gaps were detected (manualList non-empty) */
  hasGaps: boolean;
}

/**
 * Everything the wizard needs from the outside world. Extracting this
 * interface keeps the wizard independent from the ioBroker base class and
 * makes the state machine testable without instantiating a full adapter.
 */
export interface WizardHost {
  /** Host logger (maps to `adapter.log`). */
  log: {
    debug(m: string): void;
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
  };
  /** Read a state value by full ID. */
  getState(id: string): Promise<{ val: unknown } | null | undefined>;
  /** Dispatch a command to a device (normally DeviceManager.sendCommand). */
  sendCommand(
    device: GoveeDevice,
    command: string,
    value: unknown,
  ): Promise<void>;
  /**
   * Flash one segment bright white and dim all others — atomically, in a
   * single ptReal datagram. Required because separate UDP sends get dropped
   * by the Govee device under ~50 ms of back-pressure. Returns `true` if
   * the atomic path was used (LAN available), `false` if host fell back to
   * sendCommand (Cloud or no LAN).
   */
  flashSegmentAtomic(
    device: GoveeDevice,
    total: number,
    idx: number,
  ): Promise<boolean>;
  /**
   * Restore the whole strip to a uniform color + brightness atomically.
   * Returns `true` if LAN atomic path was used.
   */
  restoreStripAtomic(
    device: GoveeDevice,
    total: number,
    color: number,
    brightness: number,
  ): Promise<boolean>;
  /** Look up a device by its wizard-session key. */
  findDevice(key: string): GoveeDevice | undefined;
  /** Adapter namespace (e.g. "govee-smart.0"). */
  namespace: string;
  /** Derive the device's state-tree prefix (channel path below namespace). */
  devicePrefix(device: GoveeDevice): string;
  /** Schedule a managed timeout; must be cancellable via clearTimeout. */
  setTimeout(cb: () => void, ms: number): unknown;
  /** Cancel a previously scheduled timeout. */
  clearTimeout(handle: unknown): void;
  /**
   * Apply the finished wizard result to the device — sets segmentCount,
   * manualMode, manualSegments, rebuilds state tree, persists to cache.
   * Host owns this because it needs to coordinate with StateManager,
   * DeviceManager and SkuCache.
   */
  applyWizardResult(device: GoveeDevice, result: WizardResult): Promise<void>;
}

const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Status text shown when no wizard session is active. */
export const WIZARD_IDLE_TEXT =
  "Kein Wizard aktiv. Wähle oben einen LED-Strip und klicke ▶ Start.";

/**
 * Check whether a device has any segment capability at all. A strip with
 * zero segments (e.g. Curtain H70B3) can't be wizard-tested.
 *
 * @param device Target device
 */
function hasSegmentCapability(device: GoveeDevice): boolean {
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  return caps.some(
    (c) =>
      c &&
      typeof c.type === "string" &&
      c.type.includes("segment_color_setting"),
  );
}

/**
 * Interactive segment-detection state machine.
 *
 * Flashes each segment bright white one-by-one up to the protocol limit.
 * The user steers the session with `yes` (visible) / `no` (dark) /
 * `done` (strip ended). The final result — real segment count plus any
 * gaps for cut strips — is applied via {@link WizardHost.applyWizardResult}.
 *
 * Public entry point is {@link SegmentWizard.runStep} which routes by action
 * string ("start" | "yes" | "no" | "done" | "abort"). Individual lifecycle
 * methods are also usable directly; they're the seams that tests target.
 */
export class SegmentWizard {
  private session: SegmentWizardSession | null = null;
  private timeoutHandle: unknown = undefined;

  /** @param host Host interface wired up to the adapter. */
  constructor(private readonly host: WizardHost) {}

  /** Currently active? Exposed for diagnostics/tests. */
  public isActive(): boolean {
    return this.session !== null;
  }

  /**
   * Human-readable status string for the admin UI (rendered via textSendTo).
   * Must stay a plain string — Admin renders it as-is into a read-only field.
   */
  public getStatusText(): string {
    const s = this.session;
    if (!s) {
      return WIZARD_IDLE_TEXT;
    }
    const visibleStr = s.visible.length > 0 ? s.visible.join(", ") : "—";
    return (
      `Gerät: ${s.name}\n` +
      `► Segment ${s.current} leuchtet jetzt WEISS.\n` +
      `Siehst du das Licht auf dem Strip?\n` +
      `  ✓ Ja, sichtbar   → weiter zum nächsten Segment\n` +
      `  ✗ Nein, dunkel   → Lücke, weiter zum nächsten Segment\n` +
      `  ■ Fertig – Strip zu Ende → Ergebnis speichern\n` +
      `\n` +
      `Bisher als sichtbar markiert: [${visibleStr}]`
    );
  }

  /** Clear any pending idle-timer. Called from onUnload. */
  public dispose(): void {
    this.clearIdleTimer();
    this.session = null;
  }

  /**
   * Route one wizard step from the sendTo handler.
   *
   * @param action "start" | "yes" | "no" | "done" | "abort"
   * @param deviceKey Target device — only consulted on action="start"
   */
  public async runStep(
    action: string,
    deviceKey: string,
  ): Promise<WizardResponse> {
    if (action === "start") {
      return this.start(deviceKey);
    }
    if (!this.session) {
      return { error: "Kein Wizard aktiv. Bitte zuerst 'Start' klicken." };
    }
    if (action === "abort") {
      return this.abort();
    }
    if (action === "done") {
      return this.done();
    }
    if (action === "yes" || action === "no") {
      return this.answer(action === "yes");
    }
    return { error: `Unbekannte Aktion: ${action}` };
  }

  /**
   * Begin a new wizard session. Captures baseline and flashes segment 0.
   *
   * @param deviceKey Target device key
   */
  public async start(deviceKey: string): Promise<WizardResponse> {
    if (this.session) {
      return {
        error: `Wizard bereits aktiv für ${this.session.name}. Bitte zuerst abbrechen.`,
      };
    }
    const device = this.host.findDevice(deviceKey);
    if (!device) {
      return { error: `Gerät nicht gefunden: ${deviceKey}` };
    }
    if (!hasSegmentCapability(device)) {
      return {
        error: `${device.name} hat keine Segmente — Wizard nicht anwendbar.`,
      };
    }

    const baseline = await this.captureBaseline(device);

    this.session = {
      deviceKey,
      sku: device.sku,
      name: device.name,
      current: 0,
      total: SEGMENT_HARD_MAX + 1,
      visible: [],
      startedAt: Date.now(),
      baseline,
    };
    this.scheduleIdleTimeout();
    // Make sure the strip is ON and at full global brightness before we
    // start flashing segments — otherwise a user with their strip dimmed to
    // e.g. 10 % would see nothing.
    await this.host.sendCommand(device, "power", true);
    await this.host.sendCommand(device, "brightness", 100);
    await this.flashSegment(device, 0);

    return {
      message:
        `Wizard gestartet für ${device.name}.\n\n` +
        `► SEGMENT 0 leuchtet jetzt WEISS.\n` +
        `Siehst du das Licht auf dem Strip?\n` +
        `→ Ja, sichtbar   oder   → Nein, dunkel   oder   → Fertig – Strip zu Ende`,
      progress: `Segment 0`,
      active: true,
    };
  }

  /**
   * Record the user's answer for the current segment and advance.
   *
   * @param wasVisible Whether the user saw the flashed segment
   */
  public async answer(wasVisible: boolean): Promise<WizardResponse> {
    const session = this.session;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    if (wasVisible) {
      session.visible.push(session.current);
    }
    const answeredIdx = session.current;
    session.current += 1;
    this.scheduleIdleTimeout();

    // Safety: protocol bitmask can only address 0..55. If we somehow get
    // there, auto-finalize instead of flashing a seg the device can't render.
    if (session.current > SEGMENT_HARD_MAX) {
      return this.finish();
    }

    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: "Gerät während des Wizards verschwunden" };
    }
    await this.flashSegment(device, session.current);
    const lastNote = wasVisible
      ? `✓ Segment ${answeredIdx} als sichtbar markiert.`
      : `✗ Segment ${answeredIdx} als dunkel markiert (Lücke).`;
    return {
      message:
        `${lastNote}\n\n` +
        `► SEGMENT ${session.current} leuchtet jetzt WEISS.\n` +
        `Siehst du das Licht?\n` +
        `→ Ja, sichtbar   oder   → Nein, dunkel   oder   → Fertig – Strip zu Ende`,
      progress: `Segment ${session.current}`,
      active: true,
    };
  }

  /**
   * User ends the session — "Strip zu Ende, keine weiteren Segmente".
   * The currently-flashed segment was NOT answered, so it doesn't count.
   */
  public async done(): Promise<WizardResponse> {
    const session = this.session;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    if (session.current === 0) {
      return {
        error:
          "Bitte zuerst mindestens eine Antwort geben (Ja sichtbar oder Nein dunkel).",
      };
    }
    return this.finish();
  }

  /** Abort the session and roll back to the captured baseline. */
  public async abort(): Promise<WizardResponse> {
    const session = this.session;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    const device = this.host.findDevice(session.deviceKey);
    if (device) {
      await this.restoreBaseline(device, session.baseline);
    }
    this.session = null;
    this.clearIdleTimer();
    return {
      message:
        `Wizard abgebrochen.\n` +
        `Der Strip wurde auf den vorherigen Zustand zurückgesetzt.\n` +
        `Du kannst den Wizard jederzeit neu starten.`,
      done: true,
      aborted: true,
    };
  }

  /**
   * Consolidate the session into a {@link WizardResult}, hand off to the host
   * for application, restore baseline and close the session.
   */
  private async finish(): Promise<WizardResponse> {
    const session = this.session;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: "Gerät verschwunden" };
    }

    const segmentCount = session.current;
    const visible = session.visible.slice().sort((a, b) => a - b);
    const allContiguous =
      visible.length === segmentCount && visible.every((v, i) => v === i);
    const manualList = allContiguous ? "" : compactIndices(visible);
    const result: WizardResult = {
      segmentCount,
      manualList,
      hasGaps: !allContiguous,
    };

    await this.host.applyWizardResult(device, result);
    await this.restoreBaseline(device, session.baseline);

    this.host.log.info(
      `Segment-Wizard für ${device.name}: ${segmentCount} Segmente erkannt${
        result.hasGaps
          ? `, Lücken erkannt (manual_list="${manualList}")`
          : ", keine Lücken"
      }`,
    );

    this.session = null;
    this.clearIdleTimer();

    const summary = result.hasGaps
      ? `Lücken-Liste: ${manualList} — Manual-Mode aktiv.`
      : `Keine Lücken — Manual-Mode deaktiviert.`;
    return {
      message:
        `✓ FERTIG!\n\n` +
        `${segmentCount} Segmente erkannt.\n` +
        `${summary}\n` +
        `State-Tree wurde neu gebaut.`,
      progress: `${segmentCount} Segmente`,
      done: true,
      segmentCount,
      list: manualList,
      hasGaps: result.hasGaps,
    };
  }

  /** (Re-)arm the 5-minute idle timeout that fires abort(). */
  private scheduleIdleTimeout(): void {
    this.clearIdleTimer();
    this.timeoutHandle = this.host.setTimeout(() => {
      if (!this.session) {
        return;
      }
      this.host.log.warn(
        `Segment-Wizard für ${this.session.name}: Idle-Timeout (5 Min), abgebrochen`,
      );
      this.abort().catch((e) => {
        this.host.log.warn(
          `Wizard-Abort nach Timeout fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
        );
        this.session = null;
      });
    }, IDLE_TIMEOUT_MS);
  }

  /** Cancel the idle timer without running its callback. */
  private clearIdleTimer(): void {
    if (this.timeoutHandle !== undefined) {
      this.host.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  /**
   * Snapshot the device's current power/brightness/colorRgb plus per-segment
   * color+brightness so the baseline can be restored on abort/finish.
   *
   * @param device Target device
   */
  private async captureBaseline(
    device: GoveeDevice,
  ): Promise<SegmentWizardSession["baseline"]> {
    const prefix = this.host.devicePrefix(device);
    const ns = this.host.namespace;
    const power = (await this.host.getState(`${ns}.${prefix}.control.power`))
      ?.val;
    const brightness = (
      await this.host.getState(`${ns}.${prefix}.control.brightness`)
    )?.val;
    const colorRgb = (
      await this.host.getState(`${ns}.${prefix}.control.colorRgb`)
    )?.val;
    const segmentColors: SegmentWizardSession["baseline"]["segmentColors"] = [];
    const currentCount = device.segmentCount ?? 0;
    for (let i = 0; i < currentCount; i++) {
      const c = (
        await this.host.getState(`${ns}.${prefix}.segments.${i}.color`)
      )?.val;
      const b = (
        await this.host.getState(`${ns}.${prefix}.segments.${i}.brightness`)
      )?.val;
      segmentColors.push({
        idx: i,
        color: typeof c === "string" ? c : "#ffffff",
        brightness: typeof b === "number" ? b : 100,
      });
    }
    return {
      power: typeof power === "boolean" ? power : undefined,
      brightness: typeof brightness === "number" ? brightness : undefined,
      colorRgb: typeof colorRgb === "string" ? colorRgb : undefined,
      segmentColors,
    };
  }

  /**
   * Flash one segment bright white, dimming all others so only the target is
   * clearly visible.
   *
   * @param device Target device
   * @param idx Segment to flash white (others go near-black)
   */
  private async flashSegment(device: GoveeDevice, idx: number): Promise<void> {
    // Flash-extent = what we'll address: we can't know the real count yet,
    // so drive the full protocol range. The device silently drops indices
    // it doesn't physically have.
    const total = SEGMENT_HARD_MAX + 1;
    const atomic = await this.host.flashSegmentAtomic(device, total, idx);
    if (atomic) {
      return;
    }
    // Fallback (Cloud or no LAN): two sendCommand calls with pacing.
    const others = Array.from({ length: total }, (_, i) => i).filter(
      (i) => i !== idx,
    );
    if (others.length > 0) {
      await this.host.sendCommand(device, "segmentBatch", {
        segments: others,
        color: 0,
        brightness: 0,
      });
    }
    await this.host.sendCommand(device, "segmentBatch", {
      segments: [idx],
      color: 0xffffff,
      brightness: 100,
    });
  }

  /**
   * Send one segmentBatch that pushes the captured baseline back onto the
   * whole strip. No-op when no RGB baseline was captured (e.g. fresh state).
   *
   * @param device Target device
   * @param baseline Previously captured baseline values
   */
  private async restoreBaseline(
    device: GoveeDevice,
    baseline: SegmentWizardSession["baseline"],
  ): Promise<void> {
    if (!baseline.colorRgb || !/^#[0-9a-fA-F]{6}$/.test(baseline.colorRgb)) {
      return;
    }
    const total = device.segmentCount ?? 0;
    if (total <= 0) {
      return;
    }
    const color = parseInt(baseline.colorRgb.slice(1), 16);
    const brightness = baseline.brightness ?? 100;
    const atomic = await this.host.restoreStripAtomic(
      device,
      total,
      color,
      brightness,
    );
    if (atomic) {
      return;
    }
    await this.host.sendCommand(device, "segmentBatch", {
      segments: Array.from({ length: total }, (_, i) => i),
      color,
      brightness,
    });
  }
}

/**
 * Compact a sorted index array into a range-notation string.
 * `[0,1,2,4,5,6]` → `"0-2,4-6"`, `[3]` → `"3"`, `[]` → `""`.
 *
 * @param sorted Sorted ascending array of non-negative integers
 */
function compactIndices(sorted: number[]): string {
  if (sorted.length === 0) {
    return "";
  }
  const parts: string[] = [];
  let runStart = sorted[0];
  let runEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === runEnd + 1) {
      runEnd = sorted[i];
    } else {
      parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
      runStart = sorted[i];
      runEnd = sorted[i];
    }
  }
  parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
  return parts.join(",");
}
