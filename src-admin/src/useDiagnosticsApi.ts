// Typed sendTo wrapper for the `diagnostics` onMessage handler. Kept free of
// React/socket-client imports so it stays a pure, easily-testable factory — the
// only dependency is a `sendTo` method, injected via the socket seam.
//
// The response shapes MUST stay in sync with the backend
// (src/lib/message-router.ts, `diagnostics` command). They are re-declared here
// because src-admin is an isolated package that cannot import from ../src.

/** One device offered by the picker. */
export interface DiagnosticsDevice {
  /** `sku:deviceId`, the key the export action expects. */
  value: string;
  /** Human label, e.g. `Living room strip (H61BE)`. */
  label: string;
  /** Model, for the download's fallback file name. */
  model: string;
}

/** A finished report: the file name it was stored under, plus its content. */
export interface DiagnosticsReport {
  fileName: string;
  content: string;
}

/** What the export action can answer. */
export type DiagnosticsExportResult = DiagnosticsReport | { error: string };

/** Minimal socket seam — mirrors the wizard's, so tests inject the same kind of fake. */
export interface DiagnosticsSocket {
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

/** The operations the diagnostics card drives. */
export interface DiagnosticsApi {
  /** Every real device, reachable or not. */
  listDevices(): Promise<DiagnosticsDevice[]>;
  /** Build the report for one device and get it back with its content. */
  exportReport(device: string): Promise<DiagnosticsExportResult>;
}

/**
 * Whether an export answer carries a report rather than an error.
 *
 * @param r The answer from the export action
 */
export function isReport(r: DiagnosticsExportResult): r is DiagnosticsReport {
  return typeof (r as DiagnosticsReport).fileName === "string";
}

/**
 * Build a {@link DiagnosticsApi} bound to one admin socket + adapter namespace.
 *
 * @param socket Admin socket exposing `sendTo`
 * @param namespace Instance namespace, e.g. `govee-smart.0`
 */
export function makeDiagnosticsApi(socket: DiagnosticsSocket, namespace: string): DiagnosticsApi {
  return {
    async listDevices(): Promise<DiagnosticsDevice[]> {
      const res = (await socket.sendTo(namespace, "diagnostics", { action: "list" })) as {
        devices?: DiagnosticsDevice[];
      };
      return Array.isArray(res?.devices) ? res.devices : [];
    },
    exportReport(device: string): Promise<DiagnosticsExportResult> {
      return socket.sendTo(namespace, "diagnostics", {
        action: "export",
        device,
      }) as Promise<DiagnosticsExportResult>;
    },
  };
}
