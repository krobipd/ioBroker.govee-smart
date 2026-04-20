import { SEGMENT_HARD_MAX } from "./device-manager.js";
import type { GoveeDevice } from "./types.js";

/**
 * Wizard UI text, keyed by message id and language. The handful of admin
 * languages that don't have a dedicated table fall through to English — the
 * wizard is a power-user feature and English is the closest-to-universal
 * admin default.
 */
type WizardLang = "en" | "de";

const WIZARD_STRINGS: Record<WizardLang, Record<string, string>> = {
  en: {
    idle: "No wizard active. Pick an LED strip above and click ▶ Start.",
    btnYes: "✓ Yes, visible",
    btnNo: "✗ No, dark",
    btnDone: "■ Done – end of strip",
    deviceHeader: "Device",
    segmentFlashing: "► Segment {idx} is now lit WHITE.",
    canYouSeeStrip: "Can you see the light on the strip?",
    canYouSeeShort: "Can you see the light?",
    seenSoFar: "Marked visible so far: [{list}]",
    yesNoDoneLine:
      "→ Yes, visible   or   → No, dark   or   → Done – end of strip",
    wizardStartedFor: "Wizard started for {name}.",
    markedVisible: "✓ Segment {idx} marked as visible.",
    markedDark: "✗ Segment {idx} marked as dark (gap).",
    errNoWizard: "No wizard active. Please click 'Start' first.",
    errNoWizardShort: "No wizard active",
    errUnknownAction: "Unknown action: {action}",
    errAlreadyActive: "Wizard already active for {name}. Please abort first.",
    errDeviceNotFound: "Device not found: {key}",
    errNoSegments: "{name} has no segments — wizard not applicable.",
    errDeviceGone: "Device disappeared during the wizard",
    errDeviceGoneShort: "Device disappeared",
    errAnswerFirst:
      "Please answer at least once first (Yes visible or No dark).",
    abortTitle: "Wizard aborted.",
    abortRestored: "The strip has been restored to its previous state.",
    abortRestart: "You can restart the wizard at any time.",
    finishDone: "✓ DONE!",
    finishCount: "{count} segments detected.",
    finishGaps: "Gap list: {list} — manual-mode active.",
    finishNoGaps: "No gaps — manual-mode disabled.",
    finishTreeRebuilt: "State tree has been rebuilt.",
    progressSegment: "Segment {idx}",
    progressCount: "{count} segments",
    logIdleTimeout: "Segment wizard for {name}: idle timeout (5 min), aborted",
    logAbortFailed: "Wizard abort after timeout failed: {msg}",
    logDetected: "Segment wizard for {name}: {count} segments detected{gaps}",
    logGapsSuffix: ', gaps detected (manual_list="{list}")',
    logNoGapsSuffix: ", no gaps",
  },
  de: {
    idle: "Kein Assistent aktiv. Wähle oben einen LED-Strip und klicke ▶ Start.",
    btnYes: "✓ Ja, sichtbar",
    btnNo: "✗ Nein, dunkel",
    btnDone: "■ Fertig – Strip zu Ende",
    deviceHeader: "Gerät",
    segmentFlashing: "► Segment {idx} leuchtet jetzt WEISS.",
    canYouSeeStrip: "Siehst du das Licht auf dem Strip?",
    canYouSeeShort: "Siehst du das Licht?",
    seenSoFar: "Bisher als sichtbar markiert: [{list}]",
    yesNoDoneLine:
      "→ Ja, sichtbar   oder   → Nein, dunkel   oder   → Fertig – Strip zu Ende",
    wizardStartedFor: "Assistent gestartet für {name}.",
    markedVisible: "✓ Segment {idx} als sichtbar markiert.",
    markedDark: "✗ Segment {idx} als dunkel markiert (Lücke).",
    errNoWizard: "Kein Assistent aktiv. Bitte zuerst 'Start' klicken.",
    errNoWizardShort: "Kein Assistent aktiv",
    errUnknownAction: "Unbekannte Aktion: {action}",
    errAlreadyActive:
      "Assistent bereits aktiv für {name}. Bitte zuerst abbrechen.",
    errDeviceNotFound: "Gerät nicht gefunden: {key}",
    errNoSegments: "{name} hat keine Segmente — Assistent nicht anwendbar.",
    errDeviceGone: "Gerät während des Assistenten verschwunden",
    errDeviceGoneShort: "Gerät verschwunden",
    errAnswerFirst:
      "Bitte zuerst mindestens eine Antwort geben (Ja sichtbar oder Nein dunkel).",
    abortTitle: "Assistent abgebrochen.",
    abortRestored: "Der Strip wurde auf den vorherigen Zustand zurückgesetzt.",
    abortRestart: "Du kannst den Assistenten jederzeit neu starten.",
    finishDone: "✓ FERTIG!",
    finishCount: "{count} Segmente erkannt.",
    finishGaps: "Lücken-Liste: {list} — Manual-Mode aktiv.",
    finishNoGaps: "Keine Lücken — Manual-Mode deaktiviert.",
    finishTreeRebuilt: "State-Tree wurde neu gebaut.",
    progressSegment: "Segment {idx}",
    progressCount: "{count} Segmente",
    logIdleTimeout:
      "Segment-Assistent für {name}: Idle-Timeout (5 Min), abgebrochen",
    logAbortFailed:
      "Abbruch des Assistenten nach Timeout fehlgeschlagen: {msg}",
    logDetected: "Segment-Assistent für {name}: {count} Segmente erkannt{gaps}",
    logGapsSuffix: ', Lücken erkannt (manual_list="{list}")',
    logNoGapsSuffix: ", keine Lücken",
  },
};

/**
 * Interpolate {name} placeholders against a params object.
 *
 * @param template Message template with `{placeholder}` slots
 * @param params Values to substitute — keys must match the placeholder names
 */
function format(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in params ? String(params[key]) : m,
  );
}

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
  flashSegmentAtomic(device: GoveeDevice, idx: number): Promise<boolean>;
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
  /**
   * Admin-UI language for all user-facing wizard text. Called on every
   * getStatusText / step response so a live system.config.language change
   * propagates without an adapter restart.
   */
  getLanguage(): string;
}

const IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Resolve the idle-state text in the requested language. Fallbacks to English
 * for any admin language we don't have a dedicated table for — the adapter
 * supports 11 admin languages in the UI, but the wizard prose lives here.
 *
 * @param lang Language code (e.g. "en", "de"); non-matching codes fall back to English
 */
export function wizardIdleText(lang: string): string {
  return WIZARD_STRINGS[lang === "de" ? "de" : "en"].idle;
}

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
   * Look up a localized string, resolving against the host's current language.
   *
   * @param key Lookup key into WIZARD_STRINGS
   * @param params Optional placeholder values for `{name}` slots in the template
   */
  private t(key: string, params?: Record<string, string | number>): string {
    const lang = this.host.getLanguage() === "de" ? "de" : "en";
    const template = WIZARD_STRINGS[lang][key] ?? WIZARD_STRINGS.en[key] ?? key;
    return format(template, params);
  }

  /**
   * Human-readable status string for the admin UI (rendered via textSendTo).
   * Must stay a plain string — Admin renders it as-is into a read-only field.
   */
  public getStatusText(): string {
    const s = this.session;
    if (!s) {
      return this.t("idle");
    }
    const visibleStr = s.visible.length > 0 ? s.visible.join(", ") : "—";
    return (
      `${this.t("deviceHeader")}: ${s.name}\n` +
      `${this.t("segmentFlashing", { idx: s.current })}\n` +
      `${this.t("canYouSeeStrip")}\n` +
      `  ${this.t("btnYes")}\n` +
      `  ${this.t("btnNo")}\n` +
      `  ${this.t("btnDone")}\n` +
      `\n` +
      `${this.t("seenSoFar", { list: visibleStr })}`
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
      return { error: this.t("errNoWizard") };
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
    return { error: this.t("errUnknownAction", { action }) };
  }

  /**
   * Begin a new wizard session. Captures baseline and flashes segment 0.
   *
   * @param deviceKey Target device key
   */
  public async start(deviceKey: string): Promise<WizardResponse> {
    if (this.session) {
      return {
        error: this.t("errAlreadyActive", { name: this.session.name }),
      };
    }
    const device = this.host.findDevice(deviceKey);
    if (!device) {
      return { error: this.t("errDeviceNotFound", { key: deviceKey }) };
    }
    if (!hasSegmentCapability(device)) {
      return {
        error: this.t("errNoSegments", { name: device.name }),
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
        `${this.t("wizardStartedFor", { name: device.name })}\n\n` +
        `${this.t("segmentFlashing", { idx: 0 })}\n` +
        `${this.t("canYouSeeStrip")}\n` +
        `${this.t("yesNoDoneLine")}`,
      progress: this.t("progressSegment", { idx: 0 }),
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
      return { error: this.t("errNoWizardShort") };
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
      return { error: this.t("errDeviceGone") };
    }
    await this.flashSegment(device, session.current);
    const lastNote = this.t(wasVisible ? "markedVisible" : "markedDark", {
      idx: answeredIdx,
    });
    return {
      message:
        `${lastNote}\n\n` +
        `${this.t("segmentFlashing", { idx: session.current })}\n` +
        `${this.t("canYouSeeShort")}\n` +
        `${this.t("yesNoDoneLine")}`,
      progress: this.t("progressSegment", { idx: session.current }),
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
      return { error: this.t("errNoWizardShort") };
    }
    if (session.current === 0) {
      return { error: this.t("errAnswerFirst") };
    }
    return this.finish();
  }

  /** Abort the session and roll back to the captured baseline. */
  public async abort(): Promise<WizardResponse> {
    const session = this.session;
    if (!session) {
      return { error: this.t("errNoWizardShort") };
    }
    const device = this.host.findDevice(session.deviceKey);
    if (device) {
      await this.restoreBaseline(device, session.baseline);
    }
    this.session = null;
    this.clearIdleTimer();
    return {
      message:
        `${this.t("abortTitle")}\n` +
        `${this.t("abortRestored")}\n` +
        `${this.t("abortRestart")}`,
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
      return { error: this.t("errNoWizardShort") };
    }
    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: this.t("errDeviceGoneShort") };
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

    const gapsSuffix = result.hasGaps
      ? this.t("logGapsSuffix", { list: manualList })
      : this.t("logNoGapsSuffix");
    this.host.log.info(
      this.t("logDetected", {
        name: device.name,
        count: segmentCount,
        gaps: gapsSuffix,
      }),
    );

    this.session = null;
    this.clearIdleTimer();

    const summary = result.hasGaps
      ? this.t("finishGaps", { list: manualList })
      : this.t("finishNoGaps");
    return {
      message:
        `${this.t("finishDone")}\n\n` +
        `${this.t("finishCount", { count: segmentCount })}\n` +
        `${summary}\n` +
        `${this.t("finishTreeRebuilt")}`,
      progress: this.t("progressCount", { count: segmentCount }),
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
      this.host.log.warn(this.t("logIdleTimeout", { name: this.session.name }));
      this.abort().catch((e) => {
        this.host.log.warn(
          this.t("logAbortFailed", {
            msg: e instanceof Error ? e.message : String(e),
          }),
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
    const atomic = await this.host.flashSegmentAtomic(device, idx);
    if (atomic) {
      return;
    }
    // Fallback (Cloud or no LAN): two sendCommand calls with pacing.
    // Fallback drives the full protocol range — we can't know the real count
    // yet. The device silently drops indices it doesn't physically have.
    const total = SEGMENT_HARD_MAX + 1;
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
