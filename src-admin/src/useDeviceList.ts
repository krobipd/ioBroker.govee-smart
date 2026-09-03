// The device list both halves of the Expert tab work from. Kept free of
// React/socket-client imports so it stays a pure, easily-testable factory: the
// only dependency is a `sendTo` method, injected via the socket seam.
//
// The response shape MUST stay in sync with the backend (`main.ts`
// getDeviceList / `message-router.ts`, `diagnostics` command, action "list").
// It is re-declared here because src-admin is an isolated package that cannot
// import from ../src.

/** One device as the backend offers it. */
export interface DeviceEntry {
  /** `sku:deviceId`, the key both the export and the wizard expect. */
  value: string;
  /** Human label, e.g. `Living room strip (H61BE)`. */
  label: string;
  /** Model, for the download's fallback file name. */
  model: string;
  /** Whether the device is currently reachable. */
  online: boolean;
  /** Segment count the adapter resolved — 0 for a device without segments. */
  segments: number;
}

/** Minimal socket seam — the admin socket's `sendTo(instance, command, data)`. */
export interface DeviceListSocket {
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

/**
 * Thrown when the device list could not be fetched.
 *
 * The distinction matters more than it looks: until 2.31.0 both hooks turned a
 * failed round-trip into an empty array, so the cards showed "no devices yet"
 * for an adapter running ten of them. That is what a dead message box looked
 * like from the outside on 2026-09-03, and it sent the search in the wrong
 * direction for an hour. An empty list and a broken call must never render the
 * same.
 */
export class DeviceListError extends Error {}

/** The one list operation the cards drive. */
export interface DeviceListApi {
  /**
   * Every real device the adapter knows, reachable or not.
   *
   * @throws {DeviceListError} When the adapter did not answer with a list
   */
  listDevices(): Promise<DeviceEntry[]>;
}

/**
 * Build a {@link DeviceListApi} bound to one admin socket + adapter namespace.
 *
 * Deliberately no caching: `online` is live state, and a list kept across a tab
 * switch would show a stale reachability. Re-fetching costs nothing — the
 * backend answers from the device list it already holds in memory.
 *
 * @param socket Admin socket exposing `sendTo`
 * @param namespace Adapter instance, e.g. "govee-smart.0"
 */
export function makeDeviceListApi(socket: DeviceListSocket, namespace: string): DeviceListApi {
  return {
    async listDevices(): Promise<DeviceEntry[]> {
      let res: unknown;
      try {
        res = await socket.sendTo(namespace, "diagnostics", { action: "list" });
      } catch (e) {
        throw new DeviceListError(e instanceof Error ? e.message : String(e));
      }
      const devices = (res as { devices?: unknown } | null | undefined)?.devices;
      if (!Array.isArray(devices)) {
        // No answer, or an answer that is not a list: the adapter is not
        // running, or its message box is not taking messages. Either way this
        // is a failure, not an empty account.
        throw new DeviceListError("The adapter did not answer with a device list");
      }
      return devices as DeviceEntry[];
    },
  };
}

/**
 * The devices the segment wizard can measure: reachable, and with segments.
 *
 * This filter used to live in the backend, which is why the wizard had a list
 * command of its own. It is a view on the shared list now — the backend still
 * refuses to start on an unreachable device, so this only decides what is
 * OFFERED, never what is allowed.
 *
 * @param devices The full device list
 */
export function segmentCapable(devices: DeviceEntry[]): DeviceEntry[] {
  return devices.filter(d => d.online && d.segments > 0);
}
