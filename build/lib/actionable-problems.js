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
var actionable_problems_exports = {};
__export(actionable_problems_exports, {
  ActionableProblems: () => ActionableProblems
});
module.exports = __toCommonJS(actionable_problems_exports);
class ActionableProblems {
  /**
   * @param host side-effect surface (logger + notification raiser)
   */
  constructor(host) {
    this.host = host;
  }
  host;
  active = /* @__PURE__ */ new Map();
  /**
   * Report an actionable problem. Surfaces it (warn + notification) when it is
   * NEW or when its message changed since last time (e.g. the verification
   * problem turning from "code needed" into "code rejected"). An identical
   * re-report of an already-active problem is a no-op — no spam.
   *
   * @param problem the problem to surface
   */
  report(problem) {
    const line = `${problem.title} \u2192 ${problem.action}`;
    const existing = this.active.get(problem.key);
    if (existing && `${existing.title} \u2192 ${existing.action}` === line) {
      return;
    }
    this.active.set(problem.key, problem);
    this.host.logWarn(line);
    this.host.notify(line);
  }
  /**
   * Mark a problem resolved. Logs a single resolution line if it was active.
   *
   * @param key the problem key to clear
   * @param resolutionMessage optional positive message; falls back to a default
   */
  resolve(key, resolutionMessage) {
    const problem = this.active.get(key);
    if (!problem) {
      return;
    }
    this.active.delete(key);
    this.host.logInfo(resolutionMessage != null ? resolutionMessage : `Resolved: ${problem.title}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ActionableProblems
});
//# sourceMappingURL=actionable-problems.js.map
