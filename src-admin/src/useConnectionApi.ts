// Typed sendTo wrapper for the `mqttAuth` onMessage handlers (login test +
// verification-code request). Kept free of React/socket-client imports so it
// stays a pure, easily-testable factory: the only dependency is a `sendTo`
// method, injected via the ConnectionSocket seam.
//
// The answer's shape is the backend's own (src/lib/auth-status.ts, import-free so the bundle can take it).

import type { AuthCreds, AuthResponse } from "../../src/lib/auth-status";

/**
 * Minimal socket seam — the admin socket's `sendTo(instance, command, data)`
 * (verified against `@iobroker/socket-client` 5.x). Declared narrowly so tests
 * can inject a recording fake without the full Connection surface.
 */
export interface ConnectionSocket {
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

/** The connection operations the React card drives. */
export interface ConnectionApi {
  /** Try a one-shot login with the given credentials; returns the case. */
  testLogin(creds: AuthCreds): Promise<AuthResponse>;
  /** Ask Govee to mail a fresh 2FA code for the given account. */
  requestCode(creds: AuthCreds): Promise<AuthResponse>;
}

/**
 * Build a {@link ConnectionApi} bound to one admin socket + adapter namespace.
 * Both operations reach the same `mqttAuth` handler with the live credentials
 * the user is editing, so a test needs no save first.
 *
 * @param socket    Admin socket exposing `sendTo`
 * @param namespace Adapter instance, e.g. "govee-smart.0"
 */
export function makeConnectionApi(socket: ConnectionSocket, namespace: string): ConnectionApi {
  const call = (action: string, creds: AuthCreds): Promise<AuthResponse> =>
    socket.sendTo(namespace, "mqttAuth", {
      action,
      email: creds.email,
      password: creds.password,
      code: creds.code,
    }) as Promise<AuthResponse>;

  return {
    testLogin: creds => call("test", creds),
    requestCode: creds => call("requestCode", creds),
  };
}
