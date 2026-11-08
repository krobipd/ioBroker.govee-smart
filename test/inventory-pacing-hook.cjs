"use strict";
// test/inventory-pacing-hook.cjs (PACING_HOOKS): widens the adapter's declared limits as the adapter loads them — the
// adapter reads its pace only from src/lib/api-limits.json; the installations the limit tests judge run without this hook.
/**
 * One loader of node's internal table of file loaders — node's type declarations leave `_extensions` out.
 *
 * @callback FileLoader
 * @param {{ exports: { counterparts: { limits: { max: number }[] }[] } }} module the module being loaded
 * @param {string} filename the file it is loaded from
 * @returns {void}
 */
/** @typedef {{ _extensions: Record<string, FileLoader> }} ModuleLoaders */
const Module = /** @type {ModuleLoaders} */ (/** @type {unknown} */ (require("node:module")));
const path = require("node:path");
const LIMITS = path.join("src", "lib", "api-limits.json");
const load = Module._extensions[".json"];
Module._extensions[".json"] = function (module, filename) {
  load(module, filename);
  if (filename.endsWith(LIMITS)) {
    for (const counterpart of module.exports.counterparts) {
      for (const limit of counterpart.limits) {
        limit.max *= 1000;
      }
    }
  }
};
