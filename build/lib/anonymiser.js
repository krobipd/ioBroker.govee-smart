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
var anonymiser_exports = {};
__export(anonymiser_exports, {
  Anonymiser: () => Anonymiser
});
module.exports = __toCommonJS(anonymiser_exports);
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi;
const EMAIL_RE = /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/gi;
const DEVICE_ID_RE = /\b(?:[0-9a-f]{2}:){5,7}[0-9a-f]{2}\b/gi;
function isPrivateIpv4(ip) {
  const p = ip.split(".").map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  if (p[0] === 10 || p[0] === 127) {
    return true;
  }
  if (p[0] === 192 && p[1] === 168) {
    return true;
  }
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) {
    return true;
  }
  return p[0] === 169 && p[1] === 254;
}
class Anonymiser {
  markers = /* @__PURE__ */ new Map();
  counters = /* @__PURE__ */ new Map();
  /**
   * The marker for one value in one category, minted on first sight.
   *
   * @param kind Marker prefix, e.g. `address` or `device`
   * @param value The real value to stand in for
   */
  marker(kind, value) {
    var _a;
    const key = `${kind}\0${value}`;
    const existing = this.markers.get(key);
    if (existing !== void 0) {
      return existing;
    }
    const next = ((_a = this.counters.get(kind)) != null ? _a : 0) + 1;
    this.counters.set(kind, next);
    const assigned = `${kind}-${next}`;
    this.markers.set(key, assigned);
    return assigned;
  }
  /**
   * Marker for an IP address. Private and link-local addresses are marked as
   * such, so "both devices are local" and "this one answered from the internet"
   * stay readable.
   *
   * @param ip The address as it appeared
   */
  ip(ip) {
    const scope = IPV4_RE.test(ip) || ip.includes(".") ? isPrivateIpv4(ip) ? "local" : "public" : "local";
    IPV4_RE.lastIndex = 0;
    return this.marker(`address-${scope}`, ip);
  }
  /**
   * A device id keeps its last four hex characters and loses the rest. Those
   * four are already the folder name in the object tree (`h61be_1d6f`), so the
   * report stays matchable against a user's screenshot without carrying the
   * full hardware id.
   *
   * @param id The device id as it appeared
   */
  deviceId(id) {
    const compact = id.replace(/:/g, "");
    const tail = compact.slice(-4).toLowerCase();
    return `id-\u2026${tail}`;
  }
  /**
   * Marker for a user-chosen device name. Names routinely carry a room or a
   * person ("Lisa's bedroom"), so they never travel — but the same name must
   * map to the same marker everywhere, or the report stops being followable.
   *
   * @param name The device name as the user set it
   */
  deviceName(name) {
    return this.marker("device", name);
  }
  /**
   * Replace every address, mail address and device id inside a free-text
   * string. Log lines and foreign error bodies are the places these hide.
   *
   * @param text Arbitrary text
   * @param names Device names to replace as well (they have no detectable shape)
   */
  text(text, names = []) {
    let out = text.replace(EMAIL_RE, (m) => this.marker("mail", m)).replace(IPV4_RE, (m) => this.ip(m)).replace(DEVICE_ID_RE, (m) => this.deviceId(m));
    out = out.replace(IPV6_RE, (m) => this.ip(m));
    for (const name of names) {
      if (name && name.length >= 3 && out.includes(name)) {
        out = out.split(name).join(this.deviceName(name));
      }
    }
    return out;
  }
  /**
   * Walk a already-cloned structure and pseudonymise every string in it, keys
   * included — a Govee response can key a map by device id.
   *
   * @param value Freshly cloned value, safe to mutate
   * @param names Device names to replace inside strings
   * @returns The value with every string pseudonymised
   */
  walk(value, names = []) {
    if (typeof value === "string") {
      return this.text(value, names);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.walk(v, names));
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[this.text(k, names)] = this.walk(v, names);
      }
      return out;
    }
    return value;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Anonymiser
});
//# sourceMappingURL=anonymiser.js.map
