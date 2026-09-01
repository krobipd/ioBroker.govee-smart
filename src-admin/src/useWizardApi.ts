// Typed sendTo wrapper for the segment-wizard onMessage handlers. Kept free of
// React/socket-client imports so it stays a pure, easily-testable factory: the
// only dependency is a `sendTo` method, injected via the WizardSocket seam.
//
// The response shapes MUST stay in sync with the backend
// (src/lib/segment-wizard.ts WizardSnapshot / WizardResponse and
// src/lib/message-router.ts getSegmentDevices). They are re-declared here
// because src-admin is an isolated package that cannot import from ../src.

/** Grid snapshot the backend folds into every wizard response. */
export interface WizardSnapshot {
  phase: "idle" | "measuring" | "review";
  total: number;
  currentIndex: number;
  confirmed: number[];
}

/** One wizard-step response (superset — most fields are optional per action). */
export interface WizardResponse {
  snapshot?: WizardSnapshot;
  active?: boolean;
  done?: boolean;
  aborted?: boolean;
  applied?: boolean;
  segmentCount?: number;
  list?: string;
  hasGaps?: boolean;
  error?: string;
}

/** A segment-capable device offered by getSegmentDevices. */
export interface DeviceOption {
  value: string;
  label: string;
}

/**
 * Minimal socket seam — the admin socket's `sendTo(instance, command, data)`
 * (verified against `@iobroker/socket-client` 5.x). Declared narrowly so tests
 * can inject a recording fake without the full Connection surface.
 */
export interface WizardSocket {
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

/** The wizard operations the React component drives. */
export interface WizardApi {
  /** Segment-capable devices for the select screen. */
  listDevices(): Promise<DeviceOption[]>;
  /** Begin measuring `device` (also remembered for the following steps). */
  start(device: string): Promise<WizardResponse>;
  /** Current segment is lit. */
  yes(): Promise<WizardResponse>;
  /** Current segment is dark (a gap). */
  no(): Promise<WizardResponse>;
  /** Cancel and restore the strip. */
  abort(): Promise<WizardResponse>;
  /** Finalize with the review-corrected indices instead of the measured map. */
  apply(device: string, indices: number[]): Promise<WizardResponse>;
}

/**
 * Build a {@link WizardApi} bound to one admin socket + adapter namespace.
 * `start` records the device so the follow-up steps (yes/no/abort) carry it —
 * the backend only reads the device on `start`, but sending it keeps the
 * payload self-describing.
 *
 * @param socket    Admin socket exposing `sendTo`
 * @param namespace Adapter instance, e.g. "govee-smart.0"
 */
export function makeWizardApi(socket: WizardSocket, namespace: string): WizardApi {
  let currentDevice = "";

  const step = (action: string, device: string, indices?: number[]): Promise<WizardResponse> => {
    const data: { action: string; device: string; indices?: number[] } = { action, device };
    if (indices) {
      data.indices = indices;
    }
    return socket.sendTo(namespace, "segmentWizard", data) as Promise<WizardResponse>;
  };

  return {
    async listDevices() {
      const res = await socket.sendTo(namespace, "getSegmentDevices", {});
      return Array.isArray(res) ? (res as DeviceOption[]) : [];
    },
    start(device) {
      currentDevice = device;
      return step("start", device);
    },
    yes: () => step("yes", currentDevice),
    no: () => step("no", currentDevice),
    abort: () => step("abort", currentDevice),
    apply: (device, indices) => step("apply", device, indices),
  };
}
