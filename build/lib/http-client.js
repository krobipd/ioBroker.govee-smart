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
  extractHttpStatus: () => extractHttpStatus,
  formatFallback: () => formatFallback,
  httpsRequest: () => httpsRequest,
  interpretOkBody: () => interpretOkBody
});
module.exports = __toCommonJS(http_client_exports);
var https = __toESM(require("node:https"));
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const httpsTransport = { request: https.request, agent: keepAliveAgent };
function interpretOkBody(raw, statusCode) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: null, statusCode, fallback: "empty" };
  }
  if (trimmed.length < 100 && /^\d{3}\s+\S/.test(trimmed)) {
    return { value: null, statusCode, fallback: "plain-text-status", bodySnippet: trimmed };
  }
  try {
    return { value: JSON.parse(raw), statusCode };
  } catch (parseErr) {
    const snippet = raw.length > 100 ? `${raw.slice(0, 100)}\u2026` : raw;
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Invalid JSON in HTTP ${statusCode} response: ${detail} \u2014 body starts with: ${snippet}`);
  }
}
function httpsRequest(options, transport = httpsTransport) {
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
      timeout: (_a = options.timeout) != null ? _a : 15e3,
      agent: transport.agent
    };
    if (u.port) {
      reqOptions.port = u.port;
    }
    let onAbort = null;
    const cleanupAbort = () => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    };
    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      res.on("error", (err) => {
        cleanupAbort();
        reject(err);
      });
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        var _a2;
        cleanupAbort();
        const raw = Buffer.concat(chunks).toString();
        const statusCode = (_a2 = res.statusCode) != null ? _a2 : 0;
        if (statusCode < 200 || statusCode >= 400) {
          reject(new HttpError(`HTTP ${statusCode}`, statusCode, res.headers, raw));
          return;
        }
        try {
          resolve(interpretOkBody(raw, statusCode));
        } catch (parseErr) {
          reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
        }
      });
    });
    req.on("error", (err) => {
      cleanupAbort();
      reject(err);
    });
    req.on("timeout", () => {
      var _a2, _b;
      const ms = (_a2 = reqOptions.timeout) != null ? _a2 : 15e3;
      const method = (_b = options.method) != null ? _b : "GET";
      req.destroy(new Error(`Timeout after ${ms}ms for ${method} ${reqOptions.hostname}${reqOptions.path}`));
    });
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error("Aborted"));
        reject(new Error("Aborted"));
        return;
      }
      onAbort = () => {
        req.destroy(new Error("Aborted"));
        reject(new Error("Aborted"));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
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
   * Raw response body — NOT in `message` so tokens / API keys aren't leaked
   * via the warn log. Available only for targeted debug logging at the caller.
   */
  responseBody;
  /**
   * @param message Error message (Body-frei)
   * @param statusCode HTTP status code
   * @param headers Response headers
   * @param responseBody Raw response body (kann sensitive Echo-Daten enthalten)
   */
  constructor(message, statusCode, headers = {}, responseBody = "") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.headers = headers;
    this.responseBody = responseBody;
  }
}
function formatFallback(result) {
  return `${result.fallback} (status=${result.statusCode}${result.bodySnippet ? `, body=${JSON.stringify(result.bodySnippet)}` : ""}) \u2014 treated as no data`;
}
function extractHttpStatus(e) {
  if (e instanceof HttpError) {
    return e.statusCode;
  }
  if (typeof e === "object" && e !== null) {
    const x = e;
    if (typeof x.statusCode === "number") {
      return x.statusCode;
    }
    if (typeof x.status === "number") {
      return x.status;
    }
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HttpError,
  extractHttpStatus,
  formatFallback,
  httpsRequest,
  interpretOkBody
});
//# sourceMappingURL=http-client.js.map
