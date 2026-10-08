// Typed sendTo wrapper for the segment-wizard onMessage handlers. Kept free of
// React/socket-client imports so it stays a pure, easily-testable factory: the
// only dependency is a `sendTo` method, injected via the WizardSocket seam.
//
// The response shapes MUST stay in sync with the backend
// (src/lib/segment-wizard.ts WizardSnapshot / WizardResponse). They are
// re-declared here as plain types: src-admin CAN import from ../src (measured —
// `err-text` is shared that way), but the backend module carries imports the
// component must not drag into its bundle, so only an import-free module is shared.

/** Grid snapshot the backend folds into every wizard response. */
export interface WizardSnapshot {
  /** Where the measurement stands. */
  phase: "idle" | "measuring" | "review";
  /** How many segments the measurement runs over. */
  total: number;
  /** The segment lit right now. */
  currentIndex: number;
  /** The segments the user confirmed lit. */
  confirmed: number[];
}

/** One wizard-step response (superset — most fields are optional per action). */
export interface WizardResponse {
  /** The grid as it stands. */
  snapshot?: WizardSnapshot;
  /** A measurement is running. */
  active?: boolean;
  /** The measurement reached the protocol limit. */
  done?: boolean;
  /** The measurement was aborted. */
  aborted?: boolean;
  /** The result was applied to the device. */
  applied?: boolean;
  /** The segment count the result sets. */
  segmentCount?: number;
  /** The manual segment list the result sets, e.g. `0-9`. */
  list?: string;
  /** The confirmed segments leave gaps. */
  hasGaps?: boolean;
  /** Why the step failed. */
  error?: string;
}

/**
 * Minimal socket seam — the admin socket's `sendTo(instance, command, data)`
 * (verified against `@iobroker/socket-client` 5.x). Declared narrowly so tests
 * can inject a recording fake without the full Connection surface.
 */
export interface WizardSocket {
  /**
   * The admin socket's `sendTo`.
   *
   * @param instance the instance, e.g. `govee-smart.0`
   * @param command the message command
   * @param data the message
   */
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

/** The wizard operations the React component drives. The device list comes from {@link makeDeviceListApi}. */
export interface WizardApi {
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
