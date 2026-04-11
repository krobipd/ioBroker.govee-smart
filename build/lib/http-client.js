"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var http_client_exports = {};
__export(http_client_exports, {
  HttpError: () => HttpError,
  httpsRequest: () => httpsRequest
});
module.exports = __toCommonJS(http_client_exports);
var https = __toESM(require("node:https"));
function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    var _a;
    const u = new URL(options.url);
    const postData = options.body ? JSON.stringify(options.body) : void 0;
    const reqOptions = {
      method: options.method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        ...options.headers,
        ...postData ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        } : {}
      },
      timeout: (_a = options.timeout) != null ? _a : 15e3
    };
    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        var _a2;
        const raw = Buffer.concat(chunks).toString();
        const statusCode = (_a2 = res.statusCode) != null ? _a2 : 0;
        if (statusCode < 200 || statusCode >= 400) {
          reject(
            new HttpError(
              `HTTP ${statusCode}: ${raw.slice(0, 200)}`,
              statusCode,
              res.headers
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}
class HttpError extends Error {
  /** HTTP status code */
  statusCode;
  /** Response headers */
  headers;
  /**
   * @param message Error message
   * @param statusCode HTTP status code
   * @param headers Response headers
   */
  constructor(message, statusCode, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.headers = headers;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HttpError,
  httpsRequest
});
//# sourceMappingURL=http-client.js.map
