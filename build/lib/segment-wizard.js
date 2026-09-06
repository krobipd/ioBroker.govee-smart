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
  SegmentWizard: () => SegmentWizard
});
module.exports = __toCommonJS(segment_wizard_exports);
var import_lookups = require("./device-manager/lookups");
var import_timing_constants = require("./timing-constants");
var import_types = require("./types");
var import_device_baseline = require("./device-baseline");
var import_i18n = require("./i18n");
function format(template, params) {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (m, key) => key in params ? String(params[key]) : m);
}
function hasSegmentCapability(device) {
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  return caps.some((c) => c && typeof c.type === "string" && c.type.includes("segment_color_setting"));
}
class SegmentWizard {
  /** @param host Host interface wired up to the adapter. */
  constructor(host) {
    this.host = host;
  }
  host;
  session = null;
  timeoutHandle = void 0;
  /**
   * Snapshot the active session — used by the diag-export runtime-state
   * provider. Returns null when no session is in flight. Plain object so
   * the DiagnosticsCollector can clone-and-cap it safely.
   */
  getSessionSnapshot() {
    return this.session ? { ...this.session, visible: [...this.session.visible] } : null;
  }
  /**
   * Look up a localized wizard string (admin/i18n, resolved in the system
   * language via adapter-core I18n) and interpolate its `{name}` placeholders.
   *
   * @param key admin/i18n key
   * @param params Optional placeholder values for `{name}` slots in the template
   */
  t(key, params) {
    return format((0, import_i18n.resolveLabel)(key), params);
  }
  /**
   * Clear any pending idle-timer. Called from onUnload.
   *
   * If a wizard is still running on adapter stop the strip stays in its
   * white-flash state. UX trade-off — onUnload must be synchronous, so
   * restoreBaseline can't be awaited here. The user is already hinted at this
   * in the start log.
   */
  dispose() {
    var _a, _b;
    if (this.session) {
      const session = this.session;
      const device = this.host.findDevice(session.deviceKey);
      if (device) {
        try {
          const total = (_a = device.segmentCount) != null ? _a : 0;
          if (total > 0 && session.baseline.colorRgb && /^#[0-9a-fA-F]{6}$/.test(session.baseline.colorRgb)) {
            const color = parseInt(session.baseline.colorRgb.slice(1), 16);
            const brightness = (_b = session.baseline.brightness) != null ? _b : 100;
            void this.host.restoreStripAtomic(device, total, color, brightness).catch(() => void 0);
          }
        } catch {
        }
      }
      this.host.log.warn(
        "Segment wizard active during adapter stop \u2014 best-effort baseline restore sent. Run wizard 'done' or 'abort' next time for a clean finish."
      );
    }
    this.clearIdleTimer();
    this.session = null;
  }
  /**
   * Route one wizard step from the sendTo handler and fold the current grid
   * snapshot into every response so the React admin map can redraw per step.
   *
   * @param action "start" | "yes" | "no" | "apply" | "abort"
   * @param deviceKey Target device — only consulted on action="start"
   * @param payload Extra data for actions that need it (apply: corrected indices)
   * @param payload.indices Review-corrected segment indices for the `apply` action
   */
  async runStep(action, deviceKey, payload) {
    const response = await this.route(action, deviceKey, payload);
    return { ...response, snapshot: this.snapshot() };
  }
  /**
   * Dispatch a wizard action to its handler. The session-active guard covers
   * every action except `start` (which opens a session); `apply` shares that
   * guard with `yes`/`no`/`abort`.
   *
   * @param action Wizard action string
   * @param deviceKey Target device — only consulted on action="start"
   * @param payload Extra data (apply: corrected indices)
   * @param payload.indices Review-corrected segment indices for the `apply` action
   */
  async route(action, deviceKey, payload) {
    var _a;
    if (action === "start") {
      return this.start(deviceKey);
    }
    if (!this.session) {
      return { error: this.t("errNoWizard") };
    }
    if (action === "abort") {
      return this.abort();
    }
    if (action === "apply") {
      return this.apply((_a = payload == null ? void 0 : payload.indices) != null ? _a : []);
    }
    if (action === "yes" || action === "no") {
      return this.answer(action === "yes");
    }
    return { error: this.t("errUnknownAction", { action }) };
  }
  /**
   * Shape the current session into a {@link WizardSnapshot} for the React grid.
   * Maps the internal session fields (`current` → `currentIndex`, `visible` →
   * `confirmed`) and returns an idle snapshot when no session is in flight.
   */
  snapshot() {
    const s = this.session;
    if (!s) {
      return { phase: "idle", total: 0, currentIndex: 0, confirmed: [] };
    }
    return {
      phase: "measuring",
      total: s.total,
      currentIndex: s.current,
      confirmed: [...s.visible]
    };
  }
  /**
   * Begin a new wizard session. Captures baseline and flashes segment 0.
   *
   * @param deviceKey Target device key
   */
  async start(deviceKey) {
    var _a, _b;
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
    if (!(0, import_lookups.resolveDeviceReachability)(device).online) {
      return {
        error: this.t("errDeviceOffline", { name: device.name })
      };
    }
    const session = {
      deviceKey,
      sku: device.sku,
      name: device.name,
      current: 0,
      total: import_lookups.SEGMENT_COUNT_MAX,
      visible: [],
      startedAt: Date.now(),
      baseline: { segmentColors: [] }
    };
    this.session = session;
    session.baseline = await this.captureBaseline(device);
    if (this.session !== session) {
      return { error: this.t("errAlreadyActive", { name: (_b = (_a = this.session) == null ? void 0 : _a.name) != null ? _b : device.name }) };
    }
    this.scheduleIdleTimeout();
    await this.host.sendCommand(device, "power", true);
    await this.host.sendCommand(device, "brightness", 100);
    await this.flashSegment(device, 0);
    return { active: true };
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
    session.current += 1;
    this.scheduleIdleTimeout();
    if (session.current > import_lookups.SEGMENT_HARD_MAX) {
      return this.finish();
    }
    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: this.t("errDeviceGone") };
    }
    await this.flashSegment(device, session.current);
    return { active: true };
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
    return { done: true, aborted: true };
  }
  /**
   * Consolidate the session into a {@link WizardResult}, hand off to the host
   * for application, restore baseline and close the session. Reached only when
   * the protocol limit is hit mid-measurement — the React flow finalizes via
   * {@link apply} with its review-corrected map.
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
    await this.finalize(device, session, result);
    return { done: true, segmentCount, list: manualList, hasGaps: result.hasGaps };
  }
  /**
   * Finalize the review-corrected segment map. The React review screen may have
   * toggled cells before the user hit "Übernehmen"; the corrected indices arrive
   * here and run through the SAME finalization as {@link finish} (apply →
   * restore baseline → close session). Requires an active session — routed only
   * after the session-active guard in {@link route} — and a present device.
   *
   * @param indices Segment indices the user confirmed as lit (0-based, unsorted)
   */
  async apply(indices) {
    const session = this.session;
    if (!session) {
      return { error: this.t("errNoWizardShort") };
    }
    const clean = [...new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i <= import_lookups.SEGMENT_HARD_MAX))].sort(
      (a, b) => a - b
    );
    if (clean.length === 0) {
      return { error: this.t("errAnswerFirst") };
    }
    const device = this.host.findDevice(session.deviceKey);
    if (!device) {
      this.session = null;
      this.clearIdleTimer();
      return { error: this.t("errDeviceGoneShort") };
    }
    const segmentCount = clean[clean.length - 1] + 1;
    const hasGaps = clean.length < segmentCount;
    const manualList = hasGaps ? compactIndices(clean) : "";
    const result = { segmentCount, manualList, hasGaps };
    await this.finalize(device, session, result);
    return { applied: true, segmentCount, list: manualList, hasGaps };
  }
  /**
   * Apply a consolidated result to the device, restore the strip's baseline,
   * log the outcome and close the session. Shared side-effect path for
   * {@link finish} (measured indices) and {@link apply} (review-corrected
   * indices). Reads `session.baseline` before the session is nulled.
   *
   * @param device Target device
   * @param session The active session being finalized
   * @param result Consolidated wizard result to apply
   */
  async finalize(device, session, result) {
    await this.host.applyWizardResult(device, result);
    await this.restoreBaseline(device, session.baseline);
    const gapsSuffix = result.hasGaps ? `, gaps detected (manual_list="${result.manualList}")` : ", no gaps";
    this.host.log.info(
      `Segment wizard for ${(0, import_types.deviceLabel)(device)}: ${result.segmentCount} segments detected${gapsSuffix}`
    );
    this.session = null;
    this.clearIdleTimer();
  }
  /** (Re-)arm the 5-minute idle timeout that fires abort(). */
  scheduleIdleTimeout() {
    this.clearIdleTimer();
    this.timeoutHandle = this.host.setTimeout(() => {
      if (!this.session) {
        return;
      }
      this.host.log.warn(`Segment wizard for ${(0, import_types.deviceLabel)(this.session)}: idle timeout (5 min), aborted`);
      this.abort().catch((e) => {
        this.host.log.warn(
          this.t("logAbortFailed", {
            msg: e instanceof Error ? e.message : String(e)
          })
        );
        this.session = null;
      });
    }, import_timing_constants.WIZARD_IDLE_TIMEOUT_MS);
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
    const base = await (0, import_device_baseline.readDeviceBaseline)(this.host, device, { color: "#ffffff", brightness: 100 });
    return {
      power: base.power,
      brightness: base.brightness,
      colorRgb: base.colorRgb,
      segmentColors: base.segments.map((s, idx) => ({ idx, color: s.color, brightness: s.brightness }))
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
    const total = import_lookups.SEGMENT_COUNT_MAX;
    const others = Array.from({ length: total }, (_, i) => i).filter((i) => i !== idx);
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
    const total = (_a = device.segmentCount) != null ? _a : 0;
    const segs = baseline.segmentColors;
    const distinctTuples = new Set(segs.map((s) => `${s.color}:${s.brightness}`)).size;
    if (total > 0 && segs.length === total && distinctTuples >= 2) {
      await (0, import_device_baseline.restoreSegmentsGrouped)((d, cmd, val) => this.host.sendCommand(d, cmd, val), device, segs);
    } else if (baseline.colorRgb && /^#[0-9a-fA-F]{6}$/.test(baseline.colorRgb) && total > 0) {
      const color = parseInt(baseline.colorRgb.slice(1), 16);
      const brightness = (_b = baseline.brightness) != null ? _b : 100;
      const atomic = await this.host.restoreStripAtomic(device, total, color, brightness);
      if (!atomic) {
        await this.host.sendCommand(device, "segmentBatch", {
          segments: Array.from({ length: total }, (_, i) => i),
          color,
          brightness
        });
      }
    }
    if (baseline.power === false) {
      await this.host.sendCommand(device, "power", false);
    }
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
  SegmentWizard
});
//# sourceMappingURL=segment-wizard.js.map
