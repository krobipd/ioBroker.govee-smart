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
  wizardIdleText: () => wizardIdleText
});
module.exports = __toCommonJS(segment_wizard_exports);
var import_device_manager = require("./device-manager.js");
const WIZARD_STRINGS = {
  en: {
    idle: "No wizard active. Pick an LED strip above and click \u25B6 Start.",
    btnYes: "\u2713 Yes, visible",
    btnNo: "\u2717 No, dark",
    btnDone: "\u25A0 Done \u2013 end of strip",
    deviceHeader: "Device",
    segmentFlashing: "\u25BA Segment {idx} is now lit WHITE.",
    canYouSeeStrip: "Can you see the light on the strip?",
    canYouSeeShort: "Can you see the light?",
    seenSoFar: "Marked visible so far: [{list}]",
    yesNoDoneLine: "\u2192 Yes, visible   or   \u2192 No, dark   or   \u2192 Done \u2013 end of strip",
    wizardStartedFor: "Wizard started for {name}.",
    markedVisible: "\u2713 Segment {idx} marked as visible.",
    markedDark: "\u2717 Segment {idx} marked as dark (gap).",
    errNoWizard: "No wizard active. Please click 'Start' first.",
    errNoWizardShort: "No wizard active",
    errUnknownAction: "Unknown action: {action}",
    errAlreadyActive: "Wizard already active for {name}. Please abort first.",
    errDeviceNotFound: "Device not found: {key}",
    errNoSegments: "{name} has no segments \u2014 wizard not applicable.",
    errDeviceGone: "Device disappeared during the wizard",
    errDeviceGoneShort: "Device disappeared",
    errAnswerFirst: "Please answer at least once first (Yes visible or No dark).",
    abortTitle: "Wizard aborted.",
    abortRestored: "The strip has been restored to its previous state.",
    abortRestart: "You can restart the wizard at any time.",
    finishDone: "\u2713 DONE!",
    finishCount: "{count} segments detected.",
    finishGaps: "Gap list: {list} \u2014 manual-mode active.",
    finishNoGaps: "No gaps \u2014 manual-mode disabled.",
    finishTreeRebuilt: "State tree has been rebuilt.",
    progressSegment: "Segment {idx}",
    progressCount: "{count} segments",
    logIdleTimeout: "Segment wizard for {name}: idle timeout (5 min), aborted",
    logAbortFailed: "Wizard abort after timeout failed: {msg}",
    logDetected: "Segment wizard for {name}: {count} segments detected{gaps}",
    logGapsSuffix: ', gaps detected (manual_list="{list}")',
    logNoGapsSuffix: ", no gaps"
  },
  de: {
    idle: "Kein Assistent aktiv. W\xE4hle oben einen LED-Strip und klicke \u25B6 Start.",
    btnYes: "\u2713 Ja, sichtbar",
    btnNo: "\u2717 Nein, dunkel",
    btnDone: "\u25A0 Fertig \u2013 Strip zu Ende",
    deviceHeader: "Ger\xE4t",
    segmentFlashing: "\u25BA Segment {idx} leuchtet jetzt WEISS.",
    canYouSeeStrip: "Siehst du das Licht auf dem Strip?",
    canYouSeeShort: "Siehst du das Licht?",
    seenSoFar: "Bisher als sichtbar markiert: [{list}]",
    yesNoDoneLine: "\u2192 Ja, sichtbar   oder   \u2192 Nein, dunkel   oder   \u2192 Fertig \u2013 Strip zu Ende",
    wizardStartedFor: "Assistent gestartet f\xFCr {name}.",
    markedVisible: "\u2713 Segment {idx} als sichtbar markiert.",
    markedDark: "\u2717 Segment {idx} als dunkel markiert (L\xFCcke).",
    errNoWizard: "Kein Assistent aktiv. Bitte zuerst 'Start' klicken.",
    errNoWizardShort: "Kein Assistent aktiv",
    errUnknownAction: "Unbekannte Aktion: {action}",
    errAlreadyActive: "Assistent bereits aktiv f\xFCr {name}. Bitte zuerst abbrechen.",
    errDeviceNotFound: "Ger\xE4t nicht gefunden: {key}",
    errNoSegments: "{name} hat keine Segmente \u2014 Assistent nicht anwendbar.",
    errDeviceGone: "Ger\xE4t w\xE4hrend des Assistenten verschwunden",
    errDeviceGoneShort: "Ger\xE4t verschwunden",
    errAnswerFirst: "Bitte zuerst mindestens eine Antwort geben (Ja sichtbar oder Nein dunkel).",
    abortTitle: "Assistent abgebrochen.",
    abortRestored: "Der Strip wurde auf den vorherigen Zustand zur\xFCckgesetzt.",
    abortRestart: "Du kannst den Assistenten jederzeit neu starten.",
    finishDone: "\u2713 FERTIG!",
    finishCount: "{count} Segmente erkannt.",
    finishGaps: "L\xFCcken-Liste: {list} \u2014 Manual-Mode aktiv.",
    finishNoGaps: "Keine L\xFCcken \u2014 Manual-Mode deaktiviert.",
    finishTreeRebuilt: "State-Tree wurde neu gebaut.",
    progressSegment: "Segment {idx}",
    progressCount: "{count} Segmente",
    logIdleTimeout: "Segment-Assistent f\xFCr {name}: Idle-Timeout (5 Min), abgebrochen",
    logAbortFailed: "Abbruch des Assistenten nach Timeout fehlgeschlagen: {msg}",
    logDetected: "Segment-Assistent f\xFCr {name}: {count} Segmente erkannt{gaps}",
    logGapsSuffix: ', L\xFCcken erkannt (manual_list="{list}")',
    logNoGapsSuffix: ", keine L\xFCcken"
  }
};
function format(template, params) {
  if (!params) {
    return template;
  }
  return template.replace(
    /\{(\w+)\}/g,
    (m, key) => key in params ? String(params[key]) : m
  );
}
const IDLE_TIMEOUT_MS = 5 * 6e4;
function wizardIdleText(lang) {
  return WIZARD_STRINGS[lang === "de" ? "de" : "en"].idle;
}
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
   * Look up a localized string, resolving against the host's current language.
   *
   * @param key Lookup key into WIZARD_STRINGS
   * @param params Optional placeholder values for `{name}` slots in the template
   */
  t(key, params) {
    var _a, _b;
    const lang = this.host.getLanguage() === "de" ? "de" : "en";
    const template = (_b = (_a = WIZARD_STRINGS[lang][key]) != null ? _a : WIZARD_STRINGS.en[key]) != null ? _b : key;
    return format(template, params);
  }
  /**
   * Human-readable status string for the admin UI (rendered via textSendTo).
   * Must stay a plain string — Admin renders it as-is into a read-only field.
   */
  getStatusText() {
    const s = this.session;
    if (!s) {
      return this.t("idle");
    }
    const visibleStr = s.visible.length > 0 ? s.visible.join(", ") : "\u2014";
    return `${this.t("deviceHeader")}: ${s.name}
${this.t("segmentFlashing", { idx: s.current })}
${this.t("canYouSeeStrip")}
  ${this.t("btnYes")}
  ${this.t("btnNo")}
  ${this.t("btnDone")}

${this.t("seenSoFar", { list: visibleStr })}`;
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
  async start(deviceKey) {
    if (this.session) {
      return {
        error: this.t("errAlreadyActive", { name: this.session.name })
      };
    }
    const device = this.host.findDevice(deviceKey);
    if (!device) {
      return { error: this.t("errDeviceNotFound", { key: deviceKey }) };
    }
    if (!hasSegmentCapability(device)) {
      return {
        error: this.t("errNoSegments", { name: device.name })
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
      message: `${this.t("wizardStartedFor", { name: device.name })}

${this.t("segmentFlashing", { idx: 0 })}
${this.t("canYouSeeStrip")}
${this.t("yesNoDoneLine")}`,
      progress: this.t("progressSegment", { idx: 0 }),
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
      return { error: this.t("errNoWizardShort") };
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
      return { error: this.t("errDeviceGone") };
    }
    await this.flashSegment(device, session.current);
    const lastNote = this.t(wasVisible ? "markedVisible" : "markedDark", {
      idx: answeredIdx
    });
    return {
      message: `${lastNote}

${this.t("segmentFlashing", { idx: session.current })}
${this.t("canYouSeeShort")}
${this.t("yesNoDoneLine")}`,
      progress: this.t("progressSegment", { idx: session.current }),
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
      return { error: this.t("errNoWizardShort") };
    }
    if (session.current === 0) {
      return { error: this.t("errAnswerFirst") };
    }
    return this.finish();
  }
  /** Abort the session and roll back to the captured baseline. */
  async abort() {
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
      message: `${this.t("abortTitle")}
${this.t("abortRestored")}
${this.t("abortRestart")}`,
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
    const allContiguous = visible.length === segmentCount && visible.every((v, i) => v === i);
    const manualList = allContiguous ? "" : compactIndices(visible);
    const result = {
      segmentCount,
      manualList,
      hasGaps: !allContiguous
    };
    await this.host.applyWizardResult(device, result);
    await this.restoreBaseline(device, session.baseline);
    const gapsSuffix = result.hasGaps ? this.t("logGapsSuffix", { list: manualList }) : this.t("logNoGapsSuffix");
    this.host.log.info(
      this.t("logDetected", {
        name: device.name,
        count: segmentCount,
        gaps: gapsSuffix
      })
    );
    this.session = null;
    this.clearIdleTimer();
    const summary = result.hasGaps ? this.t("finishGaps", { list: manualList }) : this.t("finishNoGaps");
    return {
      message: `${this.t("finishDone")}

${this.t("finishCount", { count: segmentCount })}
${summary}
${this.t("finishTreeRebuilt")}`,
      progress: this.t("progressCount", { count: segmentCount }),
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
      this.host.log.warn(this.t("logIdleTimeout", { name: this.session.name }));
      this.abort().catch((e) => {
        this.host.log.warn(
          this.t("logAbortFailed", {
            msg: e instanceof Error ? e.message : String(e)
          })
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
    const atomic = await this.host.flashSegmentAtomic(device, idx);
    if (atomic) {
      return;
    }
    const total = import_device_manager.SEGMENT_HARD_MAX + 1;
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
  wizardIdleText
});
//# sourceMappingURL=segment-wizard.js.map
