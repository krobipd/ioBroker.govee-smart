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
const net = require("node:net");
const tls = require("node:tls");

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

// The Cloud-events client (mqtt.js over mqtts://) does not go through
// https.request — it opens a TLS socket of its own. With the fixture's API key
// it used to reach Govee's REAL broker on every inventory run and collect
// "Connection refused: Not authorized" there. mqtt.js reads `connect` from the
// tls module object at call time (`(0, tls_1.connect)(opts)`), so replacing it
// here is seen. Anything outside this machine is refused the way an unplugged
// network would refuse it — asynchronously, as ECONNREFUSED on the socket —
// so the client runs its ordinary NETWORK path (force-close, backoff) and
// never dials out.
const realTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  const opts = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  const host = String(opts.host || opts.hostname || opts.servername || "");
  if (host === "127.0.0.1" || host === "localhost") {
    return realTlsConnect.apply(tls, args);
  }
  process.stderr.write(`inventory fixture: refusing tls.connect to ${host}:${opts.port ?? "?"} — nothing leaves the machine\n`);
  const socket = new net.Socket();
  process.nextTick(() => {
    const err = new Error(`inventory fixture: connection to ${host} refused`);
    err.code = "ECONNREFUSED";
    socket.destroy(err);
  });
  return socket;
};
