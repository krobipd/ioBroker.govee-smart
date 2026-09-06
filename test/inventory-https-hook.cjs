"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (the harness passes
// `env` through to it). Runs before any adapter module, so replacing
// `https.request` here is seen by http-client.ts, which captures it once at
// module load into its default transport.
//
// Why a hook and not a config field: every Govee host is a hard-coded constant
// in the clients (openapi.api.govee.com, app2.govee.com). Giving the production
// code a test seam for the sake of the inventory would be a seam nothing else
// needs. The adapter knows neither the hook nor that it is in fixture mode.
//
// Every unknown host is REFUSED rather than let through: no call leaves the
// machine, and a route someone forgot to add surfaces as an error instead of
// silently reaching the real Govee.
const http = require("node:http");
const https = require("node:https");

const PORT = process.env.GOVEE_FIXTURE_PORT;
const ROUTED = new Set(["openapi.api.govee.com", "app2.govee.com", "itunes.apple.com"]);

https.request = function patchedRequest(options, callback) {
  const opts = typeof options === "string" ? { hostname: new URL(options).hostname } : { ...options };
  const host = String(opts.hostname || opts.host || "");
  if (!ROUTED.has(host)) {
    throw new Error(`inventory fixture: refusing un-routed request to ${host} — add a route or a fixture`);
  }
  opts.hostname = "127.0.0.1";
  opts.host = undefined;
  opts.port = Number(PORT);
  opts.protocol = "http:";
  // The production transport hands in an https.Agent with keep-alive; an
  // http.request would reject it outright.
  opts.agent = false;
  opts.headers = { ...(opts.headers || {}), host };
  return http.request(opts, callback);
};
