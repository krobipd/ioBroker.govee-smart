// Typed sendTo wrapper for the `diagnostics` onMessage handler. Kept free of
// React/socket-client imports so it stays a pure, easily-testable factory — the
// only dependency is a `sendTo` method, injected via the socket seam.
//
// The response shapes MUST stay in sync with the backend
// (src/lib/message-router.ts, `diagnostics` command). They are re-declared here
// because src-admin is an isolated package that cannot import from ../src.

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

/** The operation the diagnostics card drives. The device list comes from {@link makeDeviceListApi}. */
export interface DiagnosticsApi {
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
    exportReport(device: string): Promise<DiagnosticsExportResult> {
      return socket.sendTo(namespace, "diagnostics", {
        action: "export",
        device,
      }) as Promise<DiagnosticsExportResult>;
    },
  };
}
