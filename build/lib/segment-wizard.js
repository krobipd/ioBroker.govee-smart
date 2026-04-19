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
var segment_wizard_exports = {};
__export(segment_wizard_exports, {
  SegmentWizard: () => SegmentWizard,
  WIZARD_IDLE_TEXT: () => WIZARD_IDLE_TEXT
});
module.exports = __toCommonJS(segment_wizard_exports);
var import_device_manager = require("./device-manager.js");
const IDLE_TIMEOUT_MS = 5 * 6e4;
const WIZARD_IDLE_TEXT = "Kein Wizard aktiv. W\xE4hle oben einen LED-Strip und klicke \u25B6 Start.";
function hasSegmentCapability(device) {
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  return caps.some(
    (c) => c && typeof c.type === "string" && c.type.includes("segment_color_setting")
  );
}
class SegmentWizard {
  /** @param host Host interface wired up to the adapter. */
  constructor(host) {
    this.host = host;
  }
  session = null;
  timeoutHandle = void 0;
  /** Currently active? Exposed for diagnostics/tests. */
  isActive() {
    return this.session !== null;
  }
  /**
   * Human-readable status string for the admin UI (rendered via textSendTo).
   * Must stay a plain string — Admin renders it as-is into a read-only field.
   */
  getStatusText() {
    const s = this.session;
    if (!s) {
      return WIZARD_IDLE_TEXT;
    }
    const visibleStr = s.visible.length > 0 ? s.visible.join(", ") : "\u2014";
    return `Ger\xE4t: ${s.name}
\u25BA Segment ${s.current} leuchtet jetzt WEISS.
Siehst du das Licht auf dem Strip?
  \u2713 Ja, sichtbar   \u2192 weiter zum n\xE4chsten Segment
  \u2717 Nein, dunkel   \u2192 L\xFCcke, weiter zum n\xE4chsten Segment
  \u25A0 Fertig \u2013 Strip zu Ende \u2192 Ergebnis speichern

Bisher als sichtbar markiert: [${visibleStr}]`;
  }
  /** Clear any pending idle-timer. Called from onUnload. */
  dispose() {
    this.clearIdleTimer();
    this.session = null;
  }
  /**
   * Route one wizard step from the sendTo handler.
   *
   * @param action "start" | "yes" | "no" | "done" | "abort"
   * @param deviceKey Target device — only consulted on action="start"
   */
  async runStep(action, deviceKey) {
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
  async start(deviceKey) {
    if (this.session) {
      return {
        error: `Wizard bereits aktiv f\xFCr ${this.session.name}. Bitte zuerst abbrechen.`
      };
    }
    const device = this.host.findDevice(deviceKey);
    if (!device) {
      return { error: `Ger\xE4t nicht gefunden: ${deviceKey}` };
    }
    if (!hasSegmentCapability(device)) {
      return {
        error: `${device.name} hat keine Segmente \u2014 Wizard nicht anwendbar.`
      };
    }
    const baseline = await this.captureBaseline(device);
    this.session = {
      deviceKey,
      sku: device.sku,
      name: device.name,
      current: 0,
      total: import_device_manager.SEGMENT_HARD_MAX + 1,
      visible: [],
      startedAt: Date.now(),
      baseline
    };
    this.scheduleIdleTimeout();
    await this.host.sendCommand(device, "power", true);
    await this.host.sendCommand(device, "brightness", 100);
    await this.flashSegment(device, 0);
    return {
      message: `Wizard gestartet f\xFCr ${device.name}.

\u25BA SEGMENT 0 leuchtet jetzt WEISS.
Siehst du das Licht auf dem Strip?
\u2192 Ja, sichtbar   oder   \u2192 Nein, dunkel   oder   \u2192 Fertig \u2013 Strip zu Ende`,
      progress: `Segment 0`,
      active: true
    };
  }
  /**
   * Record the user's answer for the current segment and advance.
   *
   * @param wasVisible Whether the user saw the flashed segment
   */
  async answer(wasVisible) {
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
    if (session.current > import_device_manager.SEGMENT_HARD_MAX) {
      return this.finish();
    }
    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: "Ger\xE4t w\xE4hrend des Wizards verschwunden" };
    }
    await this.flashSegment(device, session.current);
    const lastNote = wasVisible ? `\u2713 Segment ${answeredIdx} als sichtbar markiert.` : `\u2717 Segment ${answeredIdx} als dunkel markiert (L\xFCcke).`;
    return {
      message: `${lastNote}

\u25BA SEGMENT ${session.current} leuchtet jetzt WEISS.
Siehst du das Licht?
\u2192 Ja, sichtbar   oder   \u2192 Nein, dunkel   oder   \u2192 Fertig \u2013 Strip zu Ende`,
      progress: `Segment ${session.current}`,
      active: true
    };
  }
  /**
   * User ends the session — "Strip zu Ende, keine weiteren Segmente".
   * The currently-flashed segment was NOT answered, so it doesn't count.
   */
  async done() {
    const session = this.session;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    if (session.current === 0) {
      return {
        error: "Bitte zuerst mindestens eine Antwort geben (Ja sichtbar oder Nein dunkel)."
      };
    }
    return this.finish();
  }
  /** Abort the session and roll back to the captured baseline. */
  async abort() {
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
      message: `Wizard abgebrochen.
Der Strip wurde auf den vorherigen Zustand zur\xFCckgesetzt.
Du kannst den Wizard jederzeit neu starten.`,
      done: true,
      aborted: true
    };
  }
  /**
   * Consolidate the session into a {@link WizardResult}, hand off to the host
   * for application, restore baseline and close the session.
   */
  async finish() {
    const session = this.session;
    if (!session) {
      return { error: "Kein Wizard aktiv" };
    }
    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: "Ger\xE4t verschwunden" };
    }
    const segmentCount = session.current;
    const visible = session.visible.slice().sort((a, b) => a - b);
    const allContiguous = visible.length === segmentCount && visible.every((v, i) => v === i);
    const manualList = allContiguous ? "" : compactIndices(visible);
    const result = {
      segmentCount,
      manualList,
      hasGaps: !allContiguous
    };
    await this.host.applyWizardResult(device, result);
    await this.restoreBaseline(device, session.baseline);
    this.host.log.info(
      `Segment-Wizard f\xFCr ${device.name}: ${segmentCount} Segmente erkannt${result.hasGaps ? `, L\xFCcken erkannt (manual_list="${manualList}")` : ", keine L\xFCcken"}`
    );
    this.session = null;
    this.clearIdleTimer();
    const summary = result.hasGaps ? `L\xFCcken-Liste: ${manualList} \u2014 Manual-Mode aktiv.` : `Keine L\xFCcken \u2014 Manual-Mode deaktiviert.`;
    return {
      message: `\u2713 FERTIG!

${segmentCount} Segmente erkannt.
${summary}
State-Tree wurde neu gebaut.`,
      progress: `${segmentCount} Segmente`,
      done: true,
      segmentCount,
      list: manualList,
      hasGaps: result.hasGaps
    };
  }
  /** (Re-)arm the 5-minute idle timeout that fires abort(). */
  scheduleIdleTimeout() {
    this.clearIdleTimer();
    this.timeoutHandle = this.host.setTimeout(() => {
      if (!this.session) {
        return;
      }
      this.host.log.warn(
        `Segment-Wizard f\xFCr ${this.session.name}: Idle-Timeout (5 Min), abgebrochen`
      );
      this.abort().catch((e) => {
        this.host.log.warn(
          `Wizard-Abort nach Timeout fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`
        );
        this.session = null;
      });
    }, IDLE_TIMEOUT_MS);
  }
  /** Cancel the idle timer without running its callback. */
  clearIdleTimer() {
    if (this.timeoutHandle !== void 0) {
      this.host.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = void 0;
    }
  }
  /**
   * Snapshot the device's current power/brightness/colorRgb plus per-segment
   * color+brightness so the baseline can be restored on abort/finish.
   *
   * @param device Target device
   */
  async captureBaseline(device) {
    var _a, _b, _c, _d, _e, _f;
    const prefix = this.host.devicePrefix(device);
    const ns = this.host.namespace;
    const power = (_a = await this.host.getState(`${ns}.${prefix}.control.power`)) == null ? void 0 : _a.val;
    const brightness = (_b = await this.host.getState(`${ns}.${prefix}.control.brightness`)) == null ? void 0 : _b.val;
    const colorRgb = (_c = await this.host.getState(`${ns}.${prefix}.control.colorRgb`)) == null ? void 0 : _c.val;
    const segmentColors = [];
    const currentCount = (_d = device.segmentCount) != null ? _d : 0;
    for (let i = 0; i < currentCount; i++) {
      const c = (_e = await this.host.getState(`${ns}.${prefix}.segments.${i}.color`)) == null ? void 0 : _e.val;
      const b = (_f = await this.host.getState(`${ns}.${prefix}.segments.${i}.brightness`)) == null ? void 0 : _f.val;
      segmentColors.push({
        idx: i,
        color: typeof c === "string" ? c : "#ffffff",
        brightness: typeof b === "number" ? b : 100
      });
    }
    return {
      power: typeof power === "boolean" ? power : void 0,
      brightness: typeof brightness === "number" ? brightness : void 0,
      colorRgb: typeof colorRgb === "string" ? colorRgb : void 0,
      segmentColors
    };
  }
  /**
   * Flash one segment bright white, dimming all others so only the target is
   * clearly visible.
   *
   * @param device Target device
   * @param idx Segment to flash white (others go near-black)
   */
  async flashSegment(device, idx) {
    const total = import_device_manager.SEGMENT_HARD_MAX + 1;
    const atomic = await this.host.flashSegmentAtomic(device, total, idx);
    if (atomic) {
      return;
    }
    const others = Array.from({ length: total }, (_, i) => i).filter(
      (i) => i !== idx
    );
    if (others.length > 0) {
      await this.host.sendCommand(device, "segmentBatch", {
        segments: others,
        color: 0,
        brightness: 0
      });
    }
    await this.host.sendCommand(device, "segmentBatch", {
      segments: [idx],
      color: 16777215,
      brightness: 100
    });
  }
  /**
   * Send one segmentBatch that pushes the captured baseline back onto the
   * whole strip. No-op when no RGB baseline was captured (e.g. fresh state).
   *
   * @param device Target device
   * @param baseline Previously captured baseline values
   */
  async restoreBaseline(device, baseline) {
    var _a, _b;
    if (!baseline.colorRgb || !/^#[0-9a-fA-F]{6}$/.test(baseline.colorRgb)) {
      return;
    }
    const total = (_a = device.segmentCount) != null ? _a : 0;
    if (total <= 0) {
      return;
    }
    const color = parseInt(baseline.colorRgb.slice(1), 16);
    const brightness = (_b = baseline.brightness) != null ? _b : 100;
    const atomic = await this.host.restoreStripAtomic(
      device,
      total,
      color,
      brightness
    );
    if (atomic) {
      return;
    }
    await this.host.sendCommand(device, "segmentBatch", {
      segments: Array.from({ length: total }, (_, i) => i),
      color,
      brightness
    });
  }
}
function compactIndices(sorted) {
  if (sorted.length === 0) {
    return "";
  }
  const parts = [];
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SegmentWizard,
  WIZARD_IDLE_TEXT
});
//# sourceMappingURL=segment-wizard.js.map
